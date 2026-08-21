/**
 * DraftReviewCard — Human-in-the-loop approval card for an email draft.
 *
 * Renders the pending draft with five actions (approve / edit / reject /
 * regenerate / skip) and an editable body textarea. Calls ``onSubmit``
 * with the chosen decision; the parent then POSTs to ``/email/review``
 * to resume the LangGraph.
 *
 * Types are centralised in ``../types.ts`` so the SSE contract stays
 * single-source-of-truth across the frontend.
 */
import { useState } from 'react';
import { tokens } from '../design-tokens';
import { useI18n } from '../i18n';
import { Icon } from '../icons';
import { DraftItem, ReviewDecisionInput } from '../types';

export type { DraftItem, ReviewDecisionInput };

interface Props {
  draft: DraftItem;
  remaining: number;
  onSubmit: (decision: ReviewDecisionInput) => void;
  disabled?: boolean;
}

export default function DraftReviewCard({ draft, remaining, onSubmit, disabled }: Props) {
  const { t } = useI18n();
  const [body, setBody] = useState(draft.body);
  const [feedback, setFeedback] = useState('');
  const edited = body !== draft.body;

  return (
    <div style={shell}>
      <header style={headerRow}>
        <div style={titleStack}>
          <span style={subjectLine}>{draft.subject || t('noSubjectDraft')}</span>
          <span style={metaLine}>
            {t('draftToLabel')} {draft.to.join(', ')} · {t('draftToneLabel')} <TonePill tone={draft.tone} />
            {remaining > 0 && (
              <>
                {' '}
                {t('draftRemainingPrefix')}
                <strong style={{ color: tokens.color.warning }}>{remaining}</strong>
                {t('draftRemainingSuffix')}
              </>
            )}
          </span>
        </div>
        <ConfidencePill conf={draft.confidence} />
      </header>

      {draft.rationale && (
        <details style={rationaleDetails}>
          <summary style={rationaleSummary}>
            {t('reviewRationale')}
          </summary>
          <div style={rationaleBody}>{draft.rationale}</div>
        </details>
      )}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
        disabled={disabled}
        style={{
          ...textareaStyle,
          background: edited ? tokens.color.warningSoft : tokens.color.surfaceMuted,
          borderColor: edited ? tokens.color.warning : tokens.color.border,
        }}
      />

      <input
        type="text"
        value={feedback}
        placeholder={t('reviewFeedbackPlaceholder')}
        onChange={(e) => setFeedback(e.target.value)}
        disabled={disabled}
        style={feedbackInput}
      />

      <div style={actions}>
        {edited ? (
          <button
            disabled={disabled}
            onClick={() => onSubmit({ action: 'edit', edited_body: body, feedback: feedback || undefined })}
            style={btn(tokens.color.success, true)}
          >
            <Icon name="check" size={13} strokeWidth={2.5} />
            <span>{t('reviewEditApprove')}</span>
          </button>
        ) : (
          <button
            disabled={disabled}
            onClick={() => onSubmit({ action: 'approve' })}
            style={btn(tokens.color.success, true)}
          >
            <Icon name="check" size={13} strokeWidth={2.5} />
            <span>{t('reviewApprove')}</span>
          </button>
        )}
        <button
          disabled={disabled}
          onClick={() => onSubmit({ action: 'regenerate', feedback: feedback || undefined })}
          style={btn(tokens.color.info, false)}
        >
          <Icon name="refresh-cw" size={12} />
          <span>{t('reviewRegenerate')}</span>
        </button>
        <button
          disabled={disabled}
          onClick={() => onSubmit({ action: 'reject' })}
          style={btn(tokens.color.danger, false)}
        >
          <Icon name="x" size={13} strokeWidth={2.5} />
          <span>{t('reviewReject')}</span>
        </button>
        <button
          disabled={disabled}
          onClick={() => onSubmit({ action: 'skip' })}
          style={btn(tokens.color.textMuted, false)}
        >
          <Icon name="skip-forward" size={12} />
          <span>{t('reviewSkip')}</span>
        </button>
      </div>
    </div>
  );
}

function TonePill({ tone }: { tone: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        background: tokens.color.brandSoft,
        color: tokens.color.brand,
        fontFamily: tokens.font.mono,
        fontSize: tokens.fontSize.xs,
        padding: '0 6px',
        borderRadius: tokens.radius.sm,
        marginLeft: 2,
      }}
    >
      {tone}
    </span>
  );
}

function ConfidencePill({ conf }: { conf: number }) {
  const { t } = useI18n();
  const pct = Math.round(conf * 100);
  const color = pct >= 80 ? tokens.color.success : pct >= 50 ? tokens.color.warning : tokens.color.textSubtle;
  return (
    <span
      title={t('draftConfidenceTitle')}
      style={{
        fontFamily: tokens.font.mono,
        fontSize: tokens.fontSize.xs,
        color,
        background: 'transparent',
        border: `1px solid ${color}`,
        padding: '1px 6px',
        borderRadius: tokens.radius.pill,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      ▣ {pct}%
    </span>
  );
}

function btn(bg: string, primary: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: primary ? bg : 'white',
    color: primary ? 'white' : bg,
    border: `1px solid ${primary ? bg : 'currentColor'}`,
    padding: `7px ${tokens.space[3]}px`,
    borderRadius: tokens.radius.md,
    fontSize: tokens.fontSize.base,
    fontWeight: tokens.fontWeight.medium,
    cursor: 'pointer',
    lineHeight: 1.2,
  };
}

const shell: React.CSSProperties = {
  border: `1px solid ${tokens.color.brandBorder}`,
  borderRadius: tokens.radius.xl,
  padding: tokens.space[5],
  background: tokens.color.bg,
  boxShadow: tokens.shadow.md,
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[3],
};

const headerRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: tokens.space[2],
  justifyContent: 'space-between',
};

const titleStack: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
};

const subjectLine: React.CSSProperties = {
  fontSize: tokens.fontSize.lg,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.text,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const metaLine: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 2,
};

const rationaleDetails: React.CSSProperties = {
  borderRadius: tokens.radius.sm,
  background: tokens.color.surface,
  padding: `${tokens.space[1]}px ${tokens.space[2]}px`,
  fontSize: tokens.fontSize.xs,
};

const rationaleSummary: React.CSSProperties = {
  cursor: 'pointer',
  color: tokens.color.textMuted,
  fontFamily: tokens.font.mono,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const rationaleBody: React.CSSProperties = {
  paddingTop: tokens.space[1],
  color: tokens.color.textMuted,
  fontFamily: tokens.font.sans,
  fontSize: tokens.fontSize.sm,
  textTransform: 'none',
  letterSpacing: 0,
  lineHeight: tokens.lineHeight.snug,
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: tokens.font.sans,
  fontSize: tokens.fontSize.base,
  lineHeight: tokens.lineHeight.snug,
  padding: tokens.space[2],
  border: '1px solid',
  borderRadius: tokens.radius.md,
  color: tokens.color.text,
  boxSizing: 'border-box',
  resize: 'vertical',
  // Cap so the action buttons never go off-screen when the LLM returns
  // a 50-line ramble. The textarea scrolls internally past this height.
  maxHeight: 260,
  minHeight: 120,
};

const feedbackInput: React.CSSProperties = {
  width: '100%',
  padding: `${tokens.space[1]}px ${tokens.space[2]}px`,
  fontSize: tokens.fontSize.sm,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  background: tokens.color.surfaceMuted,
  boxSizing: 'border-box',
};

const actions: React.CSSProperties = {
  display: 'flex',
  gap: tokens.space[2],
  flexWrap: 'wrap',
  marginTop: tokens.space[1],
};
