/**
 * SSE plumbing — exposes ``runEmailAssistant`` and ``submitReview`` that
 * stream frames back to the caller. Each frame is a parsed object with the
 * optional ``event`` name and the JSON-decoded payload.
 *
 * Mirrors the platform SSE format produced by ``ctx.utils.sse(...)``:
 *
 *   event: state_update
 *   data: {"node": "...", "state": {...}}
 *
 *   event: human_review_required
 *   data: {"type": "...", "draft": {...}, "options": [...], "remaining": 2}
 *
 *   event: end
 *   data: "[DONE]"
 */
import type { ReviewDecisionInput, RunTask, SSEFrame } from './types';

export type { SSEFrame };

export interface RunEmailOptions {
  task: RunTask;
  conversationId: string;
  signal?: AbortSignal;
  /** UI locale ("zh" | "en") from useI18n(). The backend uses it to pick
   * the reply-draft language, the digest language, and all SSE narration
   * strings, so the agent's output always matches what the user sees. */
  locale: 'zh' | 'en';
  /**
   * Optional snapshot of a previously-classified inbox. When present, the
   * backend ``fetch`` and ``classify`` nodes short-circuit, saving one IMAP
   * round-trip and the LLM batch-classify call (~10-15s typical). Frontend
   * passes this on task switches; user can override with a "force refresh"
   * button to drop the cache and re-fetch from the mailbox.
   */
  preloadedClassified?: unknown[];
  /**
   * Required when ``task === "single_reply"``: the id of the one email
   * the backend should narrow to in the prioritize node. Ignored for
   * other tasks.
   */
  targetEmailId?: string;
  /**
   * Email ids the user already processed (e.g. via earlier single_reply
   * clicks). In ``daily_digest`` mode, the prioritize node filters these
   * out so we don't re-prompt the user on the same email. Ignored for
   * ``single_reply`` (explicit user picks always win) and ``triage_only``.
   */
  skipEmailIds?: string[];
  /** True when the user explicitly clicked "强制刷新". Tells the backend
   * to wipe the checkpointed inbox state (classified / inbox / prioritized
   * / cursor) before running, otherwise LangGraph's reducer preserves the
   * stale snapshot and fetch's short-circuit returns the same emails. */
  forceRefresh?: boolean;
}

export interface SubmitReviewOptions {
  conversationId: string;
  decision: ReviewDecisionInput;
  signal?: AbortSignal;
  /** UI locale — drives the decision/draft-preview labels review.py writes
   * into chat history. */
  locale: 'zh' | 'en';
}

export async function* runEmailAssistant(opts: RunEmailOptions): AsyncGenerator<SSEFrame> {
  const body: Record<string, unknown> = { task: opts.task, locale: opts.locale };
  if (opts.preloadedClassified && opts.preloadedClassified.length > 0) {
    body.preloaded_classified = opts.preloadedClassified;
  }
  if (opts.targetEmailId) {
    body.target_email_id = opts.targetEmailId;
  }
  if (opts.skipEmailIds && opts.skipEmailIds.length > 0) {
    body.skip_email_ids = opts.skipEmailIds;
  }
  if (opts.forceRefresh) {
    body.force_refresh = true;
  }
  yield* streamSSE('/email/run', body, opts.conversationId, opts.signal);
}

export async function* submitReview(opts: SubmitReviewOptions): AsyncGenerator<SSEFrame> {
  // Backend expects ``decision`` field name; ReviewDecisionInput already has ``action`` etc.
  // Map ``action`` → ``decision`` for the wire format consumed by review.py.
  const { action, edited_body, feedback } = opts.decision;
  const wireBody: Record<string, unknown> = { decision: action, locale: opts.locale };
  if (edited_body !== undefined) wireBody.edited_body = edited_body;
  if (feedback !== undefined) wireBody.feedback = feedback;
  yield* streamSSE('/email/review', wireBody, opts.conversationId, opts.signal);
}

// ─── stop / history (non-streaming, plain JSON) ─────────────────────────────

/** Pull the JSON body and lift any ``error`` field from it into a thrown
 * Error. Most of the platform's error responses look like
 * ``{"error": "...", "type": "MemoryValidationError"}`` — without this
 * helper, the user just sees "500" and we lose the actionable detail.
 */
async function jsonOrThrow(res: Response, label: string): Promise<unknown> {
  // Always read the body — even on success it's the payload we want.
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const detail =
      (parsed && typeof parsed === 'object' && (parsed as { error?: string }).error) ||
      (typeof parsed === 'string' ? parsed : '') ||
      `${res.status} ${res.statusText}`;
    throw new Error(`${label} ${res.status}: ${detail}`);
  }
  return parsed;
}

/** Abort the in-flight run for the given conversation_id. The backend's
 * ``stop.py`` calls ``ctx.utils.abortActiveRun`` which raises
 * ``CancelledError`` inside the running handler — the SSE stream notices
 * via ``request.signal`` and bails. Idempotent: returns ``status=idle`` if
 * nothing is running. */
export async function stopRun(conversationId: string): Promise<{ status: string }> {
  const res = await fetch('/email/stop', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'makers-conversation-id': conversationId,
    },
    body: JSON.stringify({ conversationId }),
  });
  return (await jsonOrThrow(res, '/email/stop')) as { status: string };
}

export interface ConversationListItem {
  id: string;
  title: string;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
}

// ─── Conversation list cache (in-memory, single tab) ────────────────────────
//
// The /email/history list call is mostly idempotent on a quiet UI — the same
// conversations come back unchanged for tens of seconds. Caching with a 30s
// TTL turns "open history drawer" from a 200-800ms wait (10+ items, even after
// the backend's parallel title fetch) into an instant render on the second
// open. Invalidate explicitly after run finishes / new session / delete.
//
// In-flight dedupe: HistorySidebar can mount/re-mount in quick succession
// (drawer animation, refreshKey changes). _inflight ensures only one network
// request runs at a time.
//
// Epoch trick: invalidate bumps _epoch. A fetch that started before invalidate
// will check _epoch on resolve — if it doesn't match, it skips the cache write
// (its result is stale relative to whatever event triggered the invalidate).
// This avoids "stale snapshot persisted for 30s after a delete/run" without
// the complexity of AbortController plumbing.
let _cache: { items: ConversationListItem[]; ts: number } | null = null;
let _inflight: Promise<ConversationListItem[]> | null = null;
let _epoch = 0;
const CACHE_TTL_MS = 30_000;

export interface StoredMessage {
  /** Message-id assigned by the platform (msg_xxx). */
  message_id?: string;
  messageId?: string;
  role: string;
  content: unknown;
  createdAt?: number;
  created_at?: number;
  metadata?: Record<string, unknown>;
}

export interface ConversationDetail {
  id: string;
  messages: StoredMessage[];
  /** Snapshot of the LangGraph state's ``values`` dict — used by App.tsx to
   * rebuild the inbox tree (classified) and per-row done markers. */
  state: Record<string, unknown> | null;
  /** Names of nodes the LangGraph checkpointer says are "next to run".
   * When the graph is paused at an HITL ``interrupt()`` this contains
   * ``["review"]`` — frontend uses it (combined with ``state.pending_review``)
   * to re-render the DraftReviewCard after a page refresh, so the user can
   * pick up where they left off. */
  nextNodes?: string[];
}

/** Send the conversation_id header even though /email/history doesn't read
 * ``ctx.conversation_id`` for list/delete — keeps logs grouped by tab and
 * lets the platform handle CORS/session middleware uniformly across handlers. */
async function postHistory(body: Record<string, unknown>, conversationId?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'makers-conversation-id': conversationId || crypto.randomUUID(),
  };
  const res = await fetch('/email/history', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return jsonOrThrow(res, '/email/history');
}

export async function listConversations(opts?: { force?: boolean }): Promise<ConversationListItem[]> {
  if (!opts?.force && _cache && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return _cache.items;
  }
  // Dedupe concurrent fetches: if a request is already in flight, return its
  // promise instead of starting a parallel one. The HistorySidebar can mount
  // and re-mount quickly (drawer toggle) — without this, each mount fires its
  // own request.
  if (_inflight) return _inflight;
  const startEpoch = _epoch;
  _inflight = (async () => {
    try {
      const data = (await postHistory({ action: 'list' })) as { conversations?: ConversationListItem[] };
      const items = data.conversations ?? [];
      // Only write to cache if no invalidate happened mid-flight. Otherwise
      // we'd persist a stale snapshot for up to CACHE_TTL_MS. The current
      // caller still receives ``items`` (it was committed to this fetch);
      // the next caller sees ``_cache=null`` and triggers a fresh fetch.
      if (_epoch === startEpoch) {
        _cache = { items, ts: Date.now() };
      }
      return items;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/** Synchronously read the cached conversation list, or null if cold/stale.
 * Used by HistorySidebar on mount to render instantly when a recent fetch
 * is still warm — avoiding the loading-skeleton flash on every drawer open. */
export function getCachedConversations(): ConversationListItem[] | null {
  if (!_cache) return null;
  if (Date.now() - _cache.ts > CACHE_TTL_MS) return null;
  return _cache.items;
}

/** Drop the cache and bump the in-flight epoch so any pending fetch's
 * write-back is discarded. Call this after any mutation that invalidates
 * the list: run finishes, new session created, conversation deleted. */
export function invalidateConversationCache(): void {
  _cache = null;
  _epoch++;
}

export async function getConversation(id: string): Promise<ConversationDetail> {
  return (await postHistory({ action: 'get', id }, id)) as ConversationDetail;
}

export async function deleteConversation(id: string): Promise<{ deleted: boolean }> {
  return (await postHistory({ action: 'delete', id }, id)) as { deleted: boolean };
}

/** Fetch the health endpoint to detect current email provider (mock/imap/gmail). */
export async function getEmailProvider(): Promise<string> {
  try {
    const res = await fetch('/email/health', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'makers-conversation-id': crypto.randomUUID(),
      },
      body: '{}',
    });
    const data = (await res.json()) as { emailProvider?: string };
    return data.emailProvider || 'mock';
  } catch {
    return 'mock';
  }
}

async function* streamSSE(
  path: string,
  body: unknown,
  conversationId: string,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Platform-specific header — the Makers agent runtime resolves
      // ``context.conversation_id`` from this header.
      'makers-conversation-id': conversationId,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.body) {
    throw new Error(`No SSE body from ${path}`);
  }
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`${path} returned ${res.status}: ${errorText.slice(0, 256)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let frameEnd: number;
    while ((frameEnd = buffer.indexOf('\n\n')) >= 0) {
      const rawFrame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const parsed = parseFrame(rawFrame);
      if (parsed) yield parsed;
    }
  }
  if (buffer.trim()) {
    const parsed = parseFrame(buffer);
    if (parsed) yield parsed;
  }
}

function parseFrame(raw: string): SSEFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const text = dataLines.join('\n');
  let data: unknown = text;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      data = JSON.parse(text);
    } catch {
      // keep as raw string
    }
  }
  return { event, data };
}
