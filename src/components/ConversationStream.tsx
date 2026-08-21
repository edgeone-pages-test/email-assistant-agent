/**
 * ConversationStream — center column.
 *
 * Renders the timeline of pipeline events as conversation messages:
 *   - 系统 events (state_update per node) collapse into terse one-liners
 *   - human_review_required surfaces the DraftReviewCard inline
 *   - user decisions echo back as "user" messages (✓ 通过 / ↻ 重写 / ...)
 *   - errors surface in red
 *   - the final summary is rendered with markdown-friendly preformatted style
 *
 * Owns auto-scroll: when a new message arrives, scrolls the container to
 * the bottom unless the user has manually scrolled up (then the pin is
 * paused until they reach the bottom again).
 */
import { ReactNode, useEffect, useRef, useState } from 'react';
import { tokens } from '../design-tokens';
import { useI18n, type TranslationKey } from '../i18n';
import { Icon, IconName, IconSpinner } from '../icons';
import { DraftItem, ProgressPayload, ReviewDecisionInput } from '../types';
import DraftReviewCard from './DraftReviewCard';

export type StreamMessageKind =
  | 'system'      // pipeline narration (e.g. "拉取了 10 封邮件")
  | 'pipeline'    // per-node state_update
  | 'review'      // DraftReviewCard inline
  | 'decision'    // user's submit echo
  | 'summary'     // final digest
  | 'error'       // backend-side error
  | 'session';    // first-frame session info

export interface StreamMessage {
  id: string;
  kind: StreamMessageKind;
  /** Wall-clock timestamp (ms since epoch). */
  ts: number;
  /** Plain-text body. May be empty for messages that render their own ui. */
  text?: string;
  /** Free-form payload — referenced by kind-specific renderers. */
  payload?: unknown;
}

interface Props {
  messages: StreamMessage[];
  pendingDraft?: { draft: DraftItem; remaining: number } | null;
  onSubmitDecision?: (d: ReviewDecisionInput) => void;
  /** Disable the inline DraftReviewCard buttons. */
  decisionDisabled?: boolean;
  /** Live narration from the latest ``progress`` SSE frame. Renders as a
   * sticky pill anchored to the bottom of the timeline so the user sees
   * what the backend is doing during long stages (classify ~10s, draft
   * ~20-30s). Null when no run is in flight. */
  progress?: ProgressPayload | null;
  /** Token-by-token LLM output for ``draft`` or ``summarize``. Renders as
   * a "live writing" bubble inline in the message stream — users watch
   * the markdown / draft body materialize in real time. The bubble is
   * replaced by a real timeline message once the phase completes (done
   * event for summary; human_review_required for draft). */
  streamingText?: { phase: 'summarize' | 'draft'; text: string } | null;
  /** True while App.tsx is hydrating a previously-stored conversation. */
  restoring?: boolean;
  /** Current email provider detected from backend: 'mock' | 'imap' | 'gmail'.
   * Drives the data-source indicator on the OnboardingPanel. */
  emailProvider?: string;
}

export default function ConversationStream({
  messages,
  pendingDraft,
  onSubmitDecision,
  decisionDisabled,
  progress,
  streamingText,
  restoring,
  emailProvider,
}: Props) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);

  // Plain messages: only auto-scroll if the user hasn't manually scrolled up.
  useEffect(() => {
    if (!pinnedToBottom || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pinnedToBottom]);

  // Token streaming changes the bubble height several times per second —
  // re-pin to bottom on every text update so the cursor stays in view.
  // Only honours the user's manual scroll-up via the same ``pinnedToBottom``
  // gate, so they can scroll back to read older messages without fighting us.
  useEffect(() => {
    if (!pinnedToBottom || !scrollRef.current) return;
    if (!streamingText) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [streamingText?.text.length, streamingText?.phase, pinnedToBottom]);

  // Token streaming changes the bubble height several times per second —
  // re-pin to bottom on every text update so the cursor stays in view.
  // Only honours the user's manual scroll-up via the same ``pinnedToBottom``
  // gate, so they can scroll back to read older messages without fighting us.
  useEffect(() => {
    if (!pinnedToBottom || !scrollRef.current) return;
    if (!streamingText) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [streamingText?.text.length, streamingText?.phase, pinnedToBottom]);

  // Streaming text grows token-by-token — keep the view pinned to the
  // bottom on each delta so the user watches the words flow in. Same
  // pinned-to-bottom courtesy as message scroll: if they scrolled up to
  // re-read something, we don't yank them back down.
  useEffect(() => {
    if (!pinnedToBottom || !scrollRef.current) return;
    if (!streamingText) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [streamingText?.text, streamingText?.phase, pinnedToBottom]);

  // New pending draft: ALWAYS bring the review card into view, regardless of
  // the user's current scroll position. They need to see it to make a decision.
  useEffect(() => {
    if (!pendingDraft) return;
    // queue past the React commit so the card has been rendered
    requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [pendingDraft?.draft.email_id]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setPinnedToBottom(atBottom);
  }

  // Restoring takeover: when the parent is hydrating a previously stored
  // conversation, render the skeleton INSTEAD of any other content
  // (messages, OnboardingPanel, pendingDraft, streamingText, progress
  // pill). This is the visual gate that fixes "click a history row →
  // OnboardingPanel flashes for 200ms before content fills in" — the
  // skeleton is shown the whole way through, then atomically replaced
  // by the real timeline once the fetch resolves and ``restoring`` flips
  // back to false.
  if (restoring) {
    return (
      <main style={shell}>
        <RestoringSkeleton />
      </main>
    );
  }

  if (messages.length === 0 && !pendingDraft && !streamingText) {
    return (
      <main style={shell}>
        <OnboardingPanel emailProvider={emailProvider} />
      </main>
    );
  }

  return (
    <main style={shell}>
      <div ref={scrollRef} onScroll={handleScroll} style={stream}>
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
        {/* ── Live LLM token stream ──
            Only one of ``streamingText`` / ``pendingDraft`` is set at any
            given time (App.tsx clears streamingText on human_review_required)
            so they're rendered in the same slot. The bubble stays out of
            the messages array — it's a transient view, replaced by a real
            "summary" message on done, or by DraftReviewCard on pause. */}
        {streamingText && <StreamingBubble streaming={streamingText} />}
        {pendingDraft && onSubmitDecision && (
          <div ref={cardRef} style={inlineCard}>
            <div style={whoLabel}>
              <Icon name="mail" size={12} />
              <span>{t('reviewPendingLabel')}</span>
            </div>
            <DraftReviewCard
              draft={pendingDraft.draft}
              remaining={pendingDraft.remaining}
              onSubmit={onSubmitDecision}
              disabled={decisionDisabled}
            />
          </div>
        )}
      </div>
      {/* Live narration: floats above the bottom of the stream so the user
          sees what's happening RIGHT NOW (e.g. "🧠 LLM 正在分类 10 封邮件…"
          for the 10s classify step, or per-Crew-agent narration during the
          ~25s draft step). Re-renders on every progress event; auto-hides
          when the run ends or pauses. Pointer-events:none so it doesn't
          block clicks on the underlying messages or DraftReviewCard. */}
      {progress && progress.message && <LiveProgressPill progress={progress} />}
    </main>
  );
}

/** Inline "live writing" bubble — renders the streaming LLM output with a
 * blinking cursor at the end. Distinct visual treatment (dashed border +
 * "draft" eyebrow label) so it never gets confused with a settled message.
 *
 * The text is rendered as plain pre-wrap rather than markdown because LLM
 * output during streaming can include partially-formed syntax (an unclosed
 * `**` would otherwise turn the rest of the document bold). The final
 * settled markdown is rendered later via the ``summary`` message kind once
 * the ``done`` event lands. */
function StreamingBubble({
  streaming,
}: {
  streaming: { phase: 'summarize' | 'draft'; text: string };
}) {
  const { t } = useI18n();
  const eyebrow =
    streaming.phase === 'summarize' ? t('streamingSummary') : t('streamingDraft');
  const eyebrowIcon: IconName =
    streaming.phase === 'summarize' ? 'receipt' : 'edit-3';
  return (
    <div style={streamingBubble}>
      <div style={streamingEyebrow}>
        <Icon name={eyebrowIcon} size={11} />
        <span>{eyebrow}</span>
        <IconSpinner size={10} />
      </div>
      <div style={streamingBody}>
        <span>{streaming.text}</span>
        <span style={streamingCursor} aria-hidden>
          ▋
        </span>
      </div>
    </div>
  );
}

function LiveProgressPill({ progress }: { progress: ProgressPayload }) {
  // Pick an accent based on the lifecycle stage — completed / skipped use
  // success green so the user sees a brief "✅ done" before the next phase
  // narrates over it; error uses danger red. Everything else stays brand-tinted.
  const tone = (() => {
    if (progress.stage === 'completed' || progress.stage === 'skipped') {
      return { fg: tokens.color.success, bg: tokens.color.successSoft, bd: '#bbf7d0' };
    }
    if (progress.stage === 'error') {
      return { fg: tokens.color.danger, bg: tokens.color.dangerSoft, bd: '#fecaca' };
    }
    return { fg: tokens.color.brand, bg: tokens.color.brandSoft, bd: tokens.color.brandBorder };
  })();
  const showSpinner =
    progress.stage === 'started' ||
    progress.stage === 'agent_start' ||
    progress.stage === 'task_start';
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        ...progressPillShell,
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.bd}`,
      }}
    >
      {showSpinner ? (
        <IconSpinner size={12} />
      ) : (
        <Icon
          name={progress.stage === 'error' ? 'alert-circle' : 'check-circle'}
          size={12}
        />
      )}
      <span style={progressPillText}>{progress.message}</span>
    </div>
  );
}

/**
 * RestoringSkeleton — placeholder shown while App.tsx hydrates a previously-
 * stored conversation from /email/history. Replaces ALL content (messages,
 * pendingDraft, streamingText, progress pill) for the ~200-500ms fetch
 * window so the user sees a smooth "loading" state instead of either:
 *   (a) the OnboardingPanel briefly appearing and then swapping in the
 *       restored timeline (the bug we're fixing), or
 *   (b) stale messages from the previous session lingering visually.
 *
 * The skeleton mimics the rough shape of MessageRow bubbles (avatar dot +
 * 2-line content block) at varying widths so the eye reads it as "real
 * content arriving" rather than a generic spinner. Uses the global
 * ``shimmer`` keyframe defined in index.css.
 */
function RestoringSkeleton() {
  return (
    <div style={skeletonShell}>
      {[0.85, 0.6, 0.92, 0.55, 0.78].map((widthFrac, i) => (
        <div key={i} style={skeletonRow}>
          <div style={skeletonAvatar} />
          <div style={skeletonBody}>
            <div style={{ ...skeletonBar, width: `${Math.round(widthFrac * 100)}%` }} />
            <div style={{ ...skeletonBar, width: `${Math.round(widthFrac * 70)}%`, opacity: 0.7 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function OnboardingPanel({ emailProvider }: { emailProvider?: string }) {
  const { t } = useI18n();
  const isLive = emailProvider === 'imap' || emailProvider === 'gmail';
  const providerLabel = emailProvider === 'imap' ? t('providerImap') : emailProvider === 'gmail' ? t('providerGmail') : t('providerMock');
  return (
    <div style={onboardingShell}>
      <div style={onboardingInner}>
        <div style={heroPanel}>
          <h2 style={heroTitle}>{t('onboardingTitle')}</h2>
          <p style={heroDesc}>
            {t('onboardingDesc')}
          </p>
        </div>

        {/* Data source status */}
        <div style={dataSourcePanel}>
          <span style={{
            ...dataSourceBadge,
            background: isLive ? tokens.color.successSoft : tokens.color.surface,
            color: isLive ? tokens.color.success : tokens.color.textSubtle,
            border: `1px solid ${isLive ? '#bbf7d0' : tokens.color.border}`,
            alignSelf: 'flex-start',
          }}>
            {isLive ? t('providerLiveBadge', { provider: providerLabel }) : t('providerMockBadge')}
          </span>
          <p style={dataSourceBody}>
            {isLive
              ? t('providerConnected', { provider: providerLabel })
              : t('providerMockDesc')}
          </p>
        </div>

        {/* AI auto-process hint */}
        <div style={aiHintPanel}>
          <Icon name="sparkles" size={13} />
          <span>{t('aiHint')}</span>
        </div>

        {/* Simple 3-step guide */}
        <ol style={steps}>
          <Step icon="inbox" title={t('step1Title')} body={t('step1Body')} />
          <Step icon="edit-3" title={t('step2Title')} body={t('step2Body')} />
          <Step icon="check-circle" title={t('step3Title')} body={t('step3Body')} />
        </ol>
      </div>
    </div>
  );
}

function Step({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <li style={stepRow}>
      <span style={stepBadge} aria-hidden>
        <Icon name={icon} size={14} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={stepTitle}>{title}</div>
        <div style={stepBody}>{body}</div>
      </div>
    </li>
  );
}

function MessageRow({ m }: { m: StreamMessage }) {
  const { t: mt } = useI18n();
  const isUser = m.kind === 'decision';
  return (
    <div style={{ ...row, justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          ...bubble,
          background: KIND_BG[m.kind],
          color: KIND_FG[m.kind],
          borderColor: KIND_BORDER[m.kind],
          // User decisions (approval actions) are narrow chat bubbles on the
          // right. All other message kinds (system, pipeline, summary, etc.)
          // span the full available width so content doesn't look cramped.
          maxWidth: isUser ? '75%' : '100%',
        }}
      >
        <div style={kindLabel}>
          <Icon name={KIND_ICON[m.kind]} size={11} strokeWidth={2} />
          <span>{mt(KIND_LABEL_KEY[m.kind])}</span>
          <span style={ts}>{formatTime(m.ts)}</span>
        </div>
        {m.kind === 'summary' ? (
          <MarkdownBody source={m.text || ''} />
        ) : m.kind === 'pipeline' && m.payload ? (
          <PipelineNarration text={m.text || ''} payload={m.payload as Record<string, unknown>} />
        ) : (
          <div style={textBody}>{m.text}</div>
        )}
      </div>
    </div>
  );
}

function PipelineNarration({
  text,
  payload,
}: {
  text: string;
  payload: Record<string, unknown>;
}) {
  // Show top-level keys of the payload as a compact list ("inbox: 10, classified: 10")
  const summary = Object.entries(payload)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: ${v.length}`;
      if (typeof v === 'string') return `${k}: ${v.length > 40 ? v.slice(0, 40) + '…' : v}`;
      if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`;
      return null;
    })
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <div style={textBody}>{text}</div>
      {summary && <div style={pipelineMeta}>{summary}</div>}
    </>
  );
}

// ─── MarkdownBody — minimal renderer used for the final summary bubble ────
//
// Why not pull in ``react-markdown``? It's ~30 KB gzip and the summary uses
// a tiny subset (## / ### headings, **bold**, lists, inline code, links).
// Hand-rolling keeps ``npm install`` lean — same philosophy as our SVG icon
// set in ``../icons.tsx``.
//
// Supported markdown:
//   - ## h2 / ### h3 (h1 is intentionally not used — bubble is already a
//     section, h1 would compete with the page chrome)
//   - **bold**, `code`, [text](url)
//   - bulleted lists with `- ` or `* `
//   - blank line = paragraph break
//   - any other line = paragraph (single newline within a paragraph is
//     preserved as a soft break via white-space: pre-wrap on the <p>).

function MarkdownBody({ source }: { source: string }) {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];
  let listBuffer: ReactNode[] = [];

  function flushList() {
    if (listBuffer.length === 0) return;
    blocks.push(
      <ul key={`list-${blocks.length}`} style={mdList}>
        {listBuffer}
      </ul>,
    );
    listBuffer = [];
  }

  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('### ')) {
      flushList();
      blocks.push(
        <h3 key={i} style={mdH3}>
          {renderInlineMd(line.slice(4))}
        </h3>,
      );
    } else if (line.startsWith('## ')) {
      flushList();
      blocks.push(
        <h2 key={i} style={mdH2}>
          {renderInlineMd(line.slice(3))}
        </h2>,
      );
    } else if (line.match(/^[\-*]\s+/)) {
      listBuffer.push(
        <li key={`li-${i}`} style={mdLi}>
          {renderInlineMd(line.replace(/^[\-*]\s+/, ''))}
        </li>,
      );
    } else if (line === '') {
      flushList();
      // skip — block separator
    } else {
      flushList();
      blocks.push(
        <p key={i} style={mdP}>
          {renderInlineMd(line)}
        </p>,
      );
    }
  });
  flushList();

  return <div style={mdRoot}>{blocks}</div>;
}

/** Inline markdown: handles **bold**, `code`, [text](url) with one regex pass. */
function renderInlineMd(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  // Capture groups: 1=code, 2=bold, 3=link text, 4=link url
  const regex = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push(text.slice(lastIndex, m.index));
    }
    if (m[1] !== undefined) {
      parts.push(
        <code key={`md-${key++}`} style={mdCode}>
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      parts.push(<strong key={`md-${key++}`}>{m[2]}</strong>);
    } else if (m[3] !== undefined && m[4] !== undefined) {
      parts.push(
        <a
          key={`md-${key++}`}
          href={m[4]}
          target="_blank"
          rel="noreferrer noopener"
          style={mdLink}
        >
          {m[3]}
        </a>,
      );
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length === 0 ? [text] : parts;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  // No hardcoded locale — follow the browser's formatting preference.
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── kind-specific styling ──────────────────────────────────────────────────

const KIND_LABEL_KEY: Record<StreamMessageKind, TranslationKey> = {
  system: 'kindSystem',
  pipeline: 'kindPipeline',
  review: 'kindReview',
  decision: 'kindDecision',
  summary: 'kindSummary',
  error: 'kindError',
  session: 'kindSession',
};

const KIND_ICON: Record<StreamMessageKind, IconName> = {
  system: 'info',
  pipeline: 'arrow-right',
  review: 'mail',
  decision: 'check',
  summary: 'receipt',
  error: 'alert-circle',
  session: 'sparkles',
};

const KIND_BG: Record<StreamMessageKind, string> = {
  system: tokens.color.surface,
  pipeline: tokens.color.bg,
  review: tokens.color.brandSoft,
  decision: tokens.color.brandSoft,
  summary: tokens.color.successSoft,
  error: tokens.color.dangerSoft,
  session: tokens.color.surface,
};

const KIND_FG: Record<StreamMessageKind, string> = {
  system: tokens.color.textMuted,
  pipeline: tokens.color.text,
  review: tokens.color.brand,
  decision: tokens.color.brand,
  summary: tokens.color.text,
  error: tokens.color.danger,
  session: tokens.color.textSubtle,
};

const KIND_BORDER: Record<StreamMessageKind, string> = {
  system: tokens.color.border,
  pipeline: tokens.color.border,
  review: tokens.color.brandBorder,
  decision: tokens.color.brandBorder,
  summary: tokens.color.success,
  error: tokens.color.danger,
  session: tokens.color.border,
};

// ─── styles ─────────────────────────────────────────────────────────────────

const shell: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: tokens.color.bg,
  minWidth: 0,
  // Absolutely-positioned anchor for the LiveProgressPill below.
  position: 'relative',
};

const stream: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: tokens.space[5],
  // Reserve room at the bottom so the pill never covers the last message.
  paddingBottom: 64,
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[3],
};

// ─── Live progress pill (rendered by LiveProgressPill) ─────────────────────
//
// Floats just above the bottom of the stream column. Rationale for inline
// styles (vs. design-tokens entry): the pill exists in only one place, so
// adding a token would create an unused indirection. ``position: absolute``
// + ``bottom: 16`` keeps the pill in view as the stream scrolls — without
// catching pointer events, so users can still click messages or the
// review card behind it.

const progressPillShell: React.CSSProperties = {
  position: 'absolute',
  left: tokens.space[4],
  right: tokens.space[4],
  bottom: tokens.space[3],
  margin: '0 auto',
  maxWidth: 560,
  display: 'inline-flex',
  alignItems: 'center',
  gap: tokens.space[2],
  padding: `8px ${tokens.space[3]}px`,
  borderRadius: tokens.radius.pill,
  fontSize: tokens.fontSize.xs,
  fontFamily: tokens.font.mono,
  fontWeight: tokens.fontWeight.medium,
  boxShadow: tokens.shadow.md,
  // Don't block pointer events — message bubbles and the review card
  // remain fully interactive even with the pill on top.
  pointerEvents: 'none',
  // Animate the pill in from a few px below — feels like the pill is
  // always "rising" with new info instead of jumping in.
  animation: 'progressPillRise 180ms ease-out',
};

const progressPillText: React.CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flex: 1,
};

// ─── Streaming "live writing" bubble ───────────────────────────────────────
//
// Visually distinct from settled messages: dashed brand-tinted border so
// users immediately read it as "still being written, don't interrupt."
// Pre-wrap text rendering preserves newlines + spaces from the LLM output
// without doing markdown parsing (which is unsafe on partial syntax — see
// StreamingBubble doc above). The eyebrow + spinner reinforce "in progress".

const streamingBubble: React.CSSProperties = {
  alignSelf: 'flex-start',
  maxWidth: '85%',
  background: tokens.color.brandSofter,
  border: `1px dashed ${tokens.color.brandBorder}`,
  borderRadius: tokens.radius.lg,
  padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  boxShadow: tokens.shadow.sm,
};

const streamingEyebrow: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: tokens.fontSize.xs,
  fontFamily: tokens.font.mono,
  fontWeight: tokens.fontWeight.medium,
  color: tokens.color.brand,
  letterSpacing: '0.02em',
};

const streamingBody: React.CSSProperties = {
  fontSize: tokens.fontSize.base,
  color: tokens.color.text,
  lineHeight: tokens.lineHeight.snug,
  // Preserve newlines from the LLM output, wrap long lines at word
  // boundaries. ``break-word`` so very long URLs / hashes don't escape
  // the bubble's max-width.
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const streamingCursor: React.CSSProperties = {
  display: 'inline-block',
  marginLeft: 2,
  color: tokens.color.brand,
  fontWeight: tokens.fontWeight.medium,
  // Defined in index.css. ~1.1s blink — slow enough to read as a deliberate
  // "still typing" indicator, not a panic seizure.
  animation: 'streamingCursorBlink 1.1s step-start infinite',
};

const row: React.CSSProperties = {
  display: 'flex',
};

const bubble: React.CSSProperties = {
  border: '1px solid',
  borderRadius: tokens.radius.lg,
  padding: `${tokens.space[3]}px ${tokens.space[4]}px`,
  fontSize: tokens.fontSize.base,
  lineHeight: tokens.lineHeight.normal,
  boxShadow: tokens.shadow.sm,
  minWidth: 0,
};

const kindLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[2],
  fontFamily: tokens.font.mono,
  fontSize: tokens.fontSize.xs,
  fontWeight: tokens.fontWeight.semibold,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 4,
  opacity: 0.8,
};

const ts: React.CSSProperties = {
  marginLeft: 'auto',
  fontFamily: tokens.font.mono,
  fontSize: 10,
  fontWeight: tokens.fontWeight.regular,
  textTransform: 'none',
  letterSpacing: 0,
  opacity: 0.7,
};

const textBody: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

// ─── Markdown styles (used by MarkdownBody) ─────────────────────────────────

const mdRoot: React.CSSProperties = {
  // No margin on first/last child to keep tight against the bubble padding.
  // Stylistic siblings inherit normal spacing from h2/h3/p/ul margin tokens.
  fontSize: tokens.fontSize.base,
  lineHeight: tokens.lineHeight.normal,
  color: tokens.color.text,
};

const mdH2: React.CSSProperties = {
  fontSize: tokens.fontSize.lg,
  fontWeight: tokens.fontWeight.bold,
  color: tokens.color.text,
  margin: `${tokens.space[3]}px 0 ${tokens.space[1]}px`,
  letterSpacing: '-0.005em',
  lineHeight: 1.3,
};

const mdH3: React.CSSProperties = {
  fontSize: tokens.fontSize.md,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.textMuted,
  margin: `${tokens.space[2]}px 0 ${tokens.space[1]}px`,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  lineHeight: 1.3,
};

const mdP: React.CSSProperties = {
  margin: `0 0 ${tokens.space[2]}px`,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const mdList: React.CSSProperties = {
  margin: `0 0 ${tokens.space[2]}px`,
  paddingLeft: tokens.space[5],
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const mdLi: React.CSSProperties = {
  lineHeight: tokens.lineHeight.snug,
};

const mdCode: React.CSSProperties = {
  fontFamily: tokens.font.mono,
  fontSize: tokens.fontSize.sm,
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  padding: '1px 6px',
  color: tokens.color.brand,
};

const mdLink: React.CSSProperties = {
  color: tokens.color.brand,
  textDecoration: 'underline',
  textUnderlineOffset: 2,
};

const pipelineMeta: React.CSSProperties = {
  fontFamily: tokens.font.mono,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
  marginTop: 4,
};

// ─── Onboarding panel styles ────────────────────────────────────────────────

const onboardingShell: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: `${tokens.space[6]}px ${tokens.space[6]}px ${tokens.space[8]}px`,
  display: 'flex',
  justifyContent: 'center',
};

const onboardingInner: React.CSSProperties = {
  width: '100%',
  maxWidth: 560,
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[6],
};

const heroPanel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[2],
};

const heroTitle: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize['2xl'],
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.text,
  letterSpacing: '-0.03em',
  lineHeight: 1.2,
};

const heroDesc: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.md,
  color: tokens.color.textSubtle,
  lineHeight: 1.6,
};

const stepsHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
};

const stepsTitle: React.CSSProperties = {
  fontSize: tokens.fontSize.base,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.text,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const steps: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const stepRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: tokens.space[3],
  padding: `${tokens.space[3]}px ${tokens.space[3]}px`,
  borderRadius: tokens.radius.md,
  transition: 'background 150ms ease',
};

const stepBadge: React.CSSProperties = {
  flexShrink: 0,
  width: 28,
  height: 28,
  borderRadius: tokens.radius.md,
  background: tokens.color.surface,
  color: tokens.color.textMuted,
  border: `1px solid ${tokens.color.border}`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const stepTitle: React.CSSProperties = {
  fontSize: tokens.fontSize.base,
  fontWeight: tokens.fontWeight.medium,
  color: tokens.color.text,
  marginBottom: 1,
};

const stepBody: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  color: tokens.color.textSubtle,
  lineHeight: tokens.lineHeight.snug,
};

const dataSourcePanel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[2],
  padding: tokens.space[3],
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
};

const aiHintPanel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[2],
  padding: `${tokens.space[3]}px ${tokens.space[3]}px`,
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: tokens.fontSize.sm,
  color: tokens.color.textMuted,
  lineHeight: 1.5,
};

const dataSourceHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: tokens.fontSize.sm,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.text,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

const dataSourceBadge: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  fontWeight: tokens.fontWeight.medium,
  padding: '2px 8px',
  borderRadius: tokens.radius.pill,
};

const dataSourceBody: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.sm,
  color: tokens.color.textSubtle,
  lineHeight: 1.6,
};

const ctaRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: tokens.space[2],
};

const ctaCard: React.CSSProperties = {
  padding: `${tokens.space[3]}px ${tokens.space[3]}px`,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  background: tokens.color.bg,
};

const ctaCardTitle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  fontSize: tokens.fontSize.base,
  fontWeight: tokens.fontWeight.medium,
  color: tokens.color.text,
  marginBottom: 2,
};

const ctaCardDesc: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
};

const ctaHintText: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
  lineHeight: 1.5,
};

const inlineCard: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[1],
  marginTop: tokens.space[2],
};

const whoLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: tokens.font.mono,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.brand,
  fontWeight: tokens.fontWeight.semibold,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  paddingLeft: tokens.space[1],
};

// ─── Restoring skeleton (history-row click → session hydration) ────────────

const skeletonShell: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[3],
  padding: `${tokens.space[5]}px ${tokens.space[5]}px`,
  overflow: 'hidden',
};

const skeletonRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: tokens.space[3],
};

const skeletonAvatar: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  flexShrink: 0,
  background: `linear-gradient(90deg, ${tokens.color.surface} 25%, ${tokens.color.surfaceHover} 50%, ${tokens.color.surface} 75%)`,
  backgroundSize: '200px 100%',
  animation: 'shimmer 1.5s ease-in-out infinite',
};

const skeletonBody: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  paddingTop: 4,
  minWidth: 0,
};

const skeletonBar: React.CSSProperties = {
  height: 12,
  borderRadius: tokens.radius.sm,
  background: `linear-gradient(90deg, ${tokens.color.surface} 25%, ${tokens.color.surfaceHover} 50%, ${tokens.color.surface} 75%)`,
  backgroundSize: '200px 100%',
  animation: 'shimmer 1.5s ease-in-out infinite',
};
