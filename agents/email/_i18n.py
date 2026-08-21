"""Backend i18n for user-visible strings (SSE narration, labels, previews).

The frontend sends ``locale`` ("zh" | "en") in the /email/run and
/email/review request bodies; run.py stores it in the LangGraph state and
every node looks its strings up here via ``tr(locale, key, **kwargs)``.

Default locale is "zh" so direct unit-test calls (whose state dicts carry
no ``locale``) and local CLI runs keep the previous behavior.
"""
from __future__ import annotations

DEFAULT_LOCALE = "zh"
VALID_LOCALES = ("zh", "en")

# locale → natural-language name injected into LLM prompts ("Reply in …").
LANGUAGE_NAME = {"zh": "Simplified Chinese", "en": "English"}


def normalize_locale(value: object) -> str:
    """Coerce an arbitrary request-body value into a valid locale."""
    return value if value in VALID_LOCALES else DEFAULT_LOCALE


_STRINGS: dict[str, dict[str, str]] = {
    "zh": {
        # ── fetch ──
        "fetch_cached": "⚡ 复用缓存的 {n} 封邮件 (跳过抓取)",
        "fetch_started": "📥 正在从邮箱拉取最新邮件…",
        "fetch_done": "📥 拉取完成 · {n} 封待分类",
        "fetch_archived": " · 自动归档 {n} 封",
        # ── classify ──
        "classify_cached": "⚡ 复用缓存的分类结果 (跳过 LLM)",
        "classify_started": "🧠 LLM 正在分类 {n} 封邮件… (单次批量调用)",
        "classify_failed": "❌ 分类失败:{err}",
        "classify_unparsed": "❌ 分类输出无法解析",
        "classify_done": "✅ 分类完成 · {n} 封已贴标签",
        # ── prioritize ──
        "prioritize_started": "📊 应用规则与排序…",
        "prioritize_done": "📊 排序完成 · 待处理 {n} 封",
        "prioritize_empty": "📊 排序完成 · 没有需要回复的",
        "prioritize_target_missing": (
            "指定的邮件 {id} 不在当前收件箱里 — 缓存可能过期,试试上方「强制刷新」"
        ),
        # ── draft ──
        "draft_started": "🤖 三人小组开始为「{subject}」起草回复",
        "draft_started_feedback": " · 应用了你的修改建议",
        "no_subject": "(无主题)",
        "draft_error": "❌ Crew 报错:{err}",
        "draft_done": "✅ 草稿就绪 · {n} 字 · 等你审批",
        "placeholder_body": (
            "(草稿生成失败 — LLM 没拿到有效的邮件上下文。请点 ↻ 重写,或检查 "
            "_tasks.py / _crew.py 的 inputs 传递是否完整。)"
        ),
        # ── CrewProgressBridge narration ──
        "agent_analyst": "🔍 分析师在读邮件",
        "agent_writer": "✍️ 撰稿员在起草",
        "agent_polisher": "🎨 润色员在调整语气",
        "task_analyze": "分析邮件意图",
        "task_draft": "草拟回复正文",
        "task_polish": "应用语气与签名",
        "step_prefix": "步骤:{label}",
        "complete_prefix": "完成:{label}",
        "task_fallback": "(任务)",
        # ── summarize ──
        "summarize_started": "📝 LLM 正在生成日报… (基于 {n} 条决策)",
        "summarize_failed": "⚠ 摘要生成失败,使用降级模板:{err}",
        "summarize_empty": "⚠ LLM 返回空摘要,使用降级模板",
        "summarize_done": "✅ 日报生成完成 · {n} 字",
        # ── fallback summary ──
        "fb_no_mail": "## 概览\n\n今日无新邮件。",
        "fb_overview": "## 概览",
        "fb_inbox_total": "- 收件箱总数:{n}",
        "fb_classified": "- 已分类:{n} 封",
        "fb_drafted": "- 已生成草稿:{n} 封",
        "fb_decisions": "- 决策数:{n}",
        "fb_actions": "- 已执行动作:{n}",
        "fb_attention": "## 需要关注的",
        "fb_decided": "## 本次决定",
        # ── run.py task labels ──
        "task_triage_only": "仅分类邮件",
        "task_daily_digest": "处理待回邮件",
        "task_single_reply": "单独处理某封邮件",
        "draft_preview_prefix": "📨 请审批: {subject}",
        # ── review.py decision labels ──
        "review_approve": "✓ 通过",
        "review_edit": "✏️ 用我改的版本",
        "review_reject": "✗ 不回复",
        "review_regenerate": "↻ 重写",
        "review_skip": "↦ 跳过",
        "review_edited_body": "(改了正文)",
    },
    "en": {
        # ── fetch ──
        "fetch_cached": "⚡ Reusing {n} cached emails (fetch skipped)",
        "fetch_started": "📥 Fetching latest emails from the mailbox…",
        "fetch_done": "📥 Fetched · {n} emails to classify",
        "fetch_archived": " · {n} auto-archived",
        # ── classify ──
        "classify_cached": "⚡ Reusing cached classification (LLM skipped)",
        "classify_started": "🧠 LLM classifying {n} emails… (single batch call)",
        "classify_failed": "❌ Classification failed: {err}",
        "classify_unparsed": "❌ Failed to parse classification output",
        "classify_done": "✅ Classified · {n} emails labeled",
        # ── prioritize ──
        "prioritize_started": "📊 Applying rules and sorting…",
        "prioritize_done": "📊 Sorted · {n} to process",
        "prioritize_empty": "📊 Sorted · nothing needs a reply",
        "prioritize_target_missing": (
            "Email {id} is not in the current inbox — the cache may be stale, "
            "try 'Force Refresh' above"
        ),
        # ── draft ──
        "draft_started": "🤖 Crew starting a reply draft for '{subject}'",
        "draft_started_feedback": " · your feedback applied",
        "no_subject": "(no subject)",
        "draft_error": "❌ Crew error: {err}",
        "draft_done": "✅ Draft ready · {n} chars · awaiting your review",
        "placeholder_body": (
            "(Draft generation failed — the LLM didn't receive valid email "
            "context. Click ↻ Rewrite, or check the inputs wiring in "
            "_tasks.py / _crew.py.)"
        ),
        # ── CrewProgressBridge narration ──
        "agent_analyst": "🔍 Analyst reading the email",
        "agent_writer": "✍️ Writer drafting the reply",
        "agent_polisher": "🎨 Polisher adjusting the tone",
        "task_analyze": "Analyzing email intent",
        "task_draft": "Drafting the reply body",
        "task_polish": "Applying tone and signature",
        "step_prefix": "Step: {label}",
        "complete_prefix": "Done: {label}",
        "task_fallback": "(task)",
        # ── summarize ──
        "summarize_started": "📝 LLM generating the digest… (based on {n} decisions)",
        "summarize_failed": "⚠ Digest generation failed, using fallback template: {err}",
        "summarize_empty": "⚠ LLM returned an empty digest, using fallback template",
        "summarize_done": "✅ Digest ready · {n} chars",
        # ── fallback summary ──
        "fb_no_mail": "## Overview\n\nNo new emails today.",
        "fb_overview": "## Overview",
        "fb_inbox_total": "- Inbox total: {n}",
        "fb_classified": "- Classified: {n}",
        "fb_drafted": "- Drafts generated: {n}",
        "fb_decisions": "- Decisions: {n}",
        "fb_actions": "- Actions executed: {n}",
        "fb_attention": "## Needs Attention",
        "fb_decided": "## Decisions",
        # ── run.py task labels ──
        "task_triage_only": "Classify emails only",
        "task_daily_digest": "Process emails needing replies",
        "task_single_reply": "Process a single email",
        "draft_preview_prefix": "📨 For review: {subject}",
        # ── review.py decision labels ──
        "review_approve": "✓ Approve",
        "review_edit": "✏️ Use my edit",
        "review_reject": "✗ No reply",
        "review_regenerate": "↻ Rewrite",
        "review_skip": "↦ Skip",
        "review_edited_body": "(body edited)",
    },
}


def tr(locale: str, key: str, **kwargs) -> str:
    """Look up ``key`` in the locale table and format with ``kwargs``.

    Unknown keys fall back to the key itself (so a missing translation is
    visible but not fatal); unknown locales fall back to the default.
    """
    table = _STRINGS.get(locale) or _STRINGS[DEFAULT_LOCALE]
    text = table.get(key) or _STRINGS[DEFAULT_LOCALE].get(key) or key
    if kwargs:
        text = text.format(**kwargs)
    return text
