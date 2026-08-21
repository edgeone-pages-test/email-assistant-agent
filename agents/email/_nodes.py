"""LangGraph nodes for the email-assistant template.

Each node is ``async def name(state) -> dict`` (a partial state update).
Nodes that need runtime dependencies (provider, openai_client) are wired
in ``_graph.build_graph`` via ``functools.partial`` — no module-level
globals, so multiple Crews / providers can coexist in the same process.

Pipeline (see ``_graph.py``):

    fetch → classify → prioritize → [draft → review → apply]* → summarize

The bracketed group is the per-email loop driven by ``cursor`` and the
``after_review`` / ``next_or_done`` conditional edges.

Day 3 covers the first three (offline-friendly) nodes. Day 4 lands
``draft_with_crew``; Day 5 lands ``apply``, ``summarize``, plus an
auto-approve ``review`` stub. Week 2 D1 promotes ``review`` to a true
HITL pause via ``langgraph.types.interrupt``.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from _i18n import LANGUAGE_NAME, tr
from _models import (
    Action,
    ClassifiedEmail,
    DraftItem,
    Email,
    EmailCategory,
    ReviewDecision,
    UserRule,
    UserRulesBundle,
)
from _state import EmailAssistantState


# Allowed categories — keep in sync with _models.EmailCategory.
CATEGORIES: tuple[EmailCategory, ...] = (
    "urgent_customer", "meeting", "internal", "marketing",
    "notification", "followup", "spam", "billing", "other",
)


# ─── Progress-stream helper ─────────────────────────────────────────────────
#
# All nodes report user-visible status via LangGraph's custom-stream channel
# (``stream_mode="custom"`` in run.py / review.py). The writer is captured
# from ``langgraph.config.get_stream_writer()``; calling the returned
# callable with a dict surfaces it to the SSE generator as a ``progress``
# event. We wrap the import + None-fallback so unit tests that don't go
# through astream don't crash on a missing context.


def _writer():
    """Return the LangGraph custom-stream writer if available, else a no-op.

    The writer is contextvar-bound — calling it OUTSIDE a graph node (e.g. in
    a unit test that imports a node directly) would raise. We swallow that
    so node functions stay testable in isolation; the cost is silent loss of
    progress narration in those test paths, which is fine.
    """
    try:
        from langgraph.config import get_stream_writer  # noqa: WPS433 — local import
        return get_stream_writer()
    except Exception:
        return lambda _payload: None


# ─── User-rule helpers ──────────────────────────────────────────────────────


def _bundle_from_rules(rules: list[UserRule]) -> UserRulesBundle:
    """Materialize a structured bundle from the flat ``UserRule`` list."""
    bundle = UserRulesBundle()
    for r in rules:
        if r.kind == "vip_domain":
            bundle.vip_domains.append(r.value)
        elif r.kind == "auto_archive":
            bundle.auto_archive.append(r.value)
        elif r.kind == "default_tone":
            bundle.default_tone = r.value  # type: ignore[assignment]
        elif r.kind == "signature":
            bundle.signature = r.value
        elif r.kind == "language":
            bundle.language = r.value
    return bundle


def _matches_auto_archive(email: Email, patterns: list[str]) -> bool:
    """True iff the sender address contains any of the auto-archive patterns."""
    sender_lower = email.sender.lower()
    for pat in patterns:
        if pat and pat.lower() in sender_lower:
            return True
    return False


def _matches_vip_domain(email: Email, vip_domains: list[str]) -> bool:
    """True iff the sender domain matches any of the VIP domains."""
    sender_lower = email.sender.lower()
    for d in vip_domains:
        if d and d.lower() in sender_lower:
            return True
    return False


# ─── fetch ───────────────────────────────────────────────────────────────────


async def fetch(
    state: EmailAssistantState,
    *,
    provider,
    lookback_hours: int = 72,
) -> dict:
    """Pull the inbox snapshot from the provider.

    Honors ``user_rules.auto_archive`` pre-LLM: emails from those senders /
    domains are archived (no LLM tokens spent classifying them).

    Short-circuit: if the caller pre-loaded ``classified`` (e.g. the
    frontend reused a previous run's snapshot via ``preloaded_classified``),
    skip the network round-trip entirely. We rebuild ``inbox`` from the
    classified entries so downstream nodes that count inbox size (e.g.
    ``summarize``) still get a correct value.
    """
    write = _writer()
    locale = state.get("locale", "zh")
    pre = state.get("classified") or []
    if pre:
        # ``_cached`` is a transient signal for the SSE stream — the frontend
        # uses it to render a "缓存" chip on the fetch node so users know we
        # didn't actually hit the network. It lands in state too (TypedDict
        # is permissive at runtime) but no other node reads it.
        write({
            "phase": "fetch",
            "stage": "skipped",
            "message": tr(locale, "fetch_cached", n=len(pre)),
        })
        return {"inbox": [c.email for c in pre], "_cached": True}

    write({"phase": "fetch", "stage": "started", "message": tr(locale, "fetch_started")})

    rules = _bundle_from_rules(state.get("user_rules") or [])
    since = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)
    raw_inbox = await provider.fetch_inbox(since=since, limit=30)

    kept: list[Email] = []
    archived = 0
    for email in raw_inbox:
        if _matches_auto_archive(email, rules.auto_archive):
            try:
                await provider.archive(email.id)
                archived += 1
            except Exception:
                # Archive failure shouldn't crash triage — log to errors
                pass
            continue
        kept.append(email)

    write({
        "phase": "fetch",
        "stage": "completed",
        "message": (
            tr(locale, "fetch_done", n=len(kept))
            + (tr(locale, "fetch_archived", n=archived) if archived else "")
        ),
    })
    return {"inbox": kept}


# ─── classify ────────────────────────────────────────────────────────────────


CLASSIFY_SYSTEM = """You are an email triage specialist. Classify a batch of inbound emails.

For EACH email return:
- category: one of urgent_customer | meeting | internal | marketing | notification | followup | spam | billing | other
- needs_reply: boolean — true iff this email requires a personal reply within 24h
- priority: integer 0-100 (higher = more urgent)
- reason: ONE sentence explaining your call (max 30 words)

Priority guidance:
- 80-100: customer outage, security, VIP urgent question
- 60-79: meeting needing prompt RSVP, important external follow-up
- 40-59: typical internal asks, FYI worth reading
- 20-39: automated notifications, low-priority FYI
-  0-19: marketing, billing reminders on autopay, spam

Output: a JSON object with key "results" whose value is an ARRAY in the SAME ORDER as input.
Each item: {"id": "<email-id>", "category": "...", "needs_reply": true|false, "priority": 50, "reason": "..."}
NO markdown fences. NO prose around the JSON."""


def _compact_inbox_for_llm(inbox: list[Email]) -> str:
    """Trim each email to a small JSON for token efficiency."""
    compact = [
        {
            "id": e.id,
            "from": e.sender,
            "subject": e.subject,
            "snippet": (e.body_text or "")[:600],
            "has_ics": e.has_ics,
        }
        for e in inbox
    ]
    return json.dumps(compact, ensure_ascii=False)


def _coerce_classification(items: Any, by_id: dict[str, Email]) -> list[ClassifiedEmail]:
    """Validate / clamp LLM output into ``ClassifiedEmail`` instances."""
    if not isinstance(items, list):
        return []
    out: list[ClassifiedEmail] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        eid = item.get("id")
        email = by_id.get(eid)
        if not email:
            continue
        cat = item.get("category", "other")
        if cat not in CATEGORIES:
            cat = "other"
        try:
            priority = int(item.get("priority", 50))
        except (TypeError, ValueError):
            priority = 50
        out.append(ClassifiedEmail(
            email=email,
            category=cat,
            needs_reply=bool(item.get("needs_reply", False)),
            priority=max(0, min(100, priority)),
            reason=str(item.get("reason", ""))[:300],
        ))
    return out


async def classify(
    state: EmailAssistantState,
    *,
    openai_client,
    model: str,
) -> dict:
    """Batch-LLM the inbox into ``ClassifiedEmail``s.

    A single chat call covers the whole inbox to amortize prompt overhead.
    On parse failure we surface the error in ``state.errors`` and return an
    empty classified list — the rest of the pipeline degrades gracefully.

    The system prompt is augmented with the ``email-triage-rules`` Skill
    (loaded via ``_skill_loader``) when present, so the LLM gets the user's
    classification preferences alongside our general heuristics. This is the
    LangGraph-side analog of CrewAI's native ``skills=[...]`` parameter.

    Short-circuit: if ``state["classified"]`` is already populated (caller
    pre-loaded it via ``preloaded_classified`` body field), skip the LLM
    call entirely. This is the partner guard to ``fetch``'s short-circuit
    and is what makes "cheap task switching" possible — the whole
    fetch+classify pair is ~15-20s and ~10 LLM calls otherwise.
    """
    write = _writer()
    locale = state.get("locale", "zh")

    if state.get("classified"):
        # Same ``_cached`` flag as fetch — gives the frontend something to
        # show. Returning {} would also short-circuit but produce no
        # visible signal in the pipeline stream.
        write({
            "phase": "classify",
            "stage": "skipped",
            "message": tr(locale, "classify_cached"),
        })
        return {"_cached": True}

    inbox = state.get("inbox") or []
    if not inbox:
        return {"classified": []}

    write({
        "phase": "classify",
        "stage": "started",
        "message": tr(locale, "classify_started", n=len(inbox)),
    })

    # Lazy import: keeps the rest of _nodes.py importable without skills/
    from _skill_loader import render_skill_for_prompt

    triage_skill = render_skill_for_prompt("email-triage-rules", max_chars=2000)
    system_prompt = CLASSIFY_SYSTEM
    if "not installed" not in triage_skill:
        system_prompt = f"{CLASSIFY_SYSTEM}\n\n{triage_skill}"

    user_msg = "Emails to classify:\n" + _compact_inbox_for_llm(inbox)

    try:
        resp = await openai_client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.1,
            response_format={"type": "json_object"},
        )
        text = (resp.choices[0].message.content or "").strip()
    except Exception as exc:
        write({
            "phase": "classify",
            "stage": "error",
            "message": tr(locale, "classify_failed", err=exc),
        })
        return {"errors": [f"classify: LLM call failed: {exc}"]}

    parsed: Any
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        write({
            "phase": "classify",
            "stage": "error",
            "message": tr(locale, "classify_unparsed"),
        })
        return {"errors": [f"classify: failed to parse LLM output: {text[:200]}"]}

    # Most models return {"results": [...]}; tolerate {"emails": [...]} or bare list
    items: Any = parsed
    if isinstance(parsed, dict):
        for key in ("results", "emails", "classifications"):
            if isinstance(parsed.get(key), list):
                items = parsed[key]
                break
        else:
            # Fall back to first list-valued field
            list_fields = [v for v in parsed.values() if isinstance(v, list)]
            items = list_fields[0] if list_fields else []

    by_id = {e.id: e for e in inbox}
    classified = _coerce_classification(items, by_id)
    write({
        "phase": "classify",
        "stage": "completed",
        "message": tr(locale, "classify_done", n=len(classified)),
    })
    return {"classified": classified}


# ─── prioritize ──────────────────────────────────────────────────────────────


async def prioritize(
    state: EmailAssistantState,
    *,
    min_priority: int = 30,
) -> dict:
    """Apply user_rules to nudge priorities, then keep emails worth attention.

    Rule pipeline (cumulative):
      1. VIP domain match     → priority += 20  (cap 100)
      2. ICS + needs_reply    → priority += 10  (cap 100)
      3. category=urgent_customer → priority *= 1.2 (cap 100)
      4. category=spam        → priority := 0

    Filter: keep emails where ``needs_reply=True`` OR ``priority >= min_priority``.
    Sort: priority desc, then received_at asc within the same bucket.
    Reset ``cursor`` to 0 so the per-email loop starts from the top.
    """
    write = _writer()
    classified = state.get("classified") or []
    if not classified:
        return {"prioritized": [], "cursor": 0}

    write({
        "phase": "prioritize",
        "stage": "started",
        "message": tr(state.get("locale", "zh"), "prioritize_started"),
    })

    task = state.get("task")

    # Daily-digest mode: caller may pass already-handled email ids (e.g. from
    # earlier single_reply clicks) so we don't ask the user to re-review the
    # same email. ``single_reply`` is exempt — user explicitly picked an
    # email and we always honor that, even if it's in the skip list.
    skip_ids = set(state.get("skip_email_ids") or [])
    if skip_ids and task != "single_reply":
        classified = [c for c in classified if c.email.id not in skip_ids]
        if not classified:
            return {"prioritized": [], "cursor": 0}

    rules = _bundle_from_rules(state.get("user_rules") or [])
    boosted: list[ClassifiedEmail] = []
    for ce in classified:
        priority = ce.priority
        if _matches_vip_domain(ce.email, rules.vip_domains):
            priority = min(100, priority + 20)
        if ce.email.has_ics and ce.needs_reply:
            priority = min(100, priority + 10)
        if ce.category == "urgent_customer":
            priority = min(100, int(priority * 1.2))
        if ce.category == "spam":
            priority = 0
        boosted.append(ce.model_copy(update={"priority": priority}))

    # Single-reply: bypass the ``needs_reply OR priority >= min_priority``
    # filter — the user explicitly clicked "↩ 处理" on this specific email,
    # so we always draft for it, even if the LLM marked it as
    # ``needs_reply=false`` or low-priority (common for IMAP inboxes full of
    # security alerts / vendor welcomes / Gmail self-emails). This fixes the
    # intermittent "single_reply skipped to summarize" bug where the target
    # email got dropped before our id filter could see it.
    if task == "single_reply":
        target_id = state.get("target_email_id") or ""
        target = (
            next((c for c in boosted if c.email.id == target_id), None)
            if target_id
            else None
        )
        if target is None:
            # Help the user diagnose: no draft will be produced because the
            # email isn't in the (possibly cached) classified set. Surface a
            # concrete next step rather than silently routing to summarize.
            reason = tr(
                state.get("locale", "zh"),
                "prioritize_target_missing",
                id=target_id or "(no id)",
            )
            return {"prioritized": [], "cursor": 0, "errors": [reason]}
        return {"prioritized": [target], "cursor": 0}

    keep = [c for c in boosted if c.needs_reply or c.priority >= min_priority]
    keep.sort(key=lambda c: (-c.priority, c.email.received_at))

    write({
        "phase": "prioritize",
        "stage": "completed",
        "message": (
            tr(state.get("locale", "zh"), "prioritize_done", n=len(keep))
            if keep
            else tr(state.get("locale", "zh"), "prioritize_empty")
        ),
    })

    return {"prioritized": keep, "cursor": 0}


# ─── draft (CrewAI sub-pipeline) ─────────────────────────────────────────────


async def draft_with_crew(state: EmailAssistantState, *, llm) -> dict:
    """Run the three-role CrewAI ``EmailDraftCrew`` for the cursor email.

    Wrapped in ``asyncio.to_thread`` because ``Crew.kickoff`` is blocking —
    same pattern as the marketing template's ``plan.py``.

    The Crew returns a CrewOutput; we prefer ``output.pydantic`` (typed
    ``DraftItem``) and fall back through ``json_dict`` and ``raw`` so a
    finicky LLM doesn't crash the whole pipeline.

    HITL regenerate: if the LATEST ``review_decisions`` entry for this
    email is action="regenerate", we feed its ``feedback`` into the next
    crew so the writer agent honours the user's instruction (e.g. switch
    language, change tone).

    Progress narration: this is the slowest single node (~15-30s — three
    LLM calls in sequence). We bridge CrewAI's event bus to the LangGraph
    custom-stream channel (see ``_events.CrewProgressBridge``) so the
    frontend can show live "🔍 分析师在读邮件 → ✍️ 撰稿员在起草 → 🎨
    润色员在调整语气" narration as each agent runs.
    """
    write = _writer()
    locale = state.get("locale", "zh")
    prioritized = state.get("prioritized") or []
    cursor = state.get("cursor", 0)
    if cursor >= len(prioritized):
        return {}

    ce = prioritized[cursor]
    rules = _bundle_from_rules(state.get("user_rules") or [])

    # Pull the most recent regenerate feedback for THIS email (if any).
    # review_decisions is append-only, so the latest is at the end.
    regenerate_feedback: str | None = None
    for decision in reversed(state.get("review_decisions") or []):
        if decision.email_id != ce.email.id:
            continue
        if decision.action == "regenerate":
            regenerate_feedback = decision.feedback
        # Stop at the first match for this email — older decisions are stale
        break

    # Top-level "starting now" so the user sees something IMMEDIATELY when
    # the draft node enters — before the bridge has captured CrewAI's first
    # AgentExecutionStartedEvent (which can take a couple hundred ms).
    subject_short = (ce.email.subject or "").strip()
    if len(subject_short) > 40:
        subject_short = subject_short[:40] + "…"
    intro = (
        tr(locale, "draft_started", subject=subject_short or tr(locale, "no_subject"))
        + (tr(locale, "draft_started_feedback") if regenerate_feedback else "")
    )
    write({
        "phase": "draft",
        "stage": "started",
        "email_id": ce.email.id,
        "message": intro,
    })

    # Lazy import keeps unit tests light
    from _crew import build_email_draft_crew
    from _events import CrewProgressBridge

    crew, inputs = build_email_draft_crew(
        llm,
        classified=ce,
        rules=rules,
        regenerate_feedback=regenerate_feedback,
    )

    loop = asyncio.get_running_loop()

    try:
        # Bridge CrewAI bus → custom stream for the duration of kickoff.
        # The bridge schedules writer calls via call_soon_threadsafe, so
        # CrewAI's worker thread can publish events safely.
        with CrewProgressBridge(loop, write, email_subject=ce.email.subject, locale=locale):
            # YAML variables are filled by CrewAI at kickoff via inputs dict
            out = await asyncio.to_thread(crew.kickoff, inputs=inputs)
    except Exception as exc:
        write({
            "phase": "draft",
            "stage": "error",
            "email_id": ce.email.id,
            "message": tr(locale, "draft_error", err=exc),
        })
        # Surface the error and emit a placeholder draft so HITL can show the
        # user what went wrong (rather than spinning silently).
        placeholder = _placeholder_draft(ce, rules.default_tone, rules.signature,
                                          reason=f"crew error: {exc}")
        return {
            "drafts": [placeholder],
            "pending_review": placeholder,
            "errors": [f"draft: crew kickoff failed: {exc}"],
        }

    draft = _coerce_draft_output(out, ce, rules)
    draft = _normalize_draft(draft, ce, locale=locale)
    write({
        "phase": "draft",
        "stage": "completed",
        "email_id": ce.email.id,
        "message": tr(locale, "draft_done", n=len(draft.body)),
    })
    return {"drafts": [draft], "pending_review": draft}


def _strip_email_markdown(body: str) -> str:
    """Defensively strip markdown syntax from an email body.

    The polisher prompt forbids markdown, but LLMs sometimes ignore the
    instruction (especially when adapting a markdown-y reply template).
    This pass acts as a safety net so the textarea in DraftReviewCard
    never shows raw `**bold**` or `## headings` to the user.

    Conservative — we only strip well-known markdown markers; we don't try
    to "render" them. The goal is plain text the user can paste verbatim
    into Gmail's compose box.

    Order matters:
      1. Code fences (```...```) — replace with the raw inner text
      2. Inline backticks (`code`) — drop the backticks, keep the word
      3. Bold / italic (**text**, *text*, __text__, _text_) — keep the text
      4. Heading markers (##, ###) at line start — drop just the marker
      5. Bullet markers (- / *) at line start — replace with nothing (the
         indent + content remains, reading as a normal short paragraph)
      6. Numbered list markers (``1. `` at line start) are KEPT — they
         look natural in plain-text emails ("1. First, do X.")
      7. Link syntax [text](url) → "text (url)"
      8. Horizontal rules (---, ***, ___) on their own line → drop
      9. Markdown tables — drop entirely (the | row syntax is unreadable
         as plain text and would corrupt the email)
    """
    import re

    if not body:
        return body
    text = body

    # 0. Tool-result leak — the writer agent sometimes prepends the JSON it
    # got from ``lookup_reply_template`` (e.g. ``{"template_name": "..."}``)
    # to the draft body. Strip that leading fragment so the user only sees
    # the actual prose.
    text = re.sub(r"^\s*\{\s*\"template_name\"\s*:[^{}]*\}\s*", "", text)

    # 1. Code fences — keep inner content, drop the fence markers + lang hint
    text = re.sub(r"```[^\n]*\n?(.*?)```", r"\1", text, flags=re.DOTALL)

    # 2. Inline backticks
    text = re.sub(r"`([^`\n]+)`", r"\1", text)

    # 3. Bold / italic. Strip stars/underscores around runs of non-marker chars.
    text = re.sub(r"\*\*([^*\n]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_\n]+)__", r"\1", text)
    text = re.sub(r"\*([^*\n]+)\*", r"\1", text)
    text = re.sub(r"(?<!\w)_([^_\n]+)_(?!\w)", r"\1", text)

    # 7. Link syntax. Do this BEFORE stripping bullet markers — order of
    # operations doesn't matter for these but it's easier to reason about.
    text = re.sub(r"\[([^\]\n]+)\]\(([^)\n]+)\)", r"\1 (\2)", text)

    # Now line-by-line for headings / bullets / hr / tables.
    out_lines: list[str] = []
    in_table = False
    for line in text.split("\n"):
        stripped = line.strip()

        # 9. Markdown table detection — a line that is mostly pipe-separated
        # cells. We drop the whole table; subsequent paragraph break already
        # handles spacing.
        is_table_row = stripped.startswith("|") and stripped.count("|") >= 2
        is_table_sep = bool(re.match(r"^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$", stripped))
        if is_table_row or is_table_sep:
            in_table = True
            continue
        if in_table and stripped == "":
            in_table = False
            out_lines.append("")
            continue
        in_table = False

        # 8. Horizontal rule
        if re.match(r"^\s*([-*_])\1{2,}\s*$", line):
            continue

        # 4. Heading markers
        m = re.match(r"^\s*#{1,6}\s+(.*)$", line)
        if m:
            out_lines.append(m.group(1))
            continue

        # 5. Bullet markers (-, *, +) — drop the marker, keep indent + text
        m = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
        if m:
            out_lines.append(f"{m.group(1)}{m.group(2)}")
            continue

        out_lines.append(line)

    # Collapse 3+ blank lines to 2 (markdown-stripping can leave gaps where
    # tables / hrules used to be).
    cleaned = "\n".join(out_lines)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _normalize_draft(draft: DraftItem, ce: ClassifiedEmail, *, locale: str = "zh") -> DraftItem:
    """Apply post-LLM safety nets so the UI never shows broken drafts.

    The polisher LLM occasionally returns:
      - empty ``subject`` or just the ``"Re:"`` prefix
      - empty ``body`` (rare but observed under rate limiting)
      - empty ``email_id`` / ``to`` (when it loses the input context)
      - LITERAL placeholder leakage like ``Re: {email[subject]}`` (happens
        when an LLM echoes our prompt template back instead of the value)

    We patch each of these from the original ``ClassifiedEmail`` so the HITL
    review card never says "(无主题)" or shows broken curly-brace placeholders.
    """
    patched: dict[str, Any] = {}

    # subject: "" or "Re:" or "Re: " or contains LITERAL "{...}" → "Re: <original>"
    raw_subject = (draft.subject or "").strip()
    bare_re = raw_subject.rstrip(":").strip().lower() in ("", "re")
    has_placeholder_subject = "{" in raw_subject and "}" in raw_subject
    if bare_re or has_placeholder_subject:
        original = (ce.email.subject or "").strip()
        patched["subject"] = f"Re: {original}" if original else f"Re: {tr(locale, 'no_subject')}"

    # body: keep whatever non-empty content we have, but reject obvious
    # placeholder leaks (the LLM complaining about missing inputs).
    body_text = (draft.body or "").strip()
    looks_like_placeholder_complaint = (
        ("{email[" in body_text)
        or ("{email_" in body_text and "}" in body_text)
        or "placeholder variables" in body_text.lower()
        or "邮件内容尚未提供" in body_text
        or "请把原始邮件" in body_text
    )
    if (not body_text) or looks_like_placeholder_complaint:
        patched["body"] = tr(locale, "placeholder_body")
    else:
        # Strip residual markdown — emails are plain text. Prompts are
        # advisory; this pass is the enforcement. Always run, even if the
        # body looks clean, because the cost is negligible (regex on a
        # few-hundred-character string) and a single missed `**` would
        # ruin the user's first impression of the draft.
        cleaned_body = _strip_email_markdown(body_text)
        if cleaned_body and cleaned_body != body_text:
            patched["body"] = cleaned_body

    # email_id: should always match the source email's id
    if not draft.email_id or "{" in (draft.email_id or ""):
        patched["email_id"] = ce.email.id

    # to: fall back to the sender of the original email
    if not draft.to or any("{" in t for t in draft.to):
        patched["to"] = [ce.email.sender]

    if not patched:
        return draft
    return draft.model_copy(update=patched)


def _coerce_draft_output(out: Any, ce: ClassifiedEmail, rules: UserRulesBundle) -> DraftItem:
    """Convert a CrewOutput → DraftItem with multiple fallbacks."""
    # 1. pydantic typed output (best case — output_pydantic on polish_task)
    pyd = getattr(out, "pydantic", None)
    if isinstance(pyd, DraftItem):
        return pyd
    # 2. json_dict (Crew parsed JSON output)
    jd = getattr(out, "json_dict", None)
    if isinstance(jd, dict):
        try:
            return DraftItem.model_validate(jd)
        except Exception:
            pass
    # 3. raw text — try parsing it as JSON
    raw = getattr(out, "raw", None) or str(out)
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped.startswith("{"):
            try:
                return DraftItem.model_validate_json(stripped)
            except Exception:
                pass
    # 4. Last-resort placeholder — keep the pipeline moving
    body = raw if isinstance(raw, str) and raw.strip() else "(empty draft)"
    return _placeholder_draft(ce, rules.default_tone, rules.signature,
                              body=body, reason="raw fallback (couldn't parse Crew output)")


def _placeholder_draft(
    ce: ClassifiedEmail, tone: str, signature: str,
    *, body: str | None = None, reason: str = "",
) -> DraftItem:
    full_body = body or "(could not generate a draft for this email)"
    if signature and signature not in full_body:
        full_body = f"{full_body}\n\n{signature}"
    return DraftItem(
        email_id=ce.email.id,
        to=[ce.email.sender],
        subject=f"Re: {ce.email.subject}",
        body=full_body,
        tone=tone,  # type: ignore[arg-type]
        template_used=None,
        confidence=0.3,
        rationale=reason,
    )


# ─── review (HITL — pauses via interrupt(), or auto-approves) ─────────────────


async def review(state: EmailAssistantState) -> dict:
    """Decide what to do with the pending draft.

    Two paths:

    1. **HITL** (default): call ``langgraph.types.interrupt(payload)`` which
       pauses the graph. The platform checkpointer persists state to
       ``ctx.store.langgraph_checkpointer``. The driver (``run.py``) sees
       ``__interrupt__`` in the stream, surfaces ``human_review_required``
       via SSE, and closes the connection. The frontend renders the approval
       card; the user POSTs ``/email/review`` with the same conversation_id;
       ``review.py`` calls ``app.astream(Command(resume=value), config=...)``
       which re-enters this node — ``interrupt()`` now returns ``value``
       instead of pausing.

    2. **auto-approve** (testing): when ``state.auto_approve == True`` (set by
       the caller explicitly), skip the interrupt entirely so the pipeline
       runs to completion without blocking on humans.

    The resume value contract (from ``review.py``):

        {"action": "approve" | "edit" | "reject" | "regenerate" | "skip",
         "edited_body": "..." | null,    # required for "edit"
         "feedback": "..." | null}       # optional hint for "regenerate"
    """
    draft = state.get("pending_review")
    if not draft:
        return {}

    if state.get("auto_approve", False):
        decision = ReviewDecision(email_id=draft.email_id, action="approve")
        return {"review_decisions": [decision]}

    # ── HITL path ──
    # Lazy import: keeps the module loadable in environments without langgraph
    # (unit tests of pure-python helpers) and avoids a circular at module load.
    from langgraph.types import interrupt

    cursor = state.get("cursor", 0)
    prioritized = state.get("prioritized") or []
    remaining = max(0, len(prioritized) - cursor - 1)

    payload = {
        "type": "human_review_required",
        "interrupt_id": f"rev_{draft.email_id}",
        "email_id": draft.email_id,
        "draft": draft.model_dump(mode="json"),
        "options": ["approve", "edit", "reject", "regenerate", "skip"],
        "remaining": remaining,
    }

    resume_value = interrupt(payload)

    # resume_value comes from ``Command(resume=value)`` in review.py.
    # Defensively coerce — a malformed resume shouldn't crash the pipeline.
    if not isinstance(resume_value, dict):
        decision = ReviewDecision(email_id=draft.email_id, action="approve")
    else:
        action = str(resume_value.get("action") or "approve")
        if action not in ("approve", "edit", "reject", "regenerate", "skip"):
            action = "approve"
        decision = ReviewDecision(
            email_id=draft.email_id,
            action=action,  # type: ignore[arg-type]
            edited_body=resume_value.get("edited_body"),
            feedback=resume_value.get("feedback"),
        )

    return {"review_decisions": [decision]}


# ─── apply (commit side-effects, advance cursor) ─────────────────────────────


async def apply(state: EmailAssistantState, *, provider) -> dict:
    """Honor the latest ReviewDecision against the pending draft.

    Side-effects (via ``provider``):
      - approve / edit  → save_draft (writes to Drafts folder)
      - reject          → mark_read (so it doesn't keep nagging)
      - skip            → no-op
      - regenerate      → no-op (routing sends us back to draft)

    Advances ``cursor`` so the conditional edge ``next_or_done`` either
    re-enters the loop on the next prioritized email or routes to summarize.
    Also clears ``pending_review`` so the next draft node can populate it.
    """
    draft = state.get("pending_review")
    decisions = state.get("review_decisions") or []
    cursor = state.get("cursor", 0)
    if not draft or not decisions:
        # Defensive: nothing to apply, just advance cursor anyway
        return {"cursor": cursor + 1, "pending_review": None}

    # The most recent decision for THIS draft
    decision = next(
        (d for d in reversed(decisions) if d.email_id == draft.email_id), None
    )
    if not decision:
        return {"cursor": cursor + 1, "pending_review": None}

    actions: list[Action] = []
    new_drafts: list[DraftItem] = []

    if decision.action == "approve":
        body = decision.edited_body or draft.body
        final = draft.model_copy(update={"body": body}) if decision.edited_body else draft
        try:
            draft_id = await provider.save_draft(final)
            actions.append(Action(
                email_id=draft.email_id, op="save_draft",
                payload={"draft_id": draft_id, "edited": bool(decision.edited_body)},
            ))
            if decision.edited_body:
                new_drafts.append(final)
        except Exception as exc:
            return {
                "cursor": cursor + 1, "pending_review": None,
                "errors": [f"apply: save_draft failed for {draft.email_id}: {exc}"],
            }

    elif decision.action == "edit":
        # ``edit`` is the same as approve but body MUST come from edited_body
        body = decision.edited_body or draft.body
        final = draft.model_copy(update={"body": body})
        try:
            draft_id = await provider.save_draft(final)
            actions.append(Action(
                email_id=draft.email_id, op="save_draft",
                payload={"draft_id": draft_id, "edited": True},
            ))
            new_drafts.append(final)
        except Exception as exc:
            return {
                "cursor": cursor + 1, "pending_review": None,
                "errors": [f"apply: save_draft failed for {draft.email_id}: {exc}"],
            }

    elif decision.action == "reject":
        try:
            await provider.mark_read(draft.email_id)
        except Exception:
            pass  # mark_read failure isn't critical
        actions.append(Action(email_id=draft.email_id, op="mark_read"))

    elif decision.action == "skip":
        actions.append(Action(email_id=draft.email_id, op="skip"))

    # regenerate → no apply work; routing handles re-draft. Don't bump cursor.
    if decision.action == "regenerate":
        return {"pending_review": None}  # cleared so draft node refills

    update: dict[str, Any] = {
        "final_actions": actions,
        "pending_review": None,
        "cursor": cursor + 1,
    }
    if new_drafts:
        update["drafts"] = new_drafts
    return update


# ─── summarize (final markdown digest) ───────────────────────────────────────


SUMMARIZE_SYSTEM = """You are the summarizer of an email assistant. Produce a concise digest
(≤800 characters) that lets the user see at a glance what this run achieved.

Structure (markdown level-2 headings, plain text or bullet lists for content):

1. ## Overview —— one or two natural-language sentences: total emails /
   classified / drafted / decisions
2. ## Needs Attention —— the top 5 emails by priority, one bullet per line,
   formatted as: `- [priority] subject — sender — one-line reason`
3. ## Decisions —— a bullet list of each email's action
   (approve/edit/reject/skip), one per line:
   `- subject (sender): approve/edit/reject/skip — one-line comment`
4. ## Next Steps —— 1-3 natural-language suggestions

Strict requirements:
- ❌ NO markdown tables (any `| col | col |` syntax — the frontend cannot render them)
- ❌ NO fenced code blocks (```...```)
- ❌ NO HTML tags
- ✅ Only: ## headings, `- ` bullet lists, **bold**, plain paragraphs
- Concise, business-friendly
- Do not repeat the full text of each email
- Output the markdown directly, no preamble or closing remarks
"""


def _sanitize_summary_md(text: str) -> str:
    """Strip markdown the frontend's MarkdownBody can't render.

    The frontend hand-rolls a tiny markdown subset (see
    ``ConversationStream.tsx::MarkdownBody``): h2/h3, bullet lists,
    **bold**, inline `code`, links. Anything else renders as raw text and
    looks broken — we sanitize those constructs server-side so the user
    sees a clean digest even when the LLM ignores prompt rules.

    Specifically:
      - Markdown tables (`| col | col |` rows + the `|---|---|` separator)
        → drop entirely. The summary structure already calls for lists
        not tables, but LLMs default to tables for "decisions per email".
      - Fenced code blocks (```...```) → keep the inner content as
        plain paragraph text (drop the fence + lang hint).
      - Numbered lists (`1. foo`) → convert to bullet lists (`- foo`)
        because MarkdownBody only renders `- ` / `* `.

    Headings, bold, inline backticks, links, and bullet lists are left
    untouched — they render correctly.
    """
    import re

    if not text:
        return text

    # Drop fenced code blocks but preserve their inner content (so the user
    # still sees what was inside if it was meaningful).
    text = re.sub(r"```[^\n]*\n?(.*?)```", r"\1", text, flags=re.DOTALL)

    # Walk line-by-line for table detection + numbered-list conversion.
    out_lines: list[str] = []
    in_table = False
    for line in text.split("\n"):
        stripped = line.strip()

        # Markdown table row OR separator
        is_table_row = stripped.startswith("|") and stripped.count("|") >= 2
        is_table_sep = bool(
            re.match(
                r"^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$", stripped
            )
        )
        if is_table_row or is_table_sep:
            in_table = True
            continue
        if in_table and stripped == "":
            in_table = False
            out_lines.append("")
            continue
        in_table = False

        # Numbered list → bullet list (MarkdownBody only supports `- `/`* `)
        m = re.match(r"^(\s*)\d+\.\s+(.*)$", line)
        if m:
            out_lines.append(f"{m.group(1)}- {m.group(2)}")
            continue

        out_lines.append(line)

    cleaned = "\n".join(out_lines)
    # Collapse runs of 3+ blank lines created by table removal.
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


async def summarize(
    state: EmailAssistantState,
    *,
    openai_client,
    model: str,
) -> dict:
    """Build the final markdown digest. Falls back to a deterministic
    summary if the LLM call fails — the UI always shows something useful.

    Augments the system prompt with the ``email-tone`` Skill so the digest
    matches the user's writing voice.

    Short-circuit: ``single_reply`` runs scope to a single email — the user
    has already seen the draft and made a decision, a one-email "今日摘要"
    bubble would be misleading (it can't see the broader session). We
    return an empty summary; the frontend hides the summary bubble for
    single_reply runs.
    """
    write = _writer()
    if state.get("task") == "single_reply":
        return {"summary": ""}

    locale = state.get("locale", "zh")
    payload = _summary_payload(state)
    fallback = _fallback_summary(payload, locale=locale)

    write({
        "phase": "summarize",
        "stage": "started",
        "message": tr(locale, "summarize_started", n=payload["counts"]["decisions"]),
    })

    # Lazy import — keeps tests that exercise summarize without skills lean
    from _skill_loader import render_skill_for_prompt

    tone_skill = render_skill_for_prompt("email-tone", max_chars=2000)
    # The prompt skeleton is English; the OUTPUT language is injected per the
    # UI locale so an English user gets an English digest and a Chinese user
    # gets a Chinese one.
    system_prompt = (
        SUMMARIZE_SYSTEM
        + f"\nWrite the ENTIRE summary (headings included) in {LANGUAGE_NAME[locale]}.\n"
    )
    if "not installed" not in tone_skill:
        system_prompt = f"{system_prompt}\n{tone_skill}"

    # Token streaming — emit each non-empty delta to the custom-stream channel
    # so the frontend can render the markdown summary as it's generated. The
    # OpenAI Async streaming response yields chunks; we accumulate full_text
    # locally so the final state["summary"] still gets the complete value
    # (callers downstream depend on it being non-empty for the "done" SSE
    # event payload).
    full_text = ""
    try:
        stream = await openai_client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            temperature=0.3,
            stream=True,
        )
        async for chunk in stream:
            # ``chunk.choices`` can be empty on the very last frame (some
            # gateways emit a final ``finish_reason`` chunk with no content);
            # guard so we don't IndexError on it.
            choices = getattr(chunk, "choices", None) or []
            if not choices:
                continue
            delta_obj = getattr(choices[0], "delta", None)
            delta_text = getattr(delta_obj, "content", None) if delta_obj else None
            if not delta_text:
                continue
            full_text += delta_text
            write({
                "phase": "summarize",
                "stage": "token",
                "delta": delta_text,
            })
    except Exception as exc:
        write({
            "phase": "summarize",
            "stage": "error",
            "message": tr(locale, "summarize_failed", err=exc),
        })
        return {"summary": fallback, "errors": [f"summarize: LLM call failed: {exc}"]}

    text = full_text.strip()
    if not text:
        write({
            "phase": "summarize",
            "stage": "error",
            "message": tr(locale, "summarize_empty"),
        })
        return {"summary": fallback, "errors": ["summarize: LLM returned empty"]}
    # Sanitize markdown the frontend can't render (tables, code fences,
    # numbered lists). The streamed token bubble may have briefly shown
    # raw `| col |` rows during streaming, but the final settled summary
    # message uses ``state.summary`` (this return value), so the rendered
    # bubble lands clean. The cost is a single regex pass on a ~800-char
    # string — negligible.
    text = _sanitize_summary_md(text)
    write({
        "phase": "summarize",
        "stage": "completed",
        "message": tr(locale, "summarize_done", n=len(text)),
    })
    return {"summary": text}


def _summary_payload(state: EmailAssistantState) -> dict:
    inbox = state.get("inbox") or []
    classified = state.get("classified") or []
    prioritized = state.get("prioritized") or []
    drafts = state.get("drafts") or []
    decisions = state.get("review_decisions") or []
    actions = state.get("final_actions") or []
    return {
        "counts": {
            "inbox": len(inbox),
            "classified": len(classified),
            "prioritized": len(prioritized),
            "drafts": len(drafts),
            "decisions": len(decisions),
            "actions": len(actions),
        },
        "top": [
            {
                "subject": ce.email.subject,
                "from": ce.email.sender,
                "priority": ce.priority,
                "category": ce.category,
                "reason": ce.reason,
            }
            for ce in prioritized[:5]
        ],
        "decisions": [d.model_dump() for d in decisions],
        "actions": [a.model_dump() for a in actions],
    }


def _fallback_summary(payload: dict, *, locale: str = "zh") -> str:
    c = payload["counts"]
    if c["inbox"] == 0:
        return tr(locale, "fb_no_mail")
    lines = [
        tr(locale, "fb_overview"),
        tr(locale, "fb_inbox_total", n=c["inbox"]),
        tr(locale, "fb_classified", n=c["classified"]),
        tr(locale, "fb_drafted", n=c["drafts"]),
        tr(locale, "fb_decisions", n=c["decisions"]),
        tr(locale, "fb_actions", n=c["actions"]),
    ]
    if payload["top"]:
        lines.append("")
        lines.append(tr(locale, "fb_attention"))
        for t in payload["top"]:
            lines.append(f"- [{t['priority']}] {t['subject']} — {t['from']}")
    if payload["decisions"]:
        lines.append("")
        lines.append(tr(locale, "fb_decided"))
        for d in payload["decisions"]:
            lines.append(f"- {d['email_id']}: **{d['action']}**")
    return "\n".join(lines)
