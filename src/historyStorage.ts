/**
 * historyStorage — pure-frontend conversation index, persisted to localStorage.
 *
 * The platform's ``ctx.store`` is single source of truth for messages and
 * metadata, but listing it requires a network round-trip + per-row ``[task]``
 * derivation. For sidebar UX we want INSTANT (0ms, synchronous) access to
 * "what conversations does the user have", so we mirror a thin index here.
 *
 * Trade-offs (matches the reference templates ``crewai-planner-python`` and
 * ``deepagents-research-python``):
 *
 *   - ✓ instant first-paint of the sidebar (no spinner)
 *   - ✓ no backend dependency on the hot path — drawer open is local
 *   - ✗ NOT cross-device synced — delete on device A doesn't disappear from
 *     device B. The "从云端恢复" button (HistorySidebar) handles new-device
 *     bootstrap by pulling the platform's authoritative list and merging.
 *
 * First-write-wins on ``title`` (matches backend ``_maybe_set_title_first_run``
 * semantics in ``agents/email/run.py``): re-running tasks on the same
 * conversation_id keeps the FIRST task's label as the sidebar title.
 * ``updatedAt`` is always bumped so re-running floats the row to the top.
 */
import type { ConversationListItem, StoredMessage } from './api';

const STORAGE_KEY = 'email-assistant-conversations';
// 30 vs the reference templates' 20: this template runs MULTIPLE tasks
// (triage_only / daily_digest / single_reply) per conversation_id, so each
// row represents richer activity. 30 keeps a couple of weeks' worth of
// daily-digest sessions accessible without manual cleanup.
const MAX_ITEMS = 30;

export interface StoredConversation {
  id: string;
  title: string;
  /** Original task that created the conversation. Optional because URL-shared
   * sessions imported via ``deriveTitleFromMessages`` don't know the task. */
  task?: string;
  /** First-creation timestamp (ms since epoch). Set on insert; never updated. */
  createdAt: number;
  /** Last activity timestamp (ms since epoch). Bumped on every save/touch. */
  updatedAt: number;
}

// ─── Read ──────────────────────────────────────────────────────────────────

/** Returns the local list, sorted by ``updatedAt`` descending. Always returns
 * an array — corruption / non-array contents fall back to ``[]`` silently
 * (defensive against hand-edited or browser-extension-modified storage). */
export function getLocalConversations(): StoredConversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Item-level shape guard: any element missing the required fields is
    // dropped rather than poisoning the rest of the list.
    const valid = parsed.filter(
      (item: unknown): item is StoredConversation =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { title?: unknown }).title === 'string' &&
        typeof (item as { createdAt?: unknown }).createdAt === 'number' &&
        typeof (item as { updatedAt?: unknown }).updatedAt === 'number',
    );
    return valid.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

// ─── Write ─────────────────────────────────────────────────────────────────

function _writeRaw(items: StoredConversation[]): void {
  try {
    // Cap at MAX_ITEMS by trimming the oldest. We sort here to make the
    // truncation deterministic (drop bottom of updatedAt-desc list).
    const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt);
    const capped = sorted.slice(0, MAX_ITEMS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // QuotaExceeded or storage unavailable (private mode + Safari) — nothing
    // we can do here that's better than dropping the write. The next read
    // returns whatever was persisted last.
  }
}

/**
 * Upsert a conversation. First-write-wins for ``title`` and ``task``: if the
 * id exists, only ``updatedAt`` is bumped (NEVER overwrites the original
 * title). This matches the platform-side ``_maybe_set_title_first_run``
 * semantics so a sidebar entry's display name is stable across re-runs.
 */
export function saveLocalConversation(
  id: string,
  title: string,
  task?: string,
): void {
  if (!id) return;
  const list = getLocalConversations();
  const now = Date.now();
  const existing = list.find((c) => c.id === id);
  if (existing) {
    // Bump updatedAt only — title and task are immutable on the local index.
    existing.updatedAt = now;
    _writeRaw(list);
    return;
  }
  // Insert new row. Neutral fallback title — HistorySidebar localizes its
  // own "(untitled)" via i18n when the stored title is empty after trimming.
  list.unshift({
    id,
    title: title || '(untitled)',
    task,
    createdAt: now,
    updatedAt: now,
  });
  _writeRaw(list);
}

/** Bump ``updatedAt`` only. No-op if the id isn't already present. Useful
 * for "this conversation is still alive" without changing display data. */
export function touchLocalConversation(id: string): void {
  const list = getLocalConversations();
  const item = list.find((c) => c.id === id);
  if (!item) return;
  item.updatedAt = Date.now();
  _writeRaw(list);
}

/** Remove an entry. Idempotent — no-op if id isn't present. */
export function removeLocalConversation(id: string): void {
  const list = getLocalConversations().filter((c) => c.id !== id);
  _writeRaw(list);
}

/**
 * Append-only merge of platform-side conversation list into local index.
 * Used by HistorySidebar's "从云端恢复" button on new-device bootstrap.
 *
 * Contract:
 *   - server items NOT in local index → appended (with default createdAt /
 *     updatedAt = ``lastMessageAt``)
 *   - server items already in local index → SKIPPED (local data wins —
 *     never resurrects rows the user might have removed locally, never
 *     overwrites a title the user has implicitly accepted by leaving it)
 *
 * Returns nothing; caller should re-read via ``getLocalConversations()``.
 */
export function mergeFromServer(items: ConversationListItem[]): void {
  const local = getLocalConversations();
  const localIds = new Set(local.map((c) => c.id));
  const additions: StoredConversation[] = [];
  for (const it of items) {
    if (!it || !it.id || localIds.has(it.id)) continue;
    additions.push({
      id: it.id,
      title: it.title || '(untitled)',
      // task unknown — server's ConversationListItem doesn't carry it
      createdAt: it.createdAt || it.lastMessageAt || Date.now(),
      updatedAt: it.lastMessageAt || it.createdAt || Date.now(),
    });
  }
  if (additions.length === 0) return;
  _writeRaw([...local, ...additions]);
}

// ─── Title derivation (for URL-shared sessions imported via restoreSession) ─

/**
 * Derive a sidebar title from a conversation's stored messages. Used when
 * a user opens a shared URL (``?id=conv_xxx``) on a fresh device — the
 * conversation has content on the platform but no localStorage entry, so
 * we synthesize one with a title pulled from the messages.
 *
 * Mirrors the backend ``history.py:_derive_title``: prefer the FIRST
 * user-role message; fall back to first non-empty content of any role;
 * cap at 60 chars.
 */
export function deriveTitleFromMessages(messages: StoredMessage[]): string {
  if (!messages || messages.length === 0) return '';
  // 1st pass: first user-role message
  for (const m of messages) {
    if ((m.role || '').toLowerCase() === 'user') {
      const t = _extractText(m.content);
      if (t) return t.slice(0, 60);
    }
  }
  // 2nd pass: first non-empty message of any role (matches backend fallback)
  for (const m of messages) {
    const t = _extractText(m.content);
    if (t) return t.slice(0, 60);
  }
  return '';
}

function _extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Multimodal — pick the first text-ish chunk
    for (const c of content) {
      if (typeof c === 'string' && c) return c;
      if (c && typeof c === 'object') {
        const obj = c as { text?: unknown; content?: unknown };
        if (typeof obj.text === 'string' && obj.text) return obj.text;
        if (typeof obj.content === 'string' && obj.content) return obj.content;
      }
    }
  }
  return '';
}
