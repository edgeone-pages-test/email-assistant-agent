"""LLM factory — bridges the platform AI Gateway to both frameworks.

The template uses two LLM client types depending on context:

  - ``CrewAI LLM`` (``get_crewai_llm``) — inside the ``_crew.EmailDraftCrew``
    sub-pipeline. CrewAI 1.14+ requires ``provider="openai"`` to bypass the
    LiteLLM dispatch (LiteLLM is not installed in the platform image; see
    marketing template ``_llm.py`` comments for details).

  - ``openai.AsyncOpenAI`` (``get_openai_client``) — inside the LangGraph
    nodes (classify / summarize) where we want a direct chat completion
    without CrewAI's task/agent abstraction.

Both share the same env vars:

  - ``AI_GATEWAY_API_KEY``
  - ``AI_GATEWAY_BASE_URL``

The default model matches the sibling templates so platform-wide
model strategy stays unified.

Imports are deferred so unit tests that only touch parsing / state don't
pull in ``crewai`` or ``openai`` (heavy install).
"""
from __future__ import annotations

from typing import Any, Mapping


REQUIRED_ENV = ("AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL")

# Default model — overridable via AI_GATEWAY_MODEL env var. Falls back to the
# platform's built-in free model when the variable isn't set.
_FALLBACK_MODEL = "@makers/deepseek-v4-flash"
DEFAULT_MODEL = _FALLBACK_MODEL  # resolved at runtime in get_env()

GATEWAY_HEADERS: dict[str, str] = {}


# ─── Module-level singletons ────────────────────────────────────────────────
#
# Why singletons? See sibling reference templates
# (langgraph-quiz-python / crewai-planner-python): both lazy-init their LLM
# at module level on the FIRST request and reuse for every subsequent
# request. This avoids the cost of re-creating clients per request AND
# (more importantly) ensures the LLM the LangGraph compiled-graph captured
# at compile time is the SAME instance handed to all later requests.
#
# Reset on env change is handled by tracking the env "fingerprint" — if
# the gateway URL or key change, we rebuild. Tests can reset via reset_singletons().

_crewai_llm_singleton: Any = None
_openai_client_singleton: Any = None
_singleton_env_fingerprint: tuple[str, str] | None = None


def _env_fingerprint(env: Mapping[str, str]) -> tuple[str, str]:
    return (env.get("AI_GATEWAY_API_KEY", ""), env.get("AI_GATEWAY_BASE_URL", ""))


def reset_singletons() -> None:
    """Clear cached LLM instances. Tests use this between cases."""
    global _crewai_llm_singleton, _openai_client_singleton, _singleton_env_fingerprint
    _crewai_llm_singleton = None
    _openai_client_singleton = None
    _singleton_env_fingerprint = None


def get_env(context_env: Mapping[str, str] | None) -> dict[str, str]:
    """Validate and extract required env vars from ``context.env``.

    Also reads the optional ``AI_GATEWAY_MODEL`` and updates the module-level
    ``DEFAULT_MODEL`` so all callers pick up the user's preferred model without
    needing to pass it through every layer.
    """
    global DEFAULT_MODEL
    source = dict(context_env or {})
    missing = [k for k in REQUIRED_ENV if not (source.get(k) or "").strip()]
    if missing:
        raise RuntimeError(f"Missing environment variables: {', '.join(missing)}")
    # Optional model override
    model_override = (source.get("AI_GATEWAY_MODEL") or "").strip()
    if model_override:
        DEFAULT_MODEL = model_override
    else:
        DEFAULT_MODEL = _FALLBACK_MODEL
    return {k: source[k] for k in REQUIRED_ENV}


def _ensure_singletons_for(env: Mapping[str, str]) -> None:
    """Reset singletons if the env fingerprint has changed."""
    global _singleton_env_fingerprint
    fp = _env_fingerprint(env)
    if _singleton_env_fingerprint != fp:
        reset_singletons()
        _singleton_env_fingerprint = fp


def get_crewai_llm(
    env: Mapping[str, str],
    *,
    model: str = DEFAULT_MODEL,
    temperature: float = 0.3,
    timeout: int = 300,
    extra_headers: dict[str, str] | None = None,
) -> Any:
    """CrewAI ``LLM`` bound to AI Gateway. Module-level singleton — first call
    initializes from env, subsequent calls return the cached instance.

    Used inside ``_crew.EmailDraftCrew`` for the three-role draft pipeline.
    See sibling template ``_llm.py`` for the rationale of ``provider='openai'``.
    """
    global _crewai_llm_singleton
    _ensure_singletons_for(env)
    if _crewai_llm_singleton is not None:
        return _crewai_llm_singleton

    from crewai import LLM  # deferred — keep parsing tests light

    headers = dict(GATEWAY_HEADERS)
    if extra_headers:
        headers.update(extra_headers)
    _crewai_llm_singleton = LLM(
        model=model,
        provider="openai",
        api_key=env["AI_GATEWAY_API_KEY"],
        base_url=env["AI_GATEWAY_BASE_URL"],
        default_headers=headers,
        temperature=temperature,
        timeout=timeout,
        # Token-by-token streaming. CrewAI publishes each chunk on its event
        # bus (``LLMStreamChunkEvent``), which ``_events.CrewProgressBridge``
        # subscribes to and forwards to the LangGraph custom-stream channel
        # — letting the frontend render the draft body as it's written
        # instead of waiting 20-30s for the full polish cycle. Doesn't change
        # CrewAI's internal task semantics; ``TaskCompletedEvent`` still fires
        # only after the LLM finishes.
        stream=True,
    )
    return _crewai_llm_singleton


def get_openai_client(
    env: Mapping[str, str],
    *,
    extra_headers: dict[str, str] | None = None,
) -> Any:
    """Direct ``openai.AsyncOpenAI`` client for LangGraph nodes. Module-level
    singleton — first call initializes, subsequent calls return cached.

    Used by ``_nodes.classify`` / ``_nodes.summarize`` for batch chat calls.
    """
    global _openai_client_singleton
    _ensure_singletons_for(env)
    if _openai_client_singleton is not None:
        return _openai_client_singleton

    from openai import AsyncOpenAI  # deferred

    headers = dict(GATEWAY_HEADERS)
    if extra_headers:
        headers.update(extra_headers)
    _openai_client_singleton = AsyncOpenAI(
        api_key=env["AI_GATEWAY_API_KEY"],
        base_url=env["AI_GATEWAY_BASE_URL"],
        default_headers=headers,
    )
    return _openai_client_singleton
