"""CrewAI event-bus → LangGraph custom-stream bridge.

The ``draft`` node hands the heavy lifting to a CrewAI ``Crew`` running inside
``asyncio.to_thread`` (because ``Crew.kickoff`` is blocking). CrewAI publishes
lifecycle events on its own bus while running, but those events fire **on the
worker thread** — calling ``writer(...)`` from there is not safe (writer
captures contextvars from the main loop).

This module provides ``CrewProgressBridge`` — a context manager that:

  1. Subscribes to ``TaskStartedEvent`` / ``TaskCompletedEvent`` /
     ``AgentExecutionStartedEvent`` on the CrewAI bus.
  2. When an event fires (worker thread), schedules the writer call via
     ``loop.call_soon_threadsafe`` so the actual write happens on the main
     event loop where contextvars are valid.
  3. Translates CrewAI's English event names into Chinese-narration payloads
     the frontend can render verbatim.

Usage (inside the ``draft`` node):

    writer = get_stream_writer()
    loop = asyncio.get_running_loop()
    with CrewProgressBridge(loop, writer, email_subject=ce.email.subject):
        out = await asyncio.to_thread(crew.kickoff)

The bridge auto-unsubscribes on exit so a Crew that runs after this one
won't see stale handlers from previous calls.
"""
from __future__ import annotations

import asyncio
from typing import Any, Callable

from _i18n import tr


# CrewAI's canonical role strings → i18n key for the friendly label + emoji
# shown in the live-progress chip on the frontend. Falls back to the raw role
# name when an unknown agent reports in (so adding a fourth role doesn't break
# the bridge — it just shows the English name).
_AGENT_LABEL_KEY: dict[str, str] = {
    "Email Triage Analyst": "agent_analyst",
    "Reply Writer": "agent_writer",
    "Voice Polisher": "agent_polisher",
}


# Map CrewAI Task.name (set in _tasks.py) → i18n key for the phase label.
# Used for TaskStartedEvent / TaskCompletedEvent narrations. Must mirror the
# names in _tasks.py — keep both in sync if you rename a task.
_TASK_LABEL_KEY: dict[str, str] = {
    "analyze_task": "task_analyze",
    "draft_task": "task_draft",
    "polish_task": "task_polish",
}


def _agent_role(source: Any, event: Any) -> str:
    """Best-effort extract of the agent's role string from a CrewAI event.

    CrewAI's event objects expose ``agent`` directly on most lifecycle events;
    when not present, fall back to ``source`` (often the Agent instance) or
    the source class name. Never raises — the bridge is best-effort.
    """
    for cand in (getattr(event, "agent", None), getattr(source, "agent", None), source):
        role = getattr(cand, "role", None)
        if isinstance(role, str) and role:
            return role
    return type(source).__name__


def _task_name(source: Any, event: Any) -> str:
    """Best-effort extract of the Task name (string) from a CrewAI event."""
    for cand in (getattr(event, "task", None), getattr(source, "task", None), source):
        name = getattr(cand, "name", None)
        if isinstance(name, str) and name:
            return name
    return ""


class CrewProgressBridge:
    """Subscribe to CrewAI lifecycle events and forward them to a stream writer.

    Designed to be used as a context manager inside a LangGraph node. The
    writer must be obtained via ``get_stream_writer()`` BEFORE entering the
    context (so the writer captures the right contextvars from the main
    event loop).

    All forwarded payloads have the shape:
        {"phase": "draft", "stage": "...", "agent": "...", "message": "..."}

    The frontend keys off ``phase`` to update the right pipeline-stage chip
    and ``message`` for the live narration text under the chip.
    """

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        writer: Callable[[dict], None],
        *,
        email_subject: str = "",
        locale: str = "zh",
    ) -> None:
        self._loop = loop
        self._writer = writer
        self._subject = (email_subject or "").strip()
        self._locale = locale
        # Hold strong references to the registered handlers so CrewAI's bus
        # doesn't garbage-collect them mid-run (the bus uses weak refs in
        # some versions — a stale local would silently stop firing).
        self._handlers: list[Any] = []
        # ``_unsubscribers`` collects callables returned by the bus's
        # ``on(...)`` decorator (CrewAI 1.x exposes these). Used in __exit__.
        self._unsubscribers: list[Callable[[], None]] = []
        # Tracks which task is currently producing LLM output. We only
        # forward token chunks during ``draft_task`` (the writer agent's
        # markdown body) — analyze_task is internal context the user
        # doesn't need to see, and polish_task emits a JSON envelope which
        # is useless to stream. Updated by TaskStartedEvent / TaskCompletedEvent.
        self._current_task: str = ""
        # Tracks which task is currently producing LLM output. We only
        # forward token chunks during ``draft_task`` (the writer agent's
        # markdown body) — analyze_task is internal context the user
        # doesn't need to see, and polish_task emits a JSON envelope which
        # is useless to stream. Updated by TaskStartedEvent / TaskCompletedEvent.
        self._current_task: str = ""

    # ─── helpers ────────────────────────────────────────────────────────────

    def _trim_subject(self, limit: int = 32) -> str:
        """Shorten the email subject for inline narration ("…正在为 'Re: …'")."""
        if not self._subject:
            return ""
        return (
            self._subject if len(self._subject) <= limit else self._subject[:limit] + "…"
        )

    def _emit(self, payload: dict) -> None:
        """Schedule a ``writer(payload)`` call on the main loop.

        Called from the CrewAI worker thread. Must NEVER touch the writer
        directly from this thread — call_soon_threadsafe is the gateway.
        """
        try:
            self._loop.call_soon_threadsafe(self._writer, payload)
        except RuntimeError:
            # Loop already closed (e.g. SSE consumer disconnected) — drop
            # the event silently. The crew will finish on its own; the
            # main loop just won't hear about it.
            pass

    # ─── context manager ────────────────────────────────────────────────────

    def __enter__(self) -> "CrewProgressBridge":
        # CrewAI 1.x relocated the events module: 1.0/1.1 had it under
        # ``crewai.utilities.events`` but 1.14+ lives at ``crewai.events``.
        # We try the new path first, fall back to the old one for
        # back-compat, and ONLY swallow ImportError (a blanket Exception
        # catch here would silently mask runtime bugs in the bridge —
        # exactly how the 1.x rename caused per-agent narration + draft
        # token streaming to silently no-op for several iterations).
        try:
            from crewai.events import (  # type: ignore
                AgentExecutionStartedEvent,
                LLMStreamChunkEvent,
                TaskCompletedEvent,
                TaskStartedEvent,
                crewai_event_bus,
            )
        except ImportError:
            try:
                from crewai.utilities.events import (  # type: ignore
                    AgentExecutionStartedEvent,
                    LLMStreamChunkEvent,
                    TaskCompletedEvent,
                    TaskStartedEvent,
                    crewai_event_bus,
                )
            except ImportError as exc:
                # Truly no crewai bus available (e.g. running unit tests
                # without crewai installed). Bridge becomes a no-op and
                # we surface the cause so devs see WHY narration is
                # missing instead of mysteriously getting silence.
                print(
                    f"[CrewProgressBridge] crewai events module unavailable: "
                    f"{exc} — draft narration + token streaming disabled",
                    flush=True,
                )
                return self

        subj_suffix = f" · {self._trim_subject()}" if self._subject else ""

        # NOTE: each ``@crewai_event_bus.on(...)`` returns the wrapped function;
        # we keep references to prevent garbage collection.

        @crewai_event_bus.on(AgentExecutionStartedEvent)
        def _on_agent_start(source, event):  # noqa: ARG001 — CrewAI calls (source, event)
            role = _agent_role(source, event)
            key = _AGENT_LABEL_KEY.get(role)
            label = tr(self._locale, key) if key else role
            self._emit({
                "phase": "draft",
                "stage": "agent_start",
                "agent": role,
                "message": f"{label}{subj_suffix}",
            })

        @crewai_event_bus.on(TaskStartedEvent)
        def _on_task_start(source, event):  # noqa: ARG001
            tname = _task_name(source, event)
            # Track the active task so the LLMStreamChunkEvent handler knows
            # whether to forward chunks. Set BEFORE emitting the progress
            # event so the very first token chunk (which can race the
            # progress event by a few ms) is correctly attributed.
            self._current_task = tname
            key = _TASK_LABEL_KEY.get(tname)
            label = tr(self._locale, key) if key else (tname or tr(self._locale, "task_fallback"))
            self._emit({
                "phase": "draft",
                "stage": "task_start",
                "task": tname,
                "message": tr(self._locale, "step_prefix", label=label),
            })

        @crewai_event_bus.on(TaskCompletedEvent)
        def _on_task_complete(source, event):  # noqa: ARG001
            tname = _task_name(source, event)
            key = _TASK_LABEL_KEY.get(tname)
            label = tr(self._locale, key) if key else (tname or tr(self._locale, "task_fallback"))
            # Clear the active-task marker so any stray late-arriving chunks
            # from this task don't get emitted (we already showed the user
            # the full output via the token stream).
            if self._current_task == tname:
                self._current_task = ""
            self._emit({
                "phase": "draft",
                "stage": "task_complete",
                "task": tname,
                "message": tr(self._locale, "complete_prefix", label=label),
            })

        @crewai_event_bus.on(LLMStreamChunkEvent)
        def _on_llm_chunk(source, event):  # noqa: ARG001
            # Forward token chunks ONLY during draft_task. analyze_task is
            # internal scratch (the user doesn't need to see the analyst
            # mumbling about "the customer is asking for a price decision"),
            # and polish_task is JSON ({"email_id":"...","body":"..."}) which
            # would render as ugly raw JSON. The writer agent's draft_task
            # output is plain markdown — exactly what the user wants to
            # watch unfold in real time.
            if self._current_task != "draft_task":
                return
            # CrewAI 1.14+ exposes the delta on ``event.chunk``. Fall back
            # to other plausible attribute names for forward-compat with
            # 1.x bumps.
            chunk = (
                getattr(event, "chunk", None)
                or getattr(event, "content", None)
                or getattr(event, "delta", None)
                or ""
            )
            if not isinstance(chunk, str) or not chunk:
                return
            self._emit({
                "phase": "draft",
                "stage": "token",
                "delta": chunk,
            })

        self._handlers.extend([
            _on_agent_start, _on_task_start, _on_task_complete, _on_llm_chunk,
        ])
        # One-time diagnostic. Confirms in dev logs that the bridge wired up
        # AND that the crewai event bus is reachable. If you see this line
        # but no per-agent narration appearing in the UI, something else is
        # wrong (e.g. LLM singleton was created with stream=False before a
        # process restart — see _llm.py).
        print(
            f"[CrewProgressBridge] subscribed to {len(self._handlers)} CrewAI events "
            f"(agent_start, task_start, task_complete, llm_chunk)",
            flush=True,
        )
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ARG002 — protocol signature
        # Best-effort cleanup. CrewAI 1.x's event bus keeps handlers in a
        # module-level dict; clearing our local refs is enough for the bus's
        # weakref version, but explicit unsubscribe wins where supported.
        for unsub in self._unsubscribers:
            try:
                unsub()
            except Exception:
                pass
        self._handlers.clear()
        self._unsubscribers.clear()
