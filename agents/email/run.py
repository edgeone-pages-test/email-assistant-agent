"""POST /email/run — main entry for the email-assistant template.

Streams SSE frames so the frontend can render node-level progress in real
time. Skeleton mirrors the marketing template's ``plan.py``:

  - first frame: session id (so the client can later POST /email/stop)
  - per-node frames: ``state_update`` events with the partial state diff
  - on interrupt (Week 2+): ``human_review_required`` + ``[PAUSED]`` and exit
  - terminal: ``done`` with summary, then ``[DONE]``

Conversation history: this handler also writes coarse-grained chat messages
to ``ctx.store`` (via the helpers below) so ``history.py`` can list / replay
past sessions in the left sidebar. SSE-level frames (per-node state_update)
are NOT persisted — they're a pipeline visualization, not chat content.
"""
from __future__ import annotations

import sys
from pathlib import Path

CURRENT = Path(__file__).resolve().parent
if str(CURRENT) not in sys.path:
    sys.path.insert(0, str(CURRENT))

from _graph import get_graph  # noqa: E402
from _i18n import LANGUAGE_NAME, normalize_locale, tr  # noqa: E402
from _llm import DEFAULT_MODEL, get_crewai_llm, get_env, get_openai_client  # noqa: E402
from _providers import get_provider  # noqa: E402
from _sse_utils import to_jsonable  # noqa: E402


# ─── Conversation-history helpers ───────────────────────────────────────────
#
# These are the ONLY places we write to ``ctx.store.append_message``. We
# centralize them here so review.py can re-use them without duplication.
# Failures are swallowed (best-effort) — never break the SSE stream over a
# history-write hiccup.


_TASK_LABEL = {
    "triage_only": "task_triage_only",
    "daily_digest": "task_daily_digest",
    "single_reply": "task_single_reply",
}


async def save_message(context, role: str, content: str, metadata: dict | None = None):
    """Append a message to the platform's conversation memory.

    All writes are best-effort. ``store.append_message`` is provided by the
    EdgeOne Makers runtime; on local dev or when context.store is missing
    (e.g. early init failures), this no-ops.
    """
    store = getattr(context, "store", None)
    if store is None or not hasattr(store, "append_message"):
        return
    cid = getattr(context, "conversation_id", None) or "local"
    try:
        await store.append_message(
            conversation_id=cid,
            role=role,
            content=content,
            metadata=metadata or {},
        )
    except Exception:
        # Persistence failure shouldn't propagate — a missed history row is
        # less bad than a broken SSE stream.
        pass


def task_label(task: str, locale: str = "zh") -> str:
    """Friendly label for a task id (used as the conversation title)."""
    return tr(locale, _TASK_LABEL.get(task, task))


async def _maybe_set_title_first_run(context, cid: str, title: str) -> None:
    """Persist a title onto the conversation's ``metadata`` so ``history.py``
    can render the sidebar list WITHOUT extra ``get_messages`` round-trips.

    Strategy — set title only when the conversation has none yet:
      - title already exists  → never overwrite (first task wins)
      - no title (legacy or new) → write through

    Lookup: scan ``list_conversations(limit=20, order="desc")`` for the cid.
    Called BEFORE the first ``save_message`` of this run, so a recently-used
    conversation will reliably appear in the top-N. The remaining edge of
    "conversation_id reused after >24h, falls outside top-20, AND has a
    title" silently overwriting is documented as accepted for this single-
    tenant template — when the platform exposes a per-id read API we'll
    switch to an exact existence check.

    Best-effort: any platform error is swallowed; ``history.py``'s legacy
    path (derive title from messages) covers any miss.
    """
    store = getattr(context, "store", None)
    if store is None or not hasattr(store, "list_conversations"):
        return
    try:
        result = await store.list_conversations(limit=20, order="desc")
        for m in getattr(result, "items", []) or []:
            if m.conversation_id == cid:
                if (m.metadata or {}).get("title"):
                    return  # already titled — first task wins
                break
        await store.update_conversation(
            conversation_id=cid,
            metadata={"title": title},
        )
    except Exception:
        # Title is a UX nicety; never break the run over a metadata write.
        pass


def draft_preview(draft_payload: dict, locale: str = "zh") -> str:
    """Format a HITL draft as a multi-line preview suitable for chat history.

    The full draft body can be hundreds of chars; we cap at ~600 to keep the
    history tab snappy and the title-derivation in ``history.py`` cheap.
    """
    subject = draft_payload.get("subject") or tr(locale, "no_subject")
    body = (draft_payload.get("body") or "").strip()
    if len(body) > 600:
        body = body[:600] + "…"
    return tr(locale, "draft_preview_prefix", subject=subject) + f"\n\n{body}"


def _utils_or_fallback(context):
    """Use ``ctx.utils`` when on-platform; otherwise minimal fallback for local runs."""
    utils = getattr(context, "utils", None)
    if utils is not None:
        return utils
    import json

    class _Fallback:
        @staticmethod
        def sse(data, *, event=None, id=None, retry=None):  # noqa: A002
            text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
            prefix = f"event: {event}\n" if event else ""
            return f"{prefix}data: {text}\n\n"

        @staticmethod
        def stream_sse(gen, **_kwargs):
            return gen

    return _Fallback()


async def handler(context):
    body = (getattr(getattr(context, "request", None), "body", None) or {})
    if not isinstance(body, dict):
        body = {}

    task = body.get("task") or "daily_digest"
    auto_approve = bool(body.get("auto_approve"))
    locale = normalize_locale(body.get("locale"))

    try:
        env = get_env(getattr(context, "env", None))
        llm = get_crewai_llm(env)
        openai_client = get_openai_client(env)
    except Exception as exc:
        return {"status_code": 500, "body": {"error": str(exc)}}

    try:
        provider = get_provider(getattr(context, "env", None) or {}, getattr(context, "kv", None))
        rules_bundle = await provider.load_user_rules()
    except Exception as exc:
        return {"status_code": 500, "body": {"error": f"provider init failed: {exc}"}}

    # The UI locale wins over the fixture / KV-stored language rule so that
    # reply drafts and the final digest always match what the user is
    # looking at ("Reply in English" when the UI is English).
    rules_bundle.language = LANGUAGE_NAME[locale]

    try:
        checkpointer = context.store.langgraph_checkpointer
    except Exception as exc:
        return {"status_code": 500, "body": {"error": f"checkpointer unavailable: {exc}"}}

    app = get_graph(
        checkpointer=checkpointer,
        provider=provider,
        llm=llm,
        openai_client=openai_client,
        model=DEFAULT_MODEL,
    )

    utils = _utils_or_fallback(context)
    cancel_signal = getattr(getattr(context, "request", None), "signal", None)
    conversation_id = getattr(context, "conversation_id", None) or "local"
    config = {"configurable": {"thread_id": conversation_id}}

    initial_state = {
        "task": task,
        "user_rules": rules_bundle.to_rules(),
        "auto_approve": auto_approve,
        "locale": locale,
    }

    # ``single_reply`` mode: caller pinpoints the email by id, the prioritize
    # node filters down to the one match. Ignored for other tasks. We don't
    # validate id presence here — if it doesn't match anything in the inbox,
    # prioritize returns [] and the graph routes to summarize gracefully.
    target_id = body.get("target_email_id")
    if isinstance(target_id, str) and target_id:
        initial_state["target_email_id"] = target_id

    # ``skip_email_ids`` (daily_digest only): emails the user already handled
    # via earlier single_reply clicks. Filtered out in prioritize before the
    # draft loop, so daily_digest "picks up where you left off".
    skip_ids = body.get("skip_email_ids")
    if isinstance(skip_ids, list) and skip_ids:
        initial_state["skip_email_ids"] = [str(s) for s in skip_ids if s]

    # Optional: caller may pre-load a previously-fetched + classified inbox
    # to skip fetch + classify on this run. Used by the frontend to make
    # task-switching cheap (e.g. triage_only → daily_digest doesn't have to
    # pay for IMAP fetch and 10× LLM classify calls again). The fetch /
    # classify nodes look at ``state["classified"]`` and short-circuit when
    # it's non-empty. Frontend sends this whenever it has a cached snapshot
    # AND the user did NOT click "force refresh".
    #
    # Force-refresh path: when the user clicks "重新拉取邮件" the frontend sends
    # ``force_refresh: true`` instead of a preloaded payload. We MUST then
    # explicitly clear the inbox-related state fields, otherwise LangGraph's
    # checkpointer happily preserves the stale ``classified`` from the prior
    # run (since reducers don't replace fields that aren't in initial_state)
    # and fetch's short-circuit kicks in → user sees the same emails despite
    # asking for a refresh. Annotated fields (review_decisions / drafts /
    # final_actions) are append-only history; we keep those intact.
    if bool(body.get("force_refresh")):
        initial_state["classified"] = []
        initial_state["inbox"] = []
        initial_state["prioritized"] = []
        initial_state["cursor"] = 0
    else:
        preloaded = body.get("preloaded_classified")
        if isinstance(preloaded, list) and preloaded:
            try:
                from _models import ClassifiedEmail
                parsed = [ClassifiedEmail.model_validate(item) for item in preloaded]
                initial_state["classified"] = parsed
            except Exception:
                # Bad payload — ignore and fetch fresh. Don't fail the whole
                # run over an optional cache hint.
                pass

    async def gen():
        # First chat-history breadcrumb of this run. ``history.py`` uses the
        # first user message as the conversation title — these labels become
        # the sidebar entries the user will see ("仅分类邮件" / "处理待回邮件" /
        # "单独处理某封邮件"). Best-effort; any failure is swallowed.
        #
        # IMPORTANT — call order matters: ``save_message`` MUST run BEFORE
        # ``_maybe_set_title_first_run``. The platform's ``append_message``
        # lazily creates the conversation meta on first write; without it,
        # ``update_conversation`` (used inside the title helper) raises
        # ``MemoryNotFoundError`` and the title silently never lands. Get
        # the meta created first, then patch ``metadata.title`` on top.
        await save_message(
            context,
            role="user",
            content=f"[task] {task_label(task, locale)}",
            metadata={"task": task, "kind": "task_start"},
        )
        # Title shortcut: write to ``metadata.title`` so the cross-device
        # restore path (frontend "从云端恢复" button) sees the proper label
        # without scanning messages. ``_maybe_set_title_first_run`` only
        # writes when title is absent — first task wins on a multi-task
        # session sharing the same conversation_id.
        await _maybe_set_title_first_run(
            context,
            conversation_id,
            f"[task] {task_label(task, locale)}",
        )

        # First frame: session id, used by the client to later POST /email/stop
        yield utils.sse(
            {"type": "session", "conversationId": conversation_id, "task": task},
            event="session",
        )

        try:
            # ``stream_mode=["updates", "custom"]`` gives us BOTH the per-node
            # state diffs (updates) AND the user-visible narration each node
            # publishes via ``get_stream_writer()``. Multi-mode astream yields
            # ``(mode, payload)`` tuples instead of bare payloads — single-mode
            # streams used to yield ``payload`` directly, so the iteration
            # destructures into ``mode, payload`` here.
            async for mode, payload in app.astream(
                initial_state,
                config=config,
                stream_mode=["updates", "custom"],
            ):
                if cancel_signal is not None and getattr(cancel_signal, "is_set", lambda: False)():
                    yield utils.sse("[CANCELLED]", event="cancelled")
                    return

                # Custom-mode: a node called ``writer({...})``. Forward as a
                # ``progress`` SSE event — the frontend renders these as a
                # live chip + transient timeline message so users see WHAT
                # the backend is doing during long operations (classify is
                # ~10s, draft is ~20-30s — those used to be silent).
                if mode == "custom":
                    yield utils.sse(to_jsonable(payload), event="progress")
                    continue

                # Updates mode below — node finished, emit state_update or
                # the human_review_required interrupt payload.

                # Interrupt support (Week 2+) — payload returned to the
                # human-review SSE channel; client POSTs /email/review with
                # the same conversation_id to resume.
                if "__interrupt__" in payload:
                    interrupts = payload["__interrupt__"]
                    interrupt_payload = (
                        getattr(interrupts[0], "value", interrupts[0])
                        if interrupts
                        else {"type": "interrupt"}
                    )
                    payload_dict = to_jsonable(interrupt_payload)
                    # Persist a chat-friendly draft preview for the history sidebar
                    if isinstance(payload_dict, dict):
                        draft = payload_dict.get("draft")
                        if isinstance(draft, dict):
                            await save_message(
                                context,
                                role="assistant",
                                content=draft_preview(draft, locale),
                                metadata={
                                    "kind": "draft_for_review",
                                    "email_id": draft.get("email_id"),
                                },
                            )
                    yield utils.sse(payload_dict, event="human_review_required")
                    yield utils.sse("[PAUSED]", event="paused")
                    return

                yield utils.sse(to_jsonable(payload), event="state_update")
        except Exception as exc:
            yield utils.sse({"error": str(exc)}, event="error_message")
            yield utils.sse("[DONE]", event="end")
            return

        # Final state lookup for the summary
        try:
            snap = await app.aget_state(config)
            summary = (snap.values or {}).get("summary", "")
        except Exception:
            summary = ""

        # Persist the final summary as the closing assistant message.
        if summary:
            await save_message(
                context,
                role="assistant",
                content=summary,
                metadata={"kind": "summary", "task": task},
            )

        yield utils.sse({"summary": summary}, event="done")
        yield utils.sse("[DONE]", event="end")

    return utils.stream_sse(gen())


# ─── Local sanity check (no platform context needed) ────────────────────────


if __name__ == "__main__":
    import asyncio
    import os

    class _Req:
        def __init__(self, body):
            self.body = body
            self.signal = None

    class _Ctx:
        def __init__(self, body):
            self.request = _Req(body)
            self.env = {
                "AI_GATEWAY_API_KEY": os.environ.get("AI_GATEWAY_API_KEY", ""),
                "AI_GATEWAY_BASE_URL": os.environ.get("AI_GATEWAY_BASE_URL", ""),
                "EMAIL_PROVIDER": "mock",
            }
            self.conversation_id = "local-cli"
            self.kv = None
            # In-memory store substitute for local testing
            from langgraph.checkpoint.memory import InMemorySaver

            class _S:
                langgraph_checkpointer = InMemorySaver()

            self.store = _S()

    async def _main():
        ctx = _Ctx({"task": "triage_only", "auto_approve": True})
        result = await handler(ctx)
        if isinstance(result, dict):
            import json
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return
        async for frame in result:
            print(frame, end="")

    asyncio.run(_main())
