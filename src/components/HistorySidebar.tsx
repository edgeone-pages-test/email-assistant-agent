/**
 * HistorySidebar — leftmost column, lists past conversations.
 *
 * Pattern follows ChatGPT / Claude: clicking an item switches the active
 * conversation; the active one is highlighted; "新会话" up top kicks off a
 * fresh ``conversation_id``.
 *
 * Data source: localStorage via ``../historyStorage``. The platform's
 * ``/email/history`` is NOT called on mount — we want instant first-paint
 * (0ms, no spinner) at the cost of cross-device sync. When localStorage is
 * empty (new device or cleared cache) we surface a "从云端恢复" button that
 * pulls the platform's authoritative list and merges it in.
 *
 * Title derivation: written by ``startRun`` in ``../App.tsx`` via
 * ``saveLocalConversation`` using the same "[task] xxx" label the backend
 * persists to ``metadata.title``. Both sides use first-write-wins so titles
 * are stable across re-runs of the same conversation_id.
 *
 * UX choices:
 *   - delete shows on row hover, never as a fixed icon — keeps the idle
 *     sidebar clean.
 *   - clicking the active row is a no-op (don't re-fetch / disturb state).
 *   - relative timestamps ("刚刚 / 5 分钟前 / 昨天 / 3 天前") so the user
 *     can scan recency without parsing absolute dates.
 */
import { useEffect, useState } from 'react';
import { tokens } from '../design-tokens';
import { Icon, IconSpinner } from '../icons';
import {
  deleteConversation,
  invalidateConversationCache,
  listConversations,
} from '../api';
import { useI18n } from '../i18n';
import {
  StoredConversation,
  getLocalConversations,
  mergeFromServer,
  removeLocalConversation,
} from '../historyStorage';

interface Props {
  /** The currently active conversation_id — that row gets the highlight. */
  activeId: string;
  /** Click on a row in the sidebar. Caller switches to that conversation. */
  onSelect: (id: string) => void;
  /** Bumped externally to force a re-read of localStorage (e.g. after App.tsx
   * called saveLocalConversation when a run completed). */
  refreshKey?: number;
  /** True while a run is in flight; we still allow switching but warn the
   * user (see the disabled style for non-active rows). */
  busy?: boolean;
}

export default function HistorySidebar({
  activeId,
  onSelect,
  refreshKey,
  busy,
}: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<StoredConversation[]>(() =>
    getLocalConversations(),
  );
  // For "从云端恢复" button — separate state so the button can show a spinner
  // without affecting list rendering.
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Re-read localStorage when refreshKey bumps. Effectively free (sync read).
  useEffect(() => {
    setItems(getLocalConversations());
  }, [refreshKey]);

  /** Pull the platform's authoritative list and merge into localStorage.
   * Append-only — never overwrites or removes existing local rows. Used on
   * a fresh device / cleared cache to recover historical conversations. */
  async function handleCloudRestore() {
    setRestoring(true);
    setRestoreError(null);
    try {
      const server = await listConversations({ force: true });
      mergeFromServer(server);
      setItems(getLocalConversations());
    } catch (e) {
      setRestoreError((e as Error).message);
    } finally {
      setRestoring(false);
    }
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    // Optimistic remove from BOTH UI state and localStorage.
    setItems((prev) => prev.filter((x) => x.id !== id));
    removeLocalConversation(id);
    // Drop the api.ts module cache too — relevant if the user later hits
    // "从云端恢复" within the 30s TTL (otherwise the deleted row would
    // re-appear from a stale cache entry).
    invalidateConversationCache();
    try {
      await deleteConversation(id);
      // If the deleted one was active, caller should have moved on already
      // (we don't call onNewSession from here — that's an explicit user
      // action, not a side-effect of cleanup).
    } catch {
      // Rollback on error: re-read localStorage. Note: we already removed
      // the row from localStorage above. We could re-insert here, but the
      // platform delete failure is rare enough that asking the user to
      // retry is acceptable; for now we let it stay removed locally.
      // Surface via error toast in a future iteration if it becomes an
      // issue.
      setItems(getLocalConversations());
    }
  }

  return (
    <aside style={shell}>
      <div style={topBar}>
        <h2 style={heading}>
          <Icon name="archive" size={13} />
          <span>{t('historyTitle')}</span>
        </h2>
      </div>

      {restoreError && (
        <div style={{ ...statusRow, color: tokens.color.danger }}>
          <Icon name="alert-circle" size={11} />
          <span>{restoreError}</span>
        </div>
      )}
      {items.length === 0 && (
        <div style={emptyHint}>
          <div style={emptyTitle}>{t('historyEmpty')}</div>
          <div style={emptySub}>
            {t('historyEmptyHint')}
          </div>
          {/* Cloud-restore button — only shown when the local index is empty
              (new device or cleared cache). Pulls the platform-side
              authoritative list and merges into localStorage. */}
          <button
            type="button"
            onClick={handleCloudRestore}
            disabled={restoring}
            style={cloudRestoreBtn}
          >
            {restoring ? <IconSpinner size={12} /> : <Icon name="refresh-cw" size={12} />}
            <span>{restoring ? t('historyRestoring') : t('historyRestore')}</span>
          </button>
        </div>
      )}

      <ul style={list}>
        {items.map((item) => {
          const isActive = item.id === activeId;
          return (
            <li
              key={item.id}
              onClick={() => !isActive && onSelect(item.id)}
              style={{
                ...row,
                background: isActive ? tokens.color.brandSoft : 'transparent',
                borderColor: isActive ? tokens.color.brandBorder : 'transparent',
                cursor: isActive ? 'default' : busy ? 'wait' : 'pointer',
                opacity: !isActive && busy ? 0.6 : 1,
              }}
              title={isActive ? t('historyCurrentSession') : t('historySwitchTo')}
            >
              <div style={titleRow}>
                <span
                  style={{
                    ...titleText,
                    color: isActive ? tokens.color.brand : tokens.color.text,
                    fontWeight: isActive
                      ? tokens.fontWeight.semibold
                      : tokens.fontWeight.medium,
                  }}
                >
                  {trimmed(item.title, t)}
                </span>
                <button
                  type="button"
                  onClick={(e) => handleDelete(item.id, e)}
                  style={deleteBtn}
                  title={t('historyDeleteTitle')}
                  aria-label={t('historyDeleteAria', { title: item.title })}
                >
                  <Icon name="trash-2" size={11} />
                </button>
              </div>
              <div style={metaRow}>
                <span>{relativeTime(item.updatedAt, t)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function trimmed(t: string, tr: (key: 'historyUntitled') => string): string {
  // The platform "[task] xxx" prefix in stored titles is good for
  // identification but visually heavy. Strip it for display.
  const stripped = t.replace(/^\s*\[task\]\s*/i, '').trim();
  return stripped.length > 36 ? stripped.slice(0, 36) + '…' : stripped || tr('historyUntitled');
}

type RelTimeT = (
  key: 'relJustNow' | 'relMinutesAgo' | 'relHoursAgo' | 'relDaysAgo',
  vars?: Record<string, string | number>,
) => string;

function relativeTime(ts: number, t: RelTimeT): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return t('relJustNow');
  if (diff < hour) return t('relMinutesAgo', { n: Math.floor(diff / minute) });
  if (diff < day) return t('relHoursAgo', { n: Math.floor(diff / hour) });
  if (diff < 7 * day) return t('relDaysAgo', { n: Math.floor(diff / day) });
  // Older than a week: show abs date "5/22"
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ─── styles ────────────────────────────────────────────────────────────────

const shell: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space[2],
  padding: tokens.space[3],
  background: tokens.color.surface,
  // No internal divider — the parent ChatLayout's overlay panel provides
  // the visual boundary (borderLeft + drop shadow).
  overflowY: 'auto',
  minWidth: 0,
};

const topBar: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: tokens.space[2],
  paddingBottom: tokens.space[2],
  borderBottom: `1px solid ${tokens.color.borderSubtle}`,
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
};

const list: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const row: React.CSSProperties = {
  padding: `${tokens.space[2]}px ${tokens.space[2]}px`,
  borderRadius: tokens.radius.md,
  border: '1px solid transparent',
  transition: tokens.motion.fast,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  position: 'relative',
};

const titleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[1],
  minWidth: 0,
};

const titleText: React.CSSProperties = {
  flex: 1,
  fontSize: tokens.fontSize.base,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
};

const deleteBtn: React.CSSProperties = {
  // Visible only on row hover via the parent's :hover — but inline styles
  // don't support pseudo-classes, so we rely on opacity transition + always-
  // present-but-faint approach. (Hover styling uses CSS in index.css.)
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  background: 'transparent',
  border: 'none',
  color: tokens.color.textSubtle,
  borderRadius: tokens.radius.sm,
  cursor: 'pointer',
  flexShrink: 0,
  // We dim the trash icon by default; index.css ``.history-row:hover``
  // brightens it. Without that CSS hook it's still visible enough to find.
  opacity: 0.5,
};

const metaRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
  fontFamily: tokens.font.mono,
};

const statusRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: `${tokens.space[2]}px ${tokens.space[1]}px`,
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
};

const emptyHint: React.CSSProperties = {
  padding: `${tokens.space[3]}px ${tokens.space[2]}px`,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const emptyTitle: React.CSSProperties = {
  fontSize: tokens.fontSize.sm,
  color: tokens.color.textMuted,
  fontWeight: tokens.fontWeight.medium,
};

const emptySub: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
  lineHeight: 1.5,
};

const cloudRestoreBtn: React.CSSProperties = {
  marginTop: tokens.space[3],
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: `${tokens.space[2]}px ${tokens.space[3]}px`,
  background: tokens.color.brandSoft,
  border: `1px solid ${tokens.color.brandBorder}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.brand,
  fontSize: tokens.fontSize.xs,
  fontWeight: tokens.fontWeight.medium,
  cursor: 'pointer',
  alignSelf: 'flex-start',
};
