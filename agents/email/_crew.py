"""CrewAI Crew assembly — the email draft sub-pipeline.

The ``draft`` LangGraph node calls ``build_email_draft_crew(...)`` once per
email needing a reply, then runs ``crew.kickoff(inputs={...})`` inside
``asyncio.to_thread``.

This module is a thin adapter between the LangGraph node (which provides
per-email data) and the @CrewBase crew definition (which expects YAML
variables to be filled via ``kickoff(inputs={...})``).

The @CrewBase class lives in ``_crews/email_draft_crew/email_draft_crew.py``
and follows the same pattern as the platform's crewai-planner-python template.
"""
from __future__ import annotations

from typing import Any

from _models import ClassifiedEmail, UserRulesBundle


def _llm_model(llm: Any) -> str | None:
    """Best-effort model name from the LLM object (or None if unavailable)."""
    model = getattr(llm, "model", None)
    if isinstance(model, str) and model.strip():
        return model
    return None


def _shorten(text: str, limit: int = 4000) -> str:
    """Trim very long bodies before stuffing into a prompt."""
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…(truncated)"


def build_email_draft_crew(
    llm: Any,
    *,
    classified: ClassifiedEmail,
    rules: UserRulesBundle,
    regenerate_feedback: str | None = None,
) -> tuple[Any, dict[str, str]]:
    """Build the EmailDraftCrew and compute the kickoff inputs dict.

    Returns:
        A tuple of (crew_instance, inputs_dict). The caller should run:
            crew_instance.kickoff(inputs=inputs_dict)

    This keeps the LangGraph node clean: it doesn't need to know about
    YAML variable names or pre-processing logic.
    """
    from _crews.email_draft_crew.email_draft_crew import EmailDraftCrew

    email = classified.email
    fallback_subject = f"Re: {email.subject}" if email.subject else "Re: (no subject)"

    # Build the inputs dict that maps to {variables} in tasks.yaml
    feedback_section = ""
    if regenerate_feedback and regenerate_feedback.strip():
        feedback_section = (
            "\nUSER FEEDBACK ON THE PREVIOUS DRAFT (highest priority — apply it):\n"
            f"  >>> {regenerate_feedback.strip()} <<<\n"
        )

    inputs: dict[str, str] = {
        # analyze_task variables
        "email_sender": email.sender or "",
        "email_subject": email.subject or "",
        "email_body": _shorten(email.body_text),
        "email_thread_id": email.thread_id or "(none)",
        "has_ics": "yes" if email.has_ics else "no",
        "category": classified.category,
        "reason": classified.reason or "",
        # draft_task variables
        "language": rules.language,
        "feedback_section": feedback_section,
        # polish_task variables
        "email_id": email.id,
        "reply_subject": fallback_subject,
        "default_tone": rules.default_tone,
        "signature": rules.signature,
    }

    crew_instance = EmailDraftCrew(model=_llm_model(llm)).crew()
    return crew_instance, inputs
