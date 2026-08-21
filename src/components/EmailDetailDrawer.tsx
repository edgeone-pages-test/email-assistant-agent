/**
 * EmailDetailDrawer — slide-out panel for viewing email details + draft.
 *
 * Triggered by clicking an email row in EmailInboxTree. Shows:
 *   1. Email metadata (subject, from, to, received_at)
 *   2. Classification info (category, priority, needs_reply, reason)
 *   3. Original email body (scrollable)
 *   4. Draft (if generated) with copy button
 *
 * Fixed-position overlay from the left side. Dismissible via:
 *   - Close button
 *   - Clicking the backdrop
 *   - Pressing Escape
 */
import { useCallback, useEffect, useState } from 'react';
import { tokens } from '../design-tokens';
import { useI18n, type TranslationKey } from '../i18n';
import { Icon } from '../icons';
import type { ClassifiedEmail, DraftItem, EmailCategory } from '../types';

interface Props {
  email: ClassifiedEmail | null;
  draft: DraftItem | null;
  isOpen: boolean;
  onClose: () => void;
}

const CATEGORY_LABEL_KEY: Record<EmailCategory, TranslationKey> = {
  urgent_customer: 'catUrgentCustomer',
  meeting: 'catMeeting',
  internal: 'catInternal',
  marketing: 'catMarketing',
  notification: 'catNotification',
  followup: 'catFollowup',
  spam: 'catSpam',
  billing: 'catBilling',
  other: 'catOther',
};

export default function EmailDetailDrawer({ email, draft, isOpen, onClose }: Props) {
  const { t } = useI18n();
  // Escape key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen || !email) return null;

  return (
    <div
      style={overlay}
      onClick={onClose}
      aria-hidden={!isOpen}
    >
      <aside
        style={drawer}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('drawerAriaLabel')}
      >
        <DrawerHeader email={email} draft={draft} onClose={onClose} />
        <div style={body}>
          <MetaSection email={email} />
          <ClassificationSection email={email} />
          <OriginalBodySection email={email} />
          <DraftSection draft={draft} />
        </div>
      </aside>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DrawerHeader({
  email,
  draft,
  onClose,
}: {
  email: ClassifiedEmail;
  draft: DraftItem | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <header style={header}>
      <button onClick={onClose} style={closeBtn} title={t('drawerCloseTitle')}>
        <Icon name="x" size={16} strokeWidth={2} />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={headerTitle}>
          {(email.email.subject || t('noSubjectDraft')).slice(0, 60)}
        </div>
        <div style={headerSender}>
          {email.email.sender || email.email.from_ || (email.email as { from?: string }).from || ''}
        </div>
      </div>
      {draft && <CopyButton text={draft.body} label={t('drawerCopyDraft')} />}
    </header>
  );
}

function MetaSection({ email }: { email: ClassifiedEmail }) {
  const { t } = useI18n();
  const e = email.email;
  const sender = e.sender || e.from_ || (e as { from?: string }).from || t('drawerUnknownSender');
  const received = e.received_at
    ? new Date(e.received_at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  return (
    <section style={section}>
      <div style={sectionHeader}>
        <Icon name="mail" size={12} />
        <span>{t('drawerMetaTitle')}</span>
      </div>
      <div style={metaGrid}>
        <MetaRow label={t('drawerFrom')} value={sender} />
        <MetaRow label={t('drawerTo')} value={e.to?.join(', ') || ''} />
        <MetaRow label={t('drawerSubject')} value={e.subject || t('noSubjectDraft')} />
        {received && <MetaRow label={t('drawerTime')} value={received} />}
        {e.has_ics && <MetaRow label={t('drawerAttachment')} value={t('drawerIcs')} />}
      </div>
    </section>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={metaRow}>
      <span style={metaLabel}>{label}</span>
      <span style={metaValue}>{value}</span>
    </div>
  );
}

function ClassificationSection({ email }: { email: ClassifiedEmail }) {
  const { t } = useI18n();
  const catLabel = t(CATEGORY_LABEL_KEY[email.category] ?? 'catOther') || email.category;
  return (
    <section style={section}>
      <div style={sectionHeader}>
        <Icon name="sparkles" size={12} />
        <span>{t('drawerClassTitle')}</span>
      </div>
      <div style={classificationWrap}>
        <div style={classChips}>
          <span style={chip}>
            {catLabel}
          </span>
          <span style={{ ...chip, ...priorityChipColor(email.priority) }}>
            {t('drawerPriority', { n: email.priority })}
          </span>
          {email.needs_reply && (
            <span style={{ ...chip, color: tokens.color.success, borderColor: '#bbf7d0', background: tokens.color.successSoft }}>
              {t('drawerNeedsReply')}
            </span>
          )}
        </div>
        {email.reason && (
          <p style={reasonText}>{email.reason}</p>
        )}
      </div>
    </section>
  );
}

function OriginalBodySection({ email }: { email: ClassifiedEmail }) {
  const { t } = useI18n();
  const hasHtml = !!email.email.body_html;
  const [viewMode, setViewMode] = useState<'html' | 'text'>(hasHtml ? 'html' : 'text');
  const bodyText = email.email.body_text || t('drawerEmptyBody');

  return (
    <section style={section}>
      <div style={{ ...sectionHeader, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="eye" size={12} />
          <span>{t('drawerOriginalTitle')}</span>
        </div>
        {hasHtml && (
          <div style={viewToggle}>
            <button
              type="button"
              onClick={() => setViewMode('html')}
              style={{
                ...viewToggleBtn,
                ...(viewMode === 'html' ? viewToggleBtnActive : {}),
              }}
            >
              HTML
            </button>
            <button
              type="button"
              onClick={() => setViewMode('text')}
              style={{
                ...viewToggleBtn,
                ...(viewMode === 'text' ? viewToggleBtnActive : {}),
              }}
            >
              {t('drawerPlainText')}
            </button>
          </div>
        )}
      </div>
      {viewMode === 'html' && hasHtml ? (
        <iframe
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={`<style>body{margin:8px;overflow-x:auto;word-break:break-word;overflow-wrap:break-word;font-family:system-ui,sans-serif;font-size:14px;line-height:1.6}img{max-width:100%;height:auto}table{max-width:100%;border-collapse:collapse;overflow-wrap:break-word}td,th{word-break:break-word;overflow-wrap:break-word}pre,code{white-space:pre-wrap;max-width:100%}blockquote{margin-left:8px;padding-left:8px;border-left:3px solid #e5e7eb}</style>${email.email.body_html!}`}
          style={htmlIframe}
          title={t('drawerOriginalTitle')}
        />
      ) : (
        <div style={emailBody}>{bodyText}</div>
      )}
    </section>
  );
}

function DraftSection({ draft }: { draft: DraftItem | null }) {
  const { t } = useI18n();
  if (!draft) {
    return (
      <section style={section}>
        <div style={sectionHeader}>
          <Icon name="edit-3" size={12} />
          <span>{t('drawerDraftTitle')}</span>
        </div>
        <p style={emptyDraft}>{t('drawerNoDraft')}</p>
      </section>
    );
  }
  return (
    <section style={section}>
      <div style={{ ...sectionHeader, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="edit-3" size={12} />
          <span>{t('drawerDraftTitle')}</span>
        </div>
        <CopyButton text={draft.body} label={t('drawerCopy')} />
      </div>
      <div style={draftMeta}>
        <span>{t('draftToLabel')} {draft.to.join(', ')}</span>
        <span>{t('draftToneLabel')} {draft.tone}</span>
      </div>
      <div style={draftBody}>{draft.body}</div>
    </section>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for insecure contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [text]);

  return (
    <button
      onClick={(e) => { e.stopPropagation(); handleCopy(); }}
      style={copyBtn}
      title={t('drawerCopyTitle')}
    >
      <Icon name={copied ? 'check' : 'clipboard'} size={12} strokeWidth={2} />
      <span>{copied ? t('drawerCopied') : label}</span>
    </button>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function priorityChipColor(priority: number): React.CSSProperties {
  if (priority >= 80) return { color: tokens.color.danger, borderColor: '#fecaca', background: tokens.color.dangerSoft };
  if (priority >= 50) return { color: tokens.color.warning, borderColor: '#fde68a', background: tokens.color.warningSoft };
  return { color: tokens.color.info, borderColor: '#bfdbfe', background: tokens.color.infoSoft };
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1100,
  background: 'rgba(0, 0, 0, 0.25)',
  display: 'flex',
  alignItems: 'stretch',
  animation: 'drawerBackdropIn 200ms ease-out',
};

const drawer: React.CSSProperties = {
  width: 'min(560px, 90vw)',
  height: '100%',
  background: tokens.color.bg,
  boxShadow: `${tokens.shadow.pop}, 12px 0 40px rgba(0,0,0,0.12)`,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  animation: 'drawerSlideIn 280ms cubic-bezier(0.32, 0.72, 0, 1)',
};

const header: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[2],
  padding: `${tokens.space[3]}px ${tokens.space[4]}px`,
  borderBottom: `1px solid ${tokens.color.border}`,
  flexShrink: 0,
};

const closeBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  borderRadius: tokens.radius.md,
  border: `1px solid ${tokens.color.border}`,
  background: 'transparent',
  color: tokens.color.textMuted,
  cursor: 'pointer',
  flexShrink: 0,
};

const headerTitle: React.CSSProperties = {
  fontSize: tokens.fontSize.md,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.text,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const headerSender: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  marginTop: 2,
};

const body: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: tokens.space[4],
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[4],
};

const section: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[2],
};

const sectionHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: tokens.fontSize.xs,
  fontFamily: tokens.font.mono,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const metaGrid: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
  background: tokens.color.surface,
  borderRadius: tokens.radius.md,
  border: `1px solid ${tokens.color.border}`,
};

const metaRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: tokens.space[2],
  fontSize: tokens.fontSize.sm,
  lineHeight: 1.6,
};

const metaLabel: React.CSSProperties = {
  flexShrink: 0,
  width: 52,
  fontFamily: tokens.font.mono,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
};

const metaValue: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: tokens.color.text,
  wordBreak: 'break-word',
};

const classificationWrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[2],
};

const classChips: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

const chip: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 10px',
  borderRadius: tokens.radius.pill,
  fontSize: tokens.fontSize.xs,
  fontFamily: tokens.font.mono,
  fontWeight: tokens.fontWeight.medium,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.surface,
  color: tokens.color.textMuted,
};

const reasonText: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.sm,
  color: tokens.color.textMuted,
  lineHeight: 1.6,
  fontStyle: 'italic',
};

const emailBody: React.CSSProperties = {
  padding: `${tokens.space[3]}px`,
  background: tokens.color.surfaceMuted,
  borderRadius: tokens.radius.md,
  border: `1px solid ${tokens.color.border}`,
  fontSize: tokens.fontSize.sm,
  color: tokens.color.text,
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
  maxHeight: 480,
  overflowY: 'auto',
  overflowX: 'hidden',
};

const emptyDraft: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.sm,
  color: tokens.color.textDisabled,
  fontStyle: 'italic',
  padding: `${tokens.space[2]}px 0`,
};

const draftMeta: React.CSSProperties = {
  display: 'flex',
  gap: tokens.space[3],
  fontSize: tokens.fontSize.xs,
  fontFamily: tokens.font.mono,
  color: tokens.color.textSubtle,
};

const draftBody: React.CSSProperties = {
  padding: `${tokens.space[3]}px`,
  background: tokens.color.brandSofter,
  borderRadius: tokens.radius.md,
  border: `1px dashed ${tokens.color.brandBorder}`,
  fontSize: tokens.fontSize.sm,
  color: tokens.color.text,
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 300,
  overflowY: 'auto',
};

const copyBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 10px',
  borderRadius: tokens.radius.md,
  fontSize: tokens.fontSize.xs,
  fontFamily: tokens.font.mono,
  fontWeight: tokens.fontWeight.medium,
  color: tokens.color.brand,
  background: tokens.color.brandSoft,
  border: `1px solid ${tokens.color.brandBorder}`,
  cursor: 'pointer',
  flexShrink: 0,
};

// ─── HTML/Text toggle + iframe styles ─────────────────────────────────────────

const viewToggle: React.CSSProperties = {
  display: 'inline-flex',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.color.border}`,
  overflow: 'hidden',
};

const viewToggleBtn: React.CSSProperties = {
  padding: '2px 8px',
  fontSize: tokens.fontSize.xs,
  fontFamily: tokens.font.mono,
  fontWeight: tokens.fontWeight.medium,
  color: tokens.color.textMuted,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  lineHeight: 1.4,
};

const viewToggleBtnActive: React.CSSProperties = {
  color: tokens.color.brand,
  background: tokens.color.brandSoft,
};

const htmlIframe: React.CSSProperties = {
  width: '100%',
  minHeight: 360,
  maxHeight: 600,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  background: '#fff',
};
