/**
 * EmailInboxTree — left column.
 *
 * Renders the classified inbox grouped by category with priority badges.
 * Highlights the email currently under review (matched by ``activeEmailId``).
 *
 * The component is purely presentational — it ingests an array of
 * ClassifiedEmail (built up incrementally as state_update frames stream
 * in from the backend) and renders them grouped + sorted by priority.
 */
import { useMemo, useState } from 'react';
import { ClassifiedEmail, EmailCategory } from '../types';
import { tokens } from '../design-tokens';
import { useI18n, type TranslationKey } from '../i18n';
import { Icon, IconName } from '../icons';

interface Props {
  emails: ClassifiedEmail[];
  activeEmailId?: string | null;
  doneEmailIds?: ReadonlySet<string>;
  /**
   * True while a new run is in flight and the displayed list is from a
   * previous run. We keep the old data on screen rather than flashing back
   * to the empty state — the small banner tells the user a refresh is
   * happening, and the list updates as soon as classify+prioritize complete.
   */
  refreshing?: boolean;
  /** Number of emails fetched on the current run. Used in conjunction with
   * ``classifying`` to render an "已拉取 N 封,正在分类..." transitional
   * state — bridges the visual gap between fetch:done and classify:done. */
  fetchedCount?: number;
  /** True iff fetch is done but classify hasn't produced data yet. Lets the
   * empty state explain "we have N emails, just hold on for categorization"
   * instead of misleading the user with "等待拉取邮件". */
  classifying?: boolean;
  /**
   * If provided, every classified row gets an inline "↩ 处理" button that
   * calls this with the email id — entry point for single-reply mode.
   * Hidden when the email is already done or currently under review.
   */
  onProcessSingle?: (emailId: string) => void;
  /** Opens the EmailDetailDrawer for the clicked email row. */
  onSelectEmail?: (emailId: string) => void;
  /** Disables the per-row action button (e.g. while a run is in flight). */
  actionsDisabled?: boolean;
  /** True while App.tsx is hydrating a previously-stored conversation
   * (user clicked a row in the history sidebar). Renders a skeleton
   * placeholder INSTEAD of all other content (search input, category
   * tree, empty state) for the duration of the /email/history fetch.
   * Mirrors the same pattern as ConversationStream.tsx — keeps the
   * left and center columns visually in sync during the transition. */
  restoring?: boolean;
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

const CATEGORY_ICON: Record<EmailCategory, IconName> = {
  urgent_customer: 'siren',
  meeting: 'calendar',
  internal: 'briefcase',
  marketing: 'megaphone',
  notification: 'bell',
  followup: 'rotate-ccw',
  spam: 'trash-2',
  billing: 'receipt',
  other: 'folder',
};

const CATEGORY_COLOR: Record<EmailCategory, string> = {
  urgent_customer: tokens.color.categoryUrgent,
  meeting: tokens.color.categoryMeeting,
  internal: tokens.color.categoryInternal,
  marketing: tokens.color.categoryMarketing,
  notification: tokens.color.categoryNotification,
  followup: tokens.color.categoryFollowup,
  spam: tokens.color.categorySpam,
  billing: tokens.color.categoryBilling,
  other: tokens.color.categoryOther,
};

const CATEGORY_ORDER: EmailCategory[] = [
  'urgent_customer',
  'meeting',
  'followup',
  'billing',
  'internal',
  'notification',
  'marketing',
  'other',
  'spam',
];

export default function EmailInboxTree({
  emails,
  activeEmailId,
  doneEmailIds,
  refreshing,
  fetchedCount,
  classifying,
  onProcessSingle,
  onSelectEmail,
  actionsDisabled,
  restoring,
}: Props) {
  const { t } = useI18n();

  // Restoring takeover
  if (restoring) {
    return (
      <aside style={shell}>
        <h2 style={heading}>
          <Icon name="inbox" size={13} />
          <span>{t('inboxTitle')}</span>
        </h2>
        <InboxSkeleton />
      </aside>
    );
  }
  if (emails.length === 0) {
    const title = classifying
      ? t('inboxClassifying', { count: String(fetchedCount ?? 0) })
      : refreshing
      ? t('inboxFetching')
      : t('inboxEmpty');
    const hint = classifying
      ? ''
      : refreshing
      ? ''
      : t('inboxEmptyHint');
    return (
      <aside style={shell}>
        <h2 style={heading}>
          <Icon name="inbox" size={14} />
          <span>{t('inboxTitle')}</span>
        </h2>
        <div style={emptyState}>
          <div style={emptyIcon} aria-hidden>
            <Icon name="inbox" size={28} />
          </div>
          <div style={emptyTitle}>{title}</div>
          {hint && <div style={emptyHint}>{hint}</div>}
        </div>
      </aside>
    );
  }

  const [filterOpen, setFilterOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<EmailCategory | ''>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'done'>('all');

  // Client-side filtering: AND combination of search + category + status.
  const filtered = useMemo(() => {
    let list = emails;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (c) =>
          (c.email.subject || '').toLowerCase().includes(q) ||
          (c.email.sender || c.email.from_ || c.email.from || '').toLowerCase().includes(q),
      );
    }
    if (categoryFilter) {
      list = list.filter((c) => c.category === categoryFilter);
    }
    if (statusFilter === 'done') {
      list = list.filter((c) => doneEmailIds?.has(c.email.id));
    } else if (statusFilter === 'pending') {
      list = list.filter((c) => !doneEmailIds?.has(c.email.id));
    }
    return list;
  }, [emails, searchQuery, categoryFilter, statusFilter, doneEmailIds]);

  const grouped = groupByCategory(filtered);

  return (
    <aside style={shell}>
      <h2 style={heading}>
        <Icon name="inbox" size={14} />
        <span>{t('inboxTitle')}</span>
        <span style={countBadge}>{emails.length}</span>
        <button
          type="button"
          onClick={() => setFilterOpen((v) => !v)}
          style={{
            ...filterToggleBtn,
            color: filterOpen ? tokens.color.brand : tokens.color.textMuted,
            background: filterOpen ? tokens.color.brandSoft : 'transparent',
            borderColor: filterOpen ? tokens.color.brandBorder : tokens.color.border,
          }}
          title={t('filterToggleTitle')}
          aria-pressed={filterOpen}
        >
          <Icon name="search" size={12} />
        </button>
      </h2>
      {filterOpen && (
        <div style={filterPanel}>
          <div style={searchRow}>
            <Icon name="search" size={12} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              style={searchInput}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                style={clearBtn}
                title={t('clearSearchTitle')}
              >
                <Icon name="x" size={10} strokeWidth={2.5} />
              </button>
            )}
          </div>
          <div style={filterRow}>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as EmailCategory | '')}
              style={filterSelect}
            >
              <option value="">{t('allCategories')}</option>
              {CATEGORY_ORDER.map((cat) => (
                <option key={cat} value={cat}>
                  {t(CATEGORY_LABEL_KEY[cat])}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | 'pending' | 'done')}
              style={filterSelect}
            >
              <option value="all">{t('statusAll')}</option>
              <option value="pending">{t('statusPending')}</option>
              <option value="done">{t('statusDone')}</option>
            </select>
          </div>
          {filtered.length !== emails.length && (
            <div style={filterResult}>
              {t('filterResult', { shown: filtered.length, total: emails.length })}
            </div>
          )}
        </div>
      )}
      {refreshing && (
        <div style={refreshBanner} title={t('refreshBannerTitle')}>
          <span style={refreshDot} /> {t('refreshBannerText')}
        </div>
      )}
      <div style={treeWrap}>
        {CATEGORY_ORDER.filter((c) => grouped[c]?.length).map((cat) => (
          <CategoryGroup
            key={cat}
            category={cat}
            emails={grouped[cat]!}
            activeEmailId={activeEmailId}
            doneEmailIds={doneEmailIds}
            onProcessSingle={onProcessSingle}
            onSelectEmail={onSelectEmail}
            actionsDisabled={actionsDisabled}
          />
        ))}
      </div>
      {/* Interaction hint — subtle, persistent nudge for first-time users */}
      <div style={interactionHint}>
        <Icon name="info" size={11} />
        <span>{t('inboxHint')}</span>
      </div>
    </aside>
  );
}

function CategoryGroup({
  category,
  emails,
  activeEmailId,
  doneEmailIds,
  onProcessSingle,
  onSelectEmail,
  actionsDisabled,
}: {
  category: EmailCategory;
  emails: ClassifiedEmail[];
  activeEmailId?: string | null;
  doneEmailIds?: ReadonlySet<string>;
  onProcessSingle?: (emailId: string) => void;
  onSelectEmail?: (emailId: string) => void;
  actionsDisabled?: boolean;
}) {
  const { t } = useI18n();
  const sorted = [...emails].sort((a, b) => b.priority - a.priority);
  return (
    <section style={catShell}>
      <header style={{ ...catHeader, color: CATEGORY_COLOR[category] }}>
        <Icon name={CATEGORY_ICON[category]} size={13} />
        <span>{t(CATEGORY_LABEL_KEY[category])}</span>
        <span style={catCount}>{emails.length}</span>
      </header>
      <ul style={list}>
        {sorted.map((c) => (
          <EmailRow
            key={c.email.id}
            classified={c}
            isActive={c.email.id === activeEmailId}
            isDone={!!doneEmailIds?.has(c.email.id)}
            onProcess={onProcessSingle}
            onSelect={onSelectEmail}
            actionsDisabled={actionsDisabled}
          />
        ))}
      </ul>
    </section>
  );
}

function EmailRow({
  classified,
  isActive,
  isDone,
  onProcess,
  onSelect,
  actionsDisabled,
}: {
  classified: ClassifiedEmail;
  isActive: boolean;
  isDone: boolean;
  onProcess?: (emailId: string) => void;
  onSelect?: (emailId: string) => void;
  actionsDisabled?: boolean;
}) {
  const { t } = useI18n();
  const senderRaw = classified.email.sender || classified.email.from_ || classified.email.from || '';
  const sender = friendlyName(senderRaw);
  // Inline action: show on every classified row so the user can force a
  // single-reply pipeline on ANY email. We deliberately don't gate on
  // ``needs_reply`` — real inboxes (especially IMAP) often have the LLM
  // mark everything as needs_reply=false (Gmail security alerts, vendor
  // welcome emails, etc.), which would hide the button entirely. Hiding
  // only the row that's already done or currently under review keeps the
  // UI honest without artificial restrictions.
  const showAction = !!onProcess && !isDone && !isActive;
  return (
    <li
      data-email-row=""
      title={classified.reason || classified.email.subject}
      onClick={() => onSelect?.(classified.email.id)}
      style={{
        ...row,
        cursor: onSelect ? 'pointer' : undefined,
        background: isActive
          ? tokens.color.brandSoft
          : isDone
          ? tokens.color.successSoft
          : tokens.color.bg,
        borderColor: isActive
          ? tokens.color.brandBorder
          : isDone
          ? '#bbf7d0'
          : 'transparent',
        boxShadow: isActive ? tokens.shadow.focus : undefined,
      }}
    >
      <div style={rowTop}>
        <PriorityBadge n={classified.priority} reply={classified.needs_reply} />
        <span style={subjectClip}>{classified.email.subject}</span>
      </div>
      <div style={rowBottom}>
        <span style={senderClip}>{sender}</span>
        {isDone && (
          <span style={doneTag}>
            <Icon name="check" size={10} strokeWidth={2.5} />
            <span>{t('doneLabel')}</span>
          </span>
        )}
        {isActive && <span style={activeTag}>{t('activeLabel')}</span>}
        {showAction && (
          <button
            data-process-btn=""
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onProcess?.(classified.email.id);
            }}
            disabled={actionsDisabled}
            style={{
              ...processBtn,
              cursor: actionsDisabled ? 'not-allowed' : 'pointer',
            }}
            title={t('processBtnTitle')}
          >
            <span>{t('processBtn')}</span>
          </button>
        )}
      </div>
    </li>
  );
}

function PriorityBadge({ n, reply }: { n: number; reply: boolean }) {
  const { t } = useI18n();
  let color: string = tokens.color.textSubtle;
  let bg: string = tokens.color.surface;
  if (n >= 80) {
    color = tokens.color.danger;
    bg = tokens.color.dangerSoft;
  } else if (n >= 50) {
    color = tokens.color.warning;
    bg = tokens.color.warningSoft;
  } else if (n >= 30) {
    color = tokens.color.info;
    bg = tokens.color.infoSoft;
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        borderRadius: tokens.radius.sm,
        background: bg,
        fontFamily: tokens.font.mono,
        fontSize: tokens.fontSize.xs,
        color,
        fontWeight: tokens.fontWeight.semibold,
        minWidth: 36,
        justifyContent: 'center',
      }}
      title={reply ? t('needsReplyTitle') : t('noReplyNeededTitle')}
    >
      {reply && <Icon name="corner-down-left" size={9} strokeWidth={2.5} />}
      <span>{n}</span>
    </span>
  );
}

function friendlyName(raw: string): string {
  // "Alice <alice@x.com>" → "Alice"
  const m = raw.match(/^([^<]+?)\s*<.*>$/);
  if (m) return m[1].trim();
  // "alice@x.com" → "alice"
  const at = raw.indexOf('@');
  if (at > 0) return raw.slice(0, at);
  return raw;
}

function groupByCategory(emails: ClassifiedEmail[]): Partial<Record<EmailCategory, ClassifiedEmail[]>> {
  const out: Partial<Record<EmailCategory, ClassifiedEmail[]>> = {};
  for (const e of emails) {
    (out[e.category] ||= []).push(e);
  }
  return out;
}

// ─── styles ─────────────────────────────────────────────────────────────────

const shell: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[3],
  padding: tokens.space[4],
  background: tokens.color.surface,
  borderRight: `1px solid ${tokens.color.border}`,
  overflowY: 'auto',
  minWidth: 0,
};

const heading: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.sm,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.textMuted,
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[2],
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  paddingBottom: tokens.space[2],
  marginBottom: tokens.space[2],
};

const countBadge: React.CSSProperties = {
  marginLeft: 'auto',
  background: tokens.color.brandSoft,
  color: tokens.color.brand,
  fontFamily: tokens.font.mono,
  fontSize: tokens.fontSize.xs,
  padding: '1px 8px',
  borderRadius: tokens.radius.pill,
  fontWeight: tokens.fontWeight.semibold,
  letterSpacing: 0,
};

const emptyState: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  color: tokens.color.textSubtle,
  padding: `${tokens.space[6]}px ${tokens.space[3]}px`,
  textAlign: 'center',
};

const emptyIcon: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: tokens.radius.lg,
  background: tokens.color.surface,
  border: `1px dashed ${tokens.color.borderStrong}`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: tokens.color.textDisabled,
  marginBottom: 6,
};

const emptyTitle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.textMuted,
};

const emptyHint: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
  lineHeight: 1.5,
};

const refreshBanner: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[2],
  margin: `0 0 ${tokens.space[3]} 0`,
  padding: `${tokens.space[2]} ${tokens.space[3]}`,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.brand,
  background: 'rgba(124, 92, 240, 0.08)',
  border: `1px solid rgba(124, 92, 240, 0.18)`,
  borderRadius: tokens.radius.sm,
};

const refreshDot: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: tokens.color.brand,
  animation: 'pulse 1.4s ease-in-out infinite',
  display: 'inline-block',
};

const treeWrap: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[3],
};

const catShell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[2],
};

const catHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: tokens.fontSize.xs,
  fontWeight: tokens.fontWeight.semibold,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  padding: `0 ${tokens.space[1]}px`,
};

const catCount: React.CSSProperties = {
  marginLeft: 'auto',
  fontFamily: tokens.font.mono,
  color: tokens.color.textSubtle,
  fontWeight: tokens.fontWeight.regular,
  letterSpacing: 0,
  textTransform: 'none',
};

const list: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const row: React.CSSProperties = {
  padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
  borderRadius: tokens.radius.md,
  cursor: 'pointer',
  transition: tokens.motion.fast,
  border: '1px solid transparent',
};

const rowTop: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[2],
  fontSize: tokens.fontSize.base,
  color: tokens.color.text,
};

const rowBottom: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  // gap (not space-between) so the button always lives at the very end —
  // ``space-between`` distributes children evenly when there's >2, which
  // made the button's position drift depending on how many tags showed.
  gap: tokens.space[2],
  marginLeft: 38,
  marginTop: 1,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
};

const subjectClip: React.CSSProperties = {
  flex: 1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
};

const senderClip: React.CSSProperties = {
  // flex: 1 + minWidth: 0 = the sender line collapses with ellipsis instead
  // of pushing siblings (especially the "↩ 处理" button) off the right edge.
  flex: 1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
};

const doneTag: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 3,
  color: tokens.color.success,
  fontFamily: tokens.font.mono,
  fontSize: 10,
  fontWeight: tokens.fontWeight.semibold,
  padding: '2px 6px',
  background: '#dcfce7',
  borderRadius: tokens.radius.sm,
};

const activeTag: React.CSSProperties = {
  color: tokens.color.brand,
  fontFamily: tokens.font.mono,
  fontSize: 10,
  fontWeight: tokens.fontWeight.semibold,
  padding: '2px 6px',
  background: tokens.color.brandSoft,
  border: `1px solid ${tokens.color.brandBorder}`,
  borderRadius: tokens.radius.sm,
};

const processBtn: React.CSSProperties = {
  // Filled chip-style — background color makes it actually noticeable
  // against the row's white background. Previous "transparent + 1px border"
  // styling blended in too much.
  marginLeft: 'auto',
  padding: '3px 8px',
  fontSize: 11,
  fontFamily: tokens.font.mono,
  fontWeight: tokens.fontWeight.semibold,
  color: 'white',
  background: tokens.color.brand,
  border: 'none',
  borderRadius: 4,
  whiteSpace: 'nowrap',
  flexShrink: 0,
  lineHeight: 1.2,
};

// ─── Filter panel styles ─────────────────────────────────────────────────────

const filterToggleBtn: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  borderRadius: tokens.radius.sm,
  border: '1px solid',
  cursor: 'pointer',
  flexShrink: 0,
  transition: tokens.motion.fast,
};

const filterPanel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[2],
  padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
  background: tokens.color.surface,
  borderBottom: `1px solid ${tokens.color.border}`,
};

const searchRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: `4px ${tokens.space[2]}px`,
  background: tokens.color.bg,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.textSubtle,
};

const searchInput: React.CSSProperties = {
  flex: 1,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontSize: tokens.fontSize.sm,
  color: tokens.color.text,
  fontFamily: tokens.font.sans,
  minWidth: 0,
};

const clearBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  borderRadius: '50%',
  border: 'none',
  background: tokens.color.surfaceHover,
  color: tokens.color.textMuted,
  cursor: 'pointer',
  flexShrink: 0,
};

const filterRow: React.CSSProperties = {
  display: 'flex',
  gap: tokens.space[2],
};

const filterSelect: React.CSSProperties = {
  flex: 1,
  padding: '4px 8px',
  fontSize: tokens.fontSize.xs,
  fontFamily: tokens.font.mono,
  color: tokens.color.text,
  background: tokens.color.bg,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  cursor: 'pointer',
  minWidth: 0,
};

const filterResult: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  fontFamily: tokens.font.mono,
  color: tokens.color.textSubtle,
  textAlign: 'center',
};

// ─── Restoring skeleton (used when App.tsx is hydrating a past session) ────

/**
 * InboxSkeleton — shimmer placeholders mimicking the rough shape of the
 * inbox tree (search bar + 3 category sections × 2-3 rows). Shown for the
 * brief window between user clicking a history row and getConversation
 * returning. Replaces ALL content (search input, filters, tree, empty
 * state) so the user doesn't see stale emails leak through.
 */
function InboxSkeleton() {
  return (
    <div style={skeletonShell}>
      <div style={{ ...skeletonBar, height: 32, borderRadius: tokens.radius.md }} />
      {[
        { title: 80, rows: 3 },
        { title: 60, rows: 2 },
        { title: 70, rows: 2 },
      ].map((section, i) => (
        <div key={i} style={skeletonSection}>
          <div style={{ ...skeletonBar, width: section.title, height: 10 }} />
          {Array.from({ length: section.rows }).map((_, j) => (
            <div key={j} style={skeletonRow}>
              <div style={skeletonDot} />
              <div style={skeletonRowBody}>
                <div style={{ ...skeletonBar, width: `${75 + j * 5}%` }} />
                <div style={{ ...skeletonBar, width: `${50 + j * 8}%`, height: 9, opacity: 0.7 }} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const skeletonShell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[4],
  padding: `${tokens.space[2]}px ${tokens.space[1]}px`,
};

const skeletonSection: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[2],
};

const skeletonRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: tokens.space[2],
  padding: `${tokens.space[2]}px ${tokens.space[1]}px`,
};

const skeletonDot: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  marginTop: 4,
  flexShrink: 0,
  background: `linear-gradient(90deg, ${tokens.color.surface} 25%, ${tokens.color.surfaceHover} 50%, ${tokens.color.surface} 75%)`,
  backgroundSize: '200px 100%',
  animation: 'shimmer 1.5s ease-in-out infinite',
};

const skeletonRowBody: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 0,
};

const skeletonBar: React.CSSProperties = {
  height: 12,
  borderRadius: tokens.radius.sm,
  background: `linear-gradient(90deg, ${tokens.color.surface} 25%, ${tokens.color.surfaceHover} 50%, ${tokens.color.surface} 75%)`,
  backgroundSize: '200px 100%',
  animation: 'shimmer 1.5s ease-in-out infinite',
};

const interactionHint: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
  borderTop: `1px solid ${tokens.color.borderSubtle}`,
  marginTop: 'auto',
  flexShrink: 0,
};
