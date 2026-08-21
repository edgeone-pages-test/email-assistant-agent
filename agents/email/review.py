"""POST /email/review — HITL resume entry point.

Receives the user's decision on the currently-paused draft and resumes the
LangGraph via ``Command(resume=value)``. Same SSE contract as ``run.py``:

  - first frame: ``session`` (with ``resumed: true``)
  - per-node frames: ``state_update``
  - if the NEXT email also needs review → another ``human_review_required``
    + ``[PAUSED]`` (and the loop repeats from the client)
  - terminal: ``done`` + ``[DONE]``

The thread_id comes from ``context.conversation_id`` — the platform routes
requests with the same X-Conversation-Id (or session cookie) to the same
conversation, so the checkpointer rehydrates the paused state from when
``run.py`` (or an earlier ``review.py``) closed the connection.

Request body:

    {
        "decision": "approve" | "edit" | "reject" | "regenerate" | "skip",
        "edited_body": "..." | null,    # required when decision = "edit"
        "feedback": "..." | null         # optional, used by "regenerate"
    }
"""
from __future__ import annotations

import sys
from pathlib import Path

CURRENT = Path(__file__).resolve().parent
if str(CURRENT) not in sys.path:
    sys.path.insert(0, str(CURRENT))

from langgraph.types import Command  # noqa: E402

from _graph import get_graph  # noqa: E402
from _i18n import normalize_locale, tr  # noqa: E402
from _llm import DEFAULT_MODEL, get_crewai_llm, get_env, get_openai_client  # noqa: E402
from _providers import get_provider  # noqa: E402
from _sse_utils import to_jsonable  # noqa: E402
from run import _utils_or_fallback, draft_preview, save_message  # noqa: E402


VALID_ACTIONS = {"approve", "edit", "reject", "regenerate", "skip"}


# Decision id → i18n key for the friendly label of the user-message stored
# in chat history.
_DECISION_LABEL_KEY = {
    "approve": "review_approve",
    "edit": "review_edit",
    "reject": "review_reject",
    "regenerate": "review_regenerate",
    "skip": "review_skip",
}


def _validate_body(body: dict) -> tuple[str, str | None, str | None] | dict:
    """Validate the request body. Returns ``(action, edited_body, feedback)``
    on success, or a ``{"status_code", "body"}`` dict on validation failure.
    """
    action = str(body.get("decision") or "").strip().lower()
    if action not in VALID_ACTIONS:
        return {
            "status_code": 400,
            "body": {
                "error": f"decision must be one of {sorted(VALID_ACTIONS)}",
                "got": body.get("decision"),
            },
        }
    edited_body = body.get("edited_body")
    feedback = body.get("feedback")
    if action == "edit":
        if not edited_body or not isinstance(edited_body, str) or not edited_body.strip():
            return {
                "status_code": 400,
                "body": {"error": "decision=edit requires non-empty edited_body"},
            }
    return action, edited_body, feedback


async def handler(context):
    body = (getattr(getattr(context, "request", None), "body", None) or {})
    if not isinstance(body, dict):
        body = {}

    validated = _validate_body(body)
    if isinstance(validated, dict):
        # Validation error
        return validated
    action, edited_body, feedback = validated
    # UI locale for the history labels / draft previews written below. The
    # LangGraph state itself keeps the locale from the original run.py call
    # (checkpointed), so resumed nodes narrate in the same language.
    locale = normalize_locale(body.get("locale"))

    # Bootstrap the same dependencies run.py uses — graph topology MUST match
    # because we're resuming from the checkpoint produced by run.py.
    try:
        env = get_env(getattr(context, "env", None))
        llm = get_crewai_llm(env)
        openai_client = get_openai_client(env)
    except Exception as exc:
        return {"status_code": 500, "body": {"error": str(exc)}}

    try:
        provider = get_provider(
            getattr(context, "env", None) or {},
            getattr(context, "kv", None),
        )
    except Exception as exc:
        return {"status_code": 500, "body": {"error": f"provider init failed: {exc}"}}

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

    resume_value: dict = {"action": action}
    if edited_body is not None:
        resume_value["edited_body"] = edited_body
    if feedback is not None:
        resume_value["feedback"] = feedback

    async def gen():
        # Persist the user's decision into chat history before we kick off
        # the resume — this way even if the resume errors out, the history
        # tab still shows what the user picked.
        decision_key = _DECISION_LABEL_KEY.get(action)
        decision_text = tr(locale, decision_key) if decision_key else action
        if feedback:
            decision_text = f"{decision_text}: {feedback}"
        elif edited_body:
            # Hint that there's a custom body without dumping the whole
            # email into the chat label (which would be noisy in the sidebar).
            decision_text = f"{decision_text} {tr(locale, 'review_edited_body')}"
        await save_message(
            context,
            role="user",
            content=decision_text,
            metadata={"kind": "decision", "action": action},
        )

        # Echo the resume so the frontend can correlate with its UI state
        yield utils.sse(
            {
                "type": "session",
                "conversationId": conversation_id,
                "resumed": True,
                "decision": action,
            },
            event="session",
        )

        try:
            # Multi-mode (updates + custom): see run.py's matching block for
            # the full rationale. After Command(resume=...), the graph
            # continues from the review node; the upcoming draft / apply /
            # summarize nodes will publish progress narration through the
            # same writer pipeline so the user keeps getting feedback after
            # they submit a decision.
            async for mode, payload in app.astream(
                Command(resume=resume_value),
                config=config,
                stream_mode=["updates", "custom"],
            ):
                if cancel_signal is not None and getattr(cancel_signal, "is_set", lambda: False)():
                    yield utils.sse("[CANCELLED]", event="cancelled")
                    return

                if mode == "custom":
                    yield utils.sse(to_jsonable(payload), event="progress")
                    continue

                if "__interrupt__" in payload:
                    # Next email in the loop ALSO needs human review
                    interrupts = payload["__interrupt__"]
                    interrupt_payload = (
                        getattr(interrupts[0], "value", interrupts[0])
                        if interrupts
                        else {"type": "interrupt"}
                    )
                    payload_dict = to_jsonable(interrupt_payload)
                    # Store the next draft as a chat-history entry too
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

        # All done — last interrupt was the final one
        try:
            snap = await app.aget_state(config)
            summary = (snap.values or {}).get("summary", "")
        except Exception:
            summary = ""

        if summary:
            await save_message(
                context,
                role="assistant",
                content=summary,
                metadata={"kind": "summary"},
            )

        yield utils.sse({"summary": summary}, event="done")
        yield utils.sse("[DONE]", event="end")

    return utils.stream_sse(gen())
