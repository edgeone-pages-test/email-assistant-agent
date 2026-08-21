/**
 * NodeFlowVisualizer — right column.
 *
 * Renders the LangGraph pipeline as a vertical node strip, with each node
 * showing its current status (pending / active / paused / done / error).
 *
 * The component is purely presentational. The parent computes per-node
 * status from streaming SSE frames and passes the map in.
 */
import { PIPELINE_NODES, PipelineNode, NodeStatus, ProgressPayload } from '../types';
import { tokens } from '../design-tokens';
import { useI18n, type TranslationKey } from '../i18n';
import { Icon, IconName, IconSpinner } from '../icons';

interface Props {
  statuses: Partial<Record<PipelineNode, NodeStatus>>;
  /** Nodes whose backend patch carried ``_cached: true`` — we render them
   * as a grey "缓存" chip with a lightning bolt instead of the usual ✓ done
   * green tick, so the user can tell at a glance that no real work happened. */
  cachedNodes?: ReadonlySet<PipelineNode>;
  /** Latest narration from a node's ``get_stream_writer`` call. When the
   * payload's ``phase`` matches a node id, that node renders a sub-line
   * with the message — gives users an inline "what's actually happening
   * inside this stage" without leaving the pipeline column.
   *
   * Note: per-iteration counters (``iteration`` / ``totalEmails``) are
   * intentionally NOT a prop here — they live in the header chip
   * (``RuntimeStatusChip``) only. Showing them in both places duplicated
   * information and made the pipeline column feel cluttered. */
  progress?: ProgressPayload | null;
}

const NODE_LABEL_KEY: Record<PipelineNode, TranslationKey> = {
  fetch: 'pipelineFetch',
  classify: 'pipelineClassify',
  prioritize: 'pipelinePrioritize',
  draft: 'pipelineDraft',
  review: 'pipelineReview',
  apply: 'pipelineApply',
  summarize: 'pipelineSummarize',
};

const NODE_DESC_KEY: Record<PipelineNode, TranslationKey> = {
  fetch: 'pipelineFetchDesc',
  classify: 'pipelineClassifyDesc',
  prioritize: 'pipelinePrioritizeDesc',
  draft: 'pipelineDraftDesc',
  review: 'pipelineReviewDesc',
  apply: 'pipelineApplyDesc',
  summarize: 'pipelineSummarizeDesc',
};

export default function NodeFlowVisualizer({
  statuses,
  cachedNodes,
  progress,
}: Props) {
  const { t } = useI18n();
  return (
    <aside style={shell}>
      <h2 style={heading}>
        <Icon name="circle-dot" size={13} />
        <span>{t('pipelineTitle')}</span>
      </h2>
      <ol style={list}>
        {PIPELINE_NODES.map((node, idx) => {
          const status = statuses[node] || 'pending';
          const isLast = idx === PIPELINE_NODES.length - 1;
          const isCached = cachedNodes?.has(node) ?? false;
          // Inline narration from the latest ``progress`` event tied to
          // THIS node — only rendered while the node is active so a stale
          // "✅ 分类完成" message doesn't linger on a node we've already
          // moved past.
          const narration =
            progress && progress.phase === node && progress.message
              ? progress.message
              : null;
          return (
            <li key={node} style={item}>
              <NodeMarker status={status} isLast={isLast} cached={isCached} />
              <div style={{ ...info, ...(status === 'active' ? infoActive : null) }}>
                <div style={topLine}>
                  <Icon name={NODE_ICON[node]} size={12} />
                  <span style={{ ...labelText, color: status === 'active' ? tokens.color.brand : tokens.color.text }}>
                    {t(NODE_LABEL_KEY[node])}
                  </span>
                  {/* Cached chip outranks the normal status pill — when both
                      apply (a cached node MUST be ``done``), the cached chip
                      is the more useful signal. The per-iteration "X / Y"
                      counter intentionally lives ONLY in the header chip
                      (RuntimeStatusChip in App.tsx) — duplicating it here was
                      noise: the pipeline is per-node status, not per-email
                      progress. */}
                  {isCached && status === 'done' ? (
                    <CachedPill />
                  ) : (
                    <StatusPill status={status} />
                  )}
                </div>
                {/* Show description only for the active / paused node — keeps
                    the idle pipeline tight, like a real status timeline. */}
                {(status === 'active' || status === 'paused') && (
                  <div style={descText}>{t(NODE_DESC_KEY[node])}</div>
                )}
                {/* Live narration sits BELOW the description so the eye
                    flows label → static description → live what's-happening
                    line. We restrict to active/paused so a "completed" pill
                    text from a previous run doesn't haunt the panel. */}
                {narration && (status === 'active' || status === 'paused') && (
                  <div style={narrationText}>
                    <IconSpinner size={9} />
                    <span style={narrationTextInner}>{narration}</span>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

const NODE_ICON: Record<PipelineNode, IconName> = {
  fetch: 'inbox',
  classify: 'sparkles',
  prioritize: 'arrow-right',
  draft: 'edit-3',
  review: 'pause',
  apply: 'check',
  summarize: 'receipt',
};

function NodeMarker({
  status,
  isLast,
  cached,
}: {
  status: NodeStatus;
  isLast: boolean;
  cached: boolean;
}) {
  // Cached + done → render with a softer, neutral color (not the success
  // green) so the visual matches the "we didn't actually work, just reused"
  // semantic. The lightning glyph reinforces "fast/cached".
  const color = cached && status === 'done' ? tokens.color.textSubtle : MARKER_COLOR[status];
  return (
    <div style={markerCol}>
      <div
        style={{
          ...markerDot,
          background: color,
          boxShadow: status === 'active' ? `0 0 0 4px ${tokens.color.brandSoft}` : 'none',
          animation: status === 'active' ? 'pulse 1.6s ease-in-out infinite' : undefined,
        }}
      >
        {status === 'active' && <IconSpinner size={10} />}
        {status === 'paused' && <Icon name="pause" size={10} strokeWidth={3} />}
        {status === 'done' && cached && <Icon name="zap" size={11} strokeWidth={2.5} />}
        {status === 'done' && !cached && <Icon name="check" size={11} strokeWidth={3} />}
        {status === 'error' && <Icon name="x" size={10} strokeWidth={3} />}
      </div>
      {!isLast && (
        <div
          style={{
            ...connector,
            background:
              status === 'done' && !cached
                ? tokens.color.success
                : tokens.color.border,
          }}
        />
      )}
    </div>
  );
}

/** Subtle grey chip with a "缓存" label — used when a node short-circuited
 * because a previous run's data was still valid. Distinguishes "we did
 * the work" (✓ 完成 in green) from "we reused what we had" (⚡ 缓存 in grey). */
function CachedPill() {
  const { t } = useI18n();
  return (
    <span
      style={{
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: tokens.font.mono,
        fontSize: tokens.fontSize.xs,
        padding: '2px 8px',
        borderRadius: tokens.radius.pill,
        background: tokens.color.surfaceMuted,
        color: tokens.color.textMuted,
        border: `1px solid ${tokens.color.border}`,
        fontWeight: tokens.fontWeight.medium,
      }}
      title={t('cachedPillTitle')}
    >
      <Icon name="zap" size={10} strokeWidth={2.5} />
      <span>{t('cachedPillLabel')}</span>
    </span>
  );
}

function StatusPill({ status }: { status: NodeStatus }) {
  const { t } = useI18n();
  if (status === 'pending') return null;
  const label =
    status === 'active'
      ? t('nodeActive')
      : status === 'paused'
      ? t('nodePaused')
      : status === 'done'
      ? t('nodeDone')
      : t('nodeError');
  return (
    <span
      style={{
        marginLeft: 'auto',
        fontFamily: tokens.font.mono,
        fontSize: tokens.fontSize.xs,
        padding: '2px 8px',
        borderRadius: tokens.radius.pill,
        background: PILL_BG[status],
        color: PILL_FG[status],
        border: `1px solid ${PILL_BORDER[status]}`,
        fontWeight: tokens.fontWeight.medium,
      }}
    >
      {label}
    </span>
  );
}

const MARKER_COLOR: Record<NodeStatus, string> = {
  pending: tokens.color.surfaceHover,
  active: tokens.color.brand,
  paused: tokens.color.warning,
  done: tokens.color.success,
  error: tokens.color.danger,
};

const PILL_BG: Record<NodeStatus, string> = {
  pending: 'transparent',
  active: tokens.color.brandSoft,
  paused: tokens.color.warningSoft,
  done: tokens.color.successSoft,
  error: tokens.color.dangerSoft,
};

const PILL_FG: Record<NodeStatus, string> = {
  pending: tokens.color.textSubtle,
  active: tokens.color.brand,
  paused: tokens.color.warning,
  done: tokens.color.success,
  error: tokens.color.danger,
};

const PILL_BORDER: Record<NodeStatus, string> = {
  pending: 'transparent',
  active: tokens.color.brandBorder,
  paused: '#fde68a',
  done: '#bbf7d0',
  error: '#fecaca',
};

// ─── styles ─────────────────────────────────────────────────────────────────

const shell: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[4],
  padding: tokens.space[4],
  background: tokens.color.surface,
  borderLeft: `1px solid ${tokens.color.border}`,
  overflowY: 'auto',
  minWidth: 0,
};

const heading: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.sm,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[2],
  paddingBottom: tokens.space[2],
  marginBottom: tokens.space[2],
};

const list: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
};

const item: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '24px 1fr',
  gap: tokens.space[2],
  // alignItems: 'stretch' lets markerCol's flex column grow to match the
  // info panel height, so the connector line spans the full gap. With
  // 'flex-start' (the previous setting) markerCol shrinks and the line
  // disappears — that's why the right column looked like detached dots.
  alignItems: 'stretch',
};

const markerCol: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  height: '100%',
};

const markerDot: React.CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'white',
  flexShrink: 0,
  transition: tokens.motion.base,
};

const connector: React.CSSProperties = {
  width: 2,
  flex: 1,
  minHeight: 16,
  marginTop: 2,
  marginBottom: 2,
};

const info: React.CSSProperties = {
  paddingBottom: tokens.space[3],
  minWidth: 0,
};

// Active node gets a soft brand-tinted card to focus attention.
const infoActive: React.CSSProperties = {
  background: tokens.color.brandSofter,
  border: `1px solid ${tokens.color.brandBorder}`,
  borderRadius: tokens.radius.md,
  padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
  marginBottom: tokens.space[2],
  paddingBottom: tokens.space[3],
};

const topLine: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const labelText: React.CSSProperties = {
  fontSize: tokens.fontSize.base,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.text,
};

const descText: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
  marginTop: 2,
  marginLeft: 18,
  lineHeight: 1.5,
};

// ─── narration sub-line under the active node ────────────────────────────
//
// Mirrors the indent of ``descText`` so the live message reads as a child
// of the node label. Brand-tinted to distinguish from the static description
// (slate) and uses the smaller mono font to read as machine output.

const narrationText: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 4,
  marginLeft: 18,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.brand,
  fontFamily: tokens.font.mono,
  lineHeight: 1.5,
  // Long narration ("🤖 三人小组开始为「Re: 关于上次报价的二次跟进」起草回复")
  // would otherwise overflow the column on narrow viewports.
  minWidth: 0,
};

const narrationTextInner: React.CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flex: 1,
  minWidth: 0,
};
