"""LangGraph state schema for the email-assistant template.

The ``EmailAssistantState`` flows through every node in ``_graph.py``. Fields
are append-only via ``Annotated[..., add]`` so multiple runs / regenerations
accumulate into the same conversation thread.

Design notes:
  - ``cursor``: index into ``prioritized``; the ``apply`` node bumps it before
    routing to ``draft`` (next email) or ``summarize`` (done).
  - ``pending_review``: the single draft currently waiting on human approval.
    Cleared inside ``apply`` once a decision lands.
  - ``review_decisions``: append-only audit trail; useful for the SSE frontend
    to render an "already-decided" history.
  - ``inbox`` is a snapshot — the provider may fetch more later, but the graph
    operates on this snapshot for determinism.
"""
from __future__ import annotations

from operator import add
from typing import Annotated, Literal, Optional, TypedDict

from _models import (
    Action,
    ClassifiedEmail,
    DraftItem,
    Email,
    ReviewDecision,
    UserRule,
)


TaskMode = Literal["daily_digest", "single_reply", "triage_only"]


class EmailAssistantState(TypedDict, total=False):
    # ─── Inputs ───
    task: TaskMode
    user_rules: list[UserRule]
    # UI locale ("zh" | "en") sent by the frontend. Drives all user-visible
    # narration strings (_i18n.tr) and the language instruction the draft /
    # summarize prompts hand to the LLM. Defaults to "zh" when absent (local
    # CLI runs, direct unit-test calls).
    locale: str
    # When ``task == "single_reply"``, restrict the draft loop to a single
    # email by id. The prioritize node filters ``prioritized`` down to the
    # one match (or empty list if id not found). For other tasks this is
    # ignored.
    target_email_id: str
    # Email ids the caller wants prioritize to skip in ``daily_digest`` mode.
    # Used by the frontend to avoid re-prompting on emails the user already
    # processed via single_reply earlier in the session. Single-reply itself
    # ignores this — explicit user picks always win.
    skip_email_ids: list[str]

    # ─── Pipeline outputs ───
    inbox: list[Email]
    classified: list[ClassifiedEmail]
    prioritized: list[ClassifiedEmail]   # subset of classified, sorted, that need_reply OR mid-priority
    drafts: Annotated[list[DraftItem], add]
    review_decisions: Annotated[list[ReviewDecision], add]
    final_actions: Annotated[list[Action], add]
    errors: Annotated[list[str], add]

    # ─── Cursor & HITL ───
    cursor: int                          # next index into prioritized
    pending_review: Optional[DraftItem]  # current draft awaiting approval
    auto_approve: bool                   # when True, review node auto-approves without interrupt()

    # ─── Final ───
    summary: str
