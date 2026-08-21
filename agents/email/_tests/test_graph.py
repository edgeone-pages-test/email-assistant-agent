"""Unit tests for Day 5 — routing, apply, summarize, graph compilation.

Run with::

    pytest agents/email/tests/test_graph.py -v
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from typing import Any

import pytest

from _models import (
    Action,
    ClassifiedEmail,
    DraftItem,
    Email,
    ReviewDecision,
    UserRule,
)
from _nodes import _fallback_summary, _summary_payload, apply, review, summarize
from _routing import after_prioritize, after_review, next_or_done


# ─── Helpers (also used in test_nodes.py) ──────────────────────────────────


def _make_email(eid="m1", sender="alice@x.com", subject="Hi", body="Hello") -> Email:
    return Email(
        id=eid, from_=sender, to=["me@x.com"], subject=subject, body_text=body,
        received_at=datetime(2026, 5, 19, 10, 0, tzinfo=timezone.utc),
        thread_id=f"thr_{eid}",
    )


def _ce(eid="m1", priority=80, needs_reply=True, sender="alice@x.com",
        category="internal"):
    return ClassifiedEmail(
        email=_make_email(eid=eid, sender=sender),
        category=category, needs_reply=needs_reply, priority=priority, reason="",
    )


def _draft(email_id="m1", body="reply body") -> DraftItem:
    return DraftItem(
        email_id=email_id, to=["alice@x.com"], subject="Re: Hi",
        body=body, tone="friendly_professional", confidence=0.8, rationale="",
    )


class FakeProvider:
    """Track save_draft / archive / mark_read calls."""

    def __init__(self):
        self.saved: list[DraftItem] = []
        self.archived: list[str] = []
        self.read: list[str] = []

    async def save_draft(self, draft: DraftItem) -> str:
        self.saved.append(draft)
        return f"draft_test_{len(self.saved)}"

    async def archive(self, email_id: str) -> None:
        self.archived.append(email_id)

    async def mark_read(self, email_id: str) -> None:
        self.read.append(email_id)

    async def fetch_inbox(self, since=None, limit=50):
        return []

    async def load_user_rules(self):
        from _models import UserRulesBundle
        return UserRulesBundle()


class FailingSaveProvider(FakeProvider):
    async def save_draft(self, draft):
        raise RuntimeError("disk full")


# ─── Routing ────────────────────────────────────────────────────────────────


def test_after_prioritize_with_emails():
    state = {"prioritized": [_ce()]}
    assert after_prioritize(state) == "draft"


def test_after_prioritize_empty():
    state: dict = {"prioritized": []}
    assert after_prioritize(state) == "summarize"


def test_after_prioritize_missing_key():
    assert after_prioritize({}) == "summarize"


def test_after_prioritize_triage_only_skips_drafting():
    """``task=triage_only`` is the fast preview path — never enter the
    per-email draft loop, even if there ARE emails to draft."""
    state = {"task": "triage_only", "prioritized": [_ce(), _ce("m2")]}
    assert after_prioritize(state) == "summarize"


def test_after_prioritize_daily_digest_with_emails_drafts():
    """The default task does enter the draft loop when emails exist."""
    state = {"task": "daily_digest", "prioritized": [_ce()]}
    assert after_prioritize(state) == "draft"


def test_after_review_approve_goes_to_apply():
    state = {"review_decisions": [ReviewDecision(email_id="m1", action="approve")]}
    assert after_review(state) == "apply"


def test_after_review_regenerate_goes_back_to_draft():
    state = {"review_decisions": [ReviewDecision(email_id="m1", action="regenerate")]}
    assert after_review(state) == "draft"


def test_after_review_only_latest_decision_matters():
    state = {"review_decisions": [
        ReviewDecision(email_id="m1", action="regenerate"),
        ReviewDecision(email_id="m1", action="approve"),
    ]}
    assert after_review(state) == "apply"


def test_after_review_no_decisions_defensive():
    """No decisions → continue to apply (it'll no-op safely)."""
    assert after_review({}) == "apply"


def test_next_or_done_more_to_process():
    state = {"prioritized": [_ce("a"), _ce("b")], "cursor": 1}
    assert next_or_done(state) == "draft"


def test_next_or_done_completed():
    state = {"prioritized": [_ce("a")], "cursor": 1}
    assert next_or_done(state) == "summarize"


# ─── review (Day 5 auto-approve) ────────────────────────────────────────────


def test_review_auto_approves_pending_draft():
    """When ``auto_approve=True``, review skips interrupt()."""
    state = {"pending_review": _draft(email_id="m1"), "auto_approve": True}
    out = asyncio.run(review(state))
    assert "review_decisions" in out
    assert len(out["review_decisions"]) == 1
    assert out["review_decisions"][0].action == "approve"
    assert out["review_decisions"][0].email_id == "m1"


def test_review_no_pending_draft_returns_empty():
    out = asyncio.run(review({}))
    assert out == {}


# ─── apply ──────────────────────────────────────────────────────────────────


def test_apply_approve_saves_draft_and_advances_cursor():
    provider = FakeProvider()
    state = {
        "pending_review": _draft(email_id="m1"),
        "review_decisions": [ReviewDecision(email_id="m1", action="approve")],
        "cursor": 0,
    }
    out = asyncio.run(apply(state, provider=provider))
    assert len(provider.saved) == 1
    assert provider.saved[0].body == "reply body"
    assert out["pending_review"] is None
    assert out["cursor"] == 1
    assert out["final_actions"][0].op == "save_draft"


def test_apply_edit_uses_edited_body():
    provider = FakeProvider()
    state = {
        "pending_review": _draft(email_id="m1", body="original"),
        "review_decisions": [ReviewDecision(
            email_id="m1", action="edit", edited_body="user wrote this",
        )],
        "cursor": 0,
    }
    out = asyncio.run(apply(state, provider=provider))
    assert provider.saved[0].body == "user wrote this"
    assert out["final_actions"][0].payload.get("edited") is True
    # Edited draft should also be appended to drafts list
    assert "drafts" in out
    assert out["drafts"][0].body == "user wrote this"


def test_apply_reject_marks_read_no_save():
    provider = FakeProvider()
    state = {
        "pending_review": _draft(email_id="m1"),
        "review_decisions": [ReviewDecision(email_id="m1", action="reject")],
        "cursor": 0,
    }
    out = asyncio.run(apply(state, provider=provider))
    assert provider.saved == []
    assert provider.read == ["m1"]
    assert out["final_actions"][0].op == "mark_read"
    assert out["cursor"] == 1


def test_apply_skip_no_provider_calls():
    provider = FakeProvider()
    state = {
        "pending_review": _draft(email_id="m1"),
        "review_decisions": [ReviewDecision(email_id="m1", action="skip")],
        "cursor": 0,
    }
    out = asyncio.run(apply(state, provider=provider))
    assert provider.saved == []
    assert provider.read == []
    assert out["final_actions"][0].op == "skip"
    assert out["cursor"] == 1


def test_apply_regenerate_clears_pending_no_cursor_bump():
    provider = FakeProvider()
    state = {
        "pending_review": _draft(email_id="m1"),
        "review_decisions": [ReviewDecision(email_id="m1", action="regenerate")],
        "cursor": 5,
    }
    out = asyncio.run(apply(state, provider=provider))
    assert out["pending_review"] is None
    # cursor not bumped — routing sends us back to draft for the same email
    assert "cursor" not in out


def test_apply_save_failure_records_error():
    provider = FailingSaveProvider()
    state = {
        "pending_review": _draft(email_id="m1"),
        "review_decisions": [ReviewDecision(email_id="m1", action="approve")],
        "cursor": 0,
    }
    out = asyncio.run(apply(state, provider=provider))
    assert "errors" in out
    assert "save_draft failed" in out["errors"][0]
    assert out["cursor"] == 1  # still advance cursor to avoid infinite loop


def test_apply_no_decisions_advances_cursor_safely():
    provider = FakeProvider()
    state: dict[str, Any] = {
        "pending_review": _draft(email_id="m1"),
        "cursor": 2,
    }
    out = asyncio.run(apply(state, provider=provider))
    assert out["cursor"] == 3
    assert out["pending_review"] is None


def test_apply_picks_latest_decision_for_email():
    """If multiple decisions exist for the same email, the LATEST wins."""
    provider = FakeProvider()
    state = {
        "pending_review": _draft(email_id="m1"),
        "review_decisions": [
            ReviewDecision(email_id="m1", action="regenerate"),
            ReviewDecision(email_id="m1", action="approve"),
        ],
        "cursor": 0,
    }
    out = asyncio.run(apply(state, provider=provider))
    # Latest is approve → save_draft path
    assert len(provider.saved) == 1
    assert out["cursor"] == 1


# ─── summarize ──────────────────────────────────────────────────────────────


def test_fallback_summary_empty_inbox():
    out = _fallback_summary({"counts": {"inbox": 0, "classified": 0,
                                         "prioritized": 0, "drafts": 0,
                                         "decisions": 0, "actions": 0},
                              "top": [], "decisions": [], "actions": []})
    assert "今日无新邮件" in out


def test_fallback_summary_includes_top_emails():
    payload = {
        "counts": {"inbox": 3, "classified": 3, "prioritized": 2,
                   "drafts": 1, "decisions": 1, "actions": 1},
        "top": [
            {"subject": "VIP issue", "from": "ceo@x.com",
             "priority": 95, "category": "urgent_customer", "reason": "outage"},
        ],
        "decisions": [{"email_id": "m1", "action": "approve",
                       "edited_body": None, "feedback": None}],
        "actions": [],
    }
    out = _fallback_summary(payload)
    assert "VIP issue" in out
    assert "[95]" in out
    assert "approve" in out


def test_summary_payload_extracts_counts_and_top5():
    state = {
        "inbox": [_make_email("a"), _make_email("b")],
        "classified": [_ce("a"), _ce("b")],
        "prioritized": [_ce(eid=f"p{i}", priority=90 - i) for i in range(7)],
        "drafts": [_draft("p0"), _draft("p1")],
        "review_decisions": [ReviewDecision(email_id="p0", action="approve")],
        "final_actions": [Action(email_id="p0", op="save_draft")],
    }
    payload = _summary_payload(state)
    assert payload["counts"]["inbox"] == 2
    assert payload["counts"]["prioritized"] == 7
    # Only top 5 surface
    assert len(payload["top"]) == 5
    assert payload["top"][0]["priority"] == 90


def test_summarize_with_llm_returns_text():
    class FakeChat:
        def __init__(self, content):
            class _C:
                class _M:
                    pass
                message = _M()
                message.content = content
            self.choices = [_C()]

    class FakeCompletions:
        def __init__(self):
            self.calls = []
        async def create(self, **kwargs):
            self.calls.append(kwargs)
            return FakeChat("## 概览\n- 收件箱 3 封")

    class FakeChat2:
        def __init__(self):
            self.completions = FakeCompletions()

    class FakeClient:
        def __init__(self):
            self.chat = FakeChat2()

    state = {"inbox": [_make_email("a")], "classified": [_ce("a")],
             "prioritized": [], "drafts": [], "review_decisions": [], "final_actions": []}
    client = FakeClient()
    out = asyncio.run(summarize(state, openai_client=client, model="m"))
    assert "概览" in out["summary"]
    # W2 D4: summarize injects the email-tone Skill into its system prompt
    system_msg = client.chat.completions.calls[0]["messages"][0]["content"]
    assert "Skill: email-tone" in system_msg or "summarizer of an email assistant" in system_msg


def test_summarize_llm_failure_falls_back():
    class FailingClient:
        class _Chat:
            class _Comp:
                async def create(self, **kwargs):
                    raise RuntimeError("gateway down")
            completions = _Comp()
        chat = _Chat()

    state = {"inbox": [_make_email("a")], "classified": [], "prioritized": [],
             "drafts": [], "review_decisions": [], "final_actions": []}
    out = asyncio.run(summarize(state, openai_client=FailingClient(), model="m"))
    assert "概览" in out["summary"]
    assert "errors" in out
    assert "gateway down" in out["errors"][0]


def test_summarize_empty_response_falls_back():
    class EmptyClient:
        class _Chat:
            class _Comp:
                async def create(self, **kwargs):
                    class R:
                        choices = [type("C", (), {
                            "message": type("M", (), {"content": ""})(),
                        })()]
                    return R()
            completions = _Comp()
        chat = _Chat()

    state = {"inbox": [_make_email("a")], "classified": [], "prioritized": [],
             "drafts": [], "review_decisions": [], "final_actions": []}
    out = asyncio.run(summarize(state, openai_client=EmptyClient(), model="m"))
    # Falls back to deterministic summary
    assert "概览" in out["summary"]
    assert "errors" in out


def test_summarize_single_reply_returns_empty_no_llm_call():
    """single_reply scopes to one email — a "今日摘要" bubble would be
    misleading. Summarize must return empty AND not call the LLM."""
    class TrackingClient:
        def __init__(self):
            self.called = False

        class _Chat:
            def __init__(self, parent):
                self.parent = parent

                class _Comp:
                    def __init__(self, p):
                        self.parent = p

                    async def create(self, **kwargs):
                        self.parent.called = True
                        raise AssertionError("should not be called")

                self.completions = _Comp(parent)

        def __post_init__(self):
            self.chat = self._Chat(self)

    client = TrackingClient()
    client.chat = TrackingClient._Chat(client)

    state = {
        "task": "single_reply",
        "inbox": [_make_email("m1")],
        "classified": [_ce("m1")],
        "prioritized": [_ce("m1")],
        "drafts": [], "review_decisions": [], "final_actions": [],
    }
    out = asyncio.run(summarize(state, openai_client=client, model="m"))
    assert out == {"summary": ""}
    assert client.called is False


# ─── Graph compilation ──────────────────────────────────────────────────────


def test_build_graph_compiles_with_in_memory_checkpointer():
    """Sanity: the graph wires up correctly with all dependencies provided."""
    from langgraph.checkpoint.memory import InMemorySaver

    from _graph import build_graph

    class FakeLLM:
        pass

    class FakeOpenAIClient:
        pass

    app = build_graph(
        checkpointer=InMemorySaver(),
        provider=FakeProvider(),
        llm=FakeLLM(),
        openai_client=FakeOpenAIClient(),
        model="@Makers/test",
    )
    # If we got here without exception, the graph compiled successfully.
    # Verify the app exposes the expected interface.
    assert hasattr(app, "astream")
    assert hasattr(app, "aget_state")


def test_graph_runs_pipeline_through_summarize_with_no_inbox():
    """End-to-end pipeline with a provider returning no emails."""
    from langgraph.checkpoint.memory import InMemorySaver
    from _graph import build_graph

    async def _run():
        app = build_graph(
            checkpointer=InMemorySaver(),
            provider=FakeProvider(),
            llm=None,
            openai_client=None,
            model="@Makers/test",
        )
        config = {"configurable": {"thread_id": "t1"}}
        # No inbox → no classify call needed (classify guards), no draft loop.
        # summarize will hit the LLM with openai_client=None → fallback.
        final = await app.ainvoke({"task": "triage_only", "user_rules": []}, config=config)
        return final

    result = asyncio.run(_run())
    assert "summary" in result
    assert "概览" in result["summary"]
