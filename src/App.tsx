/**
 * App — top-level shell. Owns the SSE state machine that drives all three
 * columns:
 *   - left  ── EmailInboxTree         (built from state_update.classify / .prioritize)
 *   - center── ConversationStream     (timeline of messages + inline DraftReviewCard)
 *   - right ── NodeFlowVisualizer     (per-node status from state_update keys)
 *
 * State design notes:
 *   - `messages` is append-only; older frames stay visible.
 *   - `nodeStatuses` advances on each state_update (any payload from node X
 *     means X is now done — LangGraph emits AFTER the node returns).
 *   - The "active" node is whichever was last started but not yet completed.
 *     We surface it as ``active``; on `human_review_required` the review
 *     node flips to ``paused`` instead.
 *   - Decision echoes happen optimistically before the SSE response so the
 *     conversation flow doesn't feel laggy.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import ChatLayout from './components/ChatLayout';
import ConversationStream, {
  StreamMessage,
  StreamMessageKind,
} from './components/ConversationStream';
import DeployButton, { GitHubButton } from './components/DeployFAB';
import EmailDetailDrawer from './components/EmailDetailDrawer';
import EmailInboxTree from './components/EmailInboxTree';
import HistorySidebar from './components/HistorySidebar';
import NodeFlowVisualizer from './components/NodeFlowVisualizer';
import { useI18n, type TranslationKey } from './i18n';
import {
  getConversation,
  getEmailProvider,
  invalidateConversationCache,
  runEmailAssistant,
  stopRun as apiStopRun,
  StoredMessage,
  submitReview,
} from './api';
import {
  deriveTitleFromMessages,
  getLocalConversations,
  removeLocalConversation,
  saveLocalConversation,
} from './historyStorage';
import { Icon, IconSpinner } from './icons';
import type {
  ClassifiedEmail,
  DraftItem,
  NodeStatus,
  PipelineNode,
  ProgressPayload,
  ReviewDecisionInput,
  RunTask,
  SSEFrame,
} from './types';
import { tokens } from './design-tokens';

/** Friendly label key per task — matches the backend's append_message
 * content prefix so a fresh-run session line and a restored-from-history line
 * read identically in the timeline. */
const TASK_LABEL_KEY: Record<RunTask, TranslationKey> = {
  triage_only: 'taskLabelTriage',
  daily_digest: 'taskLabelDaily',
  single_reply: 'taskLabelSingle',
};

const SESSION_ID_KEY = 'email-assistant-conv-id';

/** Read or create a stable conversation_id for this browser session.
 * Priority: URL ?id= (link sharing) → localStorage → fresh UUID. */
function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') return generateConvId();
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('id');
    if (fromUrl) return fromUrl;
    const fromLs = window.localStorage.getItem(SESSION_ID_KEY);
    if (fromLs) return fromLs;
  } catch {
    // localStorage may throw in incognito/sandbox; ignore.
  }
  return generateConvId();
}

function generateConvId(): string {
  return `email-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Persist the active conversation id to localStorage AND the URL bar so
 * the user can copy-paste the link to resume the same session later. */
function persistSessionId(id: string): void {
  try {
    window.localStorage.setItem(SESSION_ID_KEY, id);
  } catch {
    /* noop */
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('id', id);
    window.history.replaceState(null, '', url);
  } catch {
    /* noop */
  }
}

/** Map a stored message (from /email/history) into a timeline StreamMessage.
 * The backend writes role + metadata.kind, we map both into our frontend
 * StreamMessageKind enum so the bubble styling matches what the user saw
 * during the original run. */
function storedToStreamMessage(m: StoredMessage, idx: number): StreamMessage {
  const role = (m.role || '').toLowerCase();
  const meta = (m.metadata || {}) as Record<string, unknown>;
  const kindHint = String(meta.kind || '');
  let kind: StreamMessageKind = 'system';
  if (role === 'user') {
    kind = kindHint === 'decision' ? 'decision' : 'session';
  } else if (role === 'assistant') {
    kind = kindHint === 'summary' ? 'summary' : 'review';
  }
  const text = typeof m.content === 'string' ? m.content : '';
  return {
    id: m.message_id ?? m.messageId ?? `restored-${idx}`,
    ts: m.createdAt ?? m.created_at ?? Date.now(),
    kind,
    text,
  };
}

interface PendingDraft {
  draft: DraftItem;
  remaining: number;
}

// ─── Reducer for pipeline state derived from SSE frames ─────────────────────

interface PipelineState {
  classified: ClassifiedEmail[];
  doneEmailIds: Set<string>;
  activeEmailId: string | null;
  nodeStatuses: Partial<Record<PipelineNode, NodeStatus>>;
  /** Per-run progress counters. Reset on every ``reset`` action so the
   * "X / Y" indicator never spans runs (avoids the 2/4 → 5/3 jump that
   * happened when daily_digest re-derived totals after single_reply). */
  runIteration: number;
  runTotal: number;
  /** Nodes whose payload included ``_cached: true`` THIS run — rendered as
   * "缓存" pills in the pipeline column instead of ✓ done. Reset per-run. */
  cachedNodes: Set<PipelineNode>;
  /** Snapshot of fetch.inbox.length, used to render
   * "已拉取 X 封,正在分类..." while classify is still running. Reset per-run. */
  fetchedCount: number;
  /** True once classify and prioritize have produced data for this run.
   * Subsequent re-emissions (e.g. when the backend re-runs the full pipeline
   * on resume — a known LangGraph quirk) are ignored to keep the UI stable. */
  scoresLocked: boolean;
  /** Current task — drives reducer behavior (e.g. ``single_reply`` should NOT
   * overwrite ``classified``: it only touches one email). */
  currentTask: RunTask | null;
}

const INITIAL_PIPELINE: PipelineState = {
  classified: [],
  doneEmailIds: new Set(),
  activeEmailId: null,
  nodeStatuses: {},
  runIteration: 0,
  runTotal: 0,
  cachedNodes: new Set(),
  fetchedCount: 0,
  scoresLocked: false,
  currentTask: null,
};

type PipelineAction =
  | { type: 'reset'; task: RunTask; clearDone?: boolean; clearClassified?: boolean }
  | { type: 'state_update'; payload: Record<string, unknown> }
  | { type: 'paused'; emailId: string }
  | { type: 'decision'; emailId: string }
  | { type: 'regenerate'; emailId: string }
  | { type: 'error' }
  | { type: 'stop' }
  /** Hydrate the inbox + done markers from a restored conversation snapshot.
   * Used when the user clicks a row in HistorySidebar — we drop the run-level
   * counters back to 0 (no run is in flight) but keep the persisted classified
   * + per-row "✓" markers so the UI matches what they had when they left.
   *
   * ``pausedAtReview``: when set, the graph was at an HITL interrupt when
   * the user closed/refreshed the tab. We seed runIteration/runTotal so the
   * "X / Y" counter is accurate, mark fetch through draft as done and review
   * as paused, and stamp activeEmailId so the left column highlights the
   * row matching the resumed draft. The DraftReviewCard itself is brought
   * back via ``setPending`` in the caller. */
  | {
      type: 'restore';
      classified: ClassifiedEmail[];
      doneEmailIds: ReadonlySet<string>;
      pausedAtReview?: { emailId: string; iteration: number; total: number };
    };

function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  switch (action.type) {
    case 'reset':
      // Carry over the inbox snapshot AND the per-session "✓ done" markers
      // from previous runs by default — multi-step workflows (e.g. several
      // single_reply clicks in a row) accumulate progress instead of
      // wiping the left column. ``clearClassified`` opts out for "force
      // refresh" (we want fresh data, not the old snapshot to keep
      // showing) and "新会话" (true fresh slate). ``clearDone`` is a
      // separate axis — also forced by both opt-out flows.
      //
      // Per-run fields (runIteration / runTotal / cachedNodes / fetchedCount)
      // are ALWAYS reset so the progress indicator reflects only the current
      // run. This avoids the cross-run "2 of 4 → 5 of 3" math glitch.
      return {
        ...INITIAL_PIPELINE,
        classified: action.clearClassified ? [] : state.classified,
        doneEmailIds: action.clearDone ? new Set() : state.doneEmailIds,
        currentTask: action.task,
      };
    case 'state_update': {
      // LangGraph stream_mode="updates" emits {nodeName: {…patch…}} per step.
      const next = {
        ...state,
        nodeStatuses: { ...state.nodeStatuses },
        cachedNodes: new Set(state.cachedNodes),
      };
      // single_reply runs only touch one email — they must not overwrite
      // the inbox-wide snapshot (classified) coming from a previous broader
      // run. Otherwise the left column would shrink to just the one email.
      const isSingle = state.currentTask === 'single_reply';
      for (const [nodeName, patch] of Object.entries(action.payload)) {
        // ─── Regenerate pass-through suppression ───────────────────────
        //
        // During a regenerate flow the event sequence is:
        //   review state_update → (routing) → draft state_update → interrupt
        //
        // The ``regenerate`` reducer action already set draft='active' and
        // review='pending'. If we naively mark review='done' on its
        // state_update, the user sees "draft active + review done" for the
        // entire 20-30s CrewAI draft generation. Suppress the 'done' mark
        // for review when we know we're mid-regenerate (signaled by
        // state.nodeStatuses.draft === 'active' — ONLY the regenerate
        // action puts draft in this state while review is happening).
        // Similarly, suppress ``apply=done`` when draft is currently active
        // — the apply patch is a residual from the PREVIOUS iteration that
        // arrived after the new draft already started (LangGraph updates
        // stream is not strictly ordered within loop-backs).
        // Note: a final LOOP coherence guard below catches any remaining
        // edge cases after all patches are processed.
        const suppressDone =
          nodeName === 'review' && state.nodeStatuses.draft === 'active';

        if (!suppressDone) {
          // Mark this node done…
          next.nodeStatuses[nodeName as PipelineNode] = 'done';
        }

        // Per-iteration sync: when ``draft`` runs again (next email or
        // regenerate), the previous iteration's review/apply/summarize
        // are still marked ``done`` from before. Wipe them back to
        // ``pending`` so the user doesn't see a contradictory state like
        // "draft active + apply done". The subsequent ``paused`` action
        // (when interrupt fires) and follow-up state_update events will
        // re-mark them appropriately for the current iteration.
        if (nodeName === 'draft') {
          next.nodeStatuses.review = 'pending';
          next.nodeStatuses.apply = 'pending';
          next.nodeStatuses.summarize = 'pending';
        }
        if (!patch || typeof patch !== 'object') continue;
        const p = patch as Record<string, unknown>;
        // Backend short-circuit signal — fetch / classify return ``_cached:
        // true`` when they reused state["classified"] instead of doing real
        // work. Track per-node so the visualizer can render a "缓存" pill.
        if (p._cached === true) {
          next.cachedNodes.add(nodeName as PipelineNode);
        }
        // Capture inbox count from fetch (works for both cache hits AND
        // real fetches). Used by EmailInboxTree's transition state — we
        // can show "已拉取 N 封, 正在分类..." while classify is still busy.
        if (nodeName === 'fetch' && Array.isArray(p.inbox)) {
          next.fetchedCount = (p.inbox as unknown[]).length;
        }
        // Lock priorities + classified after the FIRST classify+prioritize.
        // The backend may re-emit these on resume (LLM is non-deterministic
        // → priority scores would jitter; total may differ across runs).
        if (!state.scoresLocked && !isSingle) {
          if (Array.isArray(p.classified)) {
            next.classified = p.classified as ClassifiedEmail[];
          }
          if (Array.isArray(p.prioritized)) {
            const byId = new Map(next.classified.map((c) => [c.email.id, c]));
            for (const pri of p.prioritized as ClassifiedEmail[]) {
              byId.set(pri.email.id, pri);
            }
            next.classified = Array.from(byId.values());
            next.scoresLocked = true;
          }
        }
        // runTotal: set ONCE per run from the first prioritize emission.
        // Locked thereafter — the cursor field grows as the user makes
        // decisions, runTotal stays put for stable "X / Y" display.
        if (
          next.runTotal === 0 &&
          nodeName === 'prioritize' &&
          Array.isArray(p.prioritized)
        ) {
          next.runTotal = (p.prioritized as ClassifiedEmail[]).length;
        }
        // cursor (from apply node) → runIteration. Authoritative source.
        if (typeof p.cursor === 'number') {
          next.runIteration = p.cursor;
          // ─── Loop-back detection ──────────────────────────────────────
          //
          // The pipeline is a LOOP: draft→review→apply→(draft or summarize).
          // After ``apply`` advances the cursor, if more emails remain the
          // graph loops back to ``draft`` for the next email. Without this
          // block, ALL nodes through apply are 'done' and
          // ``deriveActiveNode`` would highlight ``summarize`` as active —
          // confusing the user for the 20-30s until draft's next
          // state_update arrives.
          //
          // Fix: if cursor < runTotal (more emails to process), reset
          // draft/review to 'pending' so the linear scan in
          // deriveActiveNode correctly finds ``draft`` as the next active
          // node. If cursor >= runTotal, the graph IS going to summarize
          // so we leave things alone (deriveActiveNode will correctly mark
          // summarize active).
          if (next.runTotal > 0 && p.cursor < next.runTotal) {
            next.nodeStatuses.draft = 'pending';
            next.nodeStatuses.review = 'pending';
          }
        }
      }

      // ── Final sanity: LOOP coherence guard ────────────────────────────
      // The pipeline is a loop (draft → review → apply → draft|summarize).
      // Due to stream ordering non-determinism, a residual `apply=done`
      // from the previous iteration can slip through AFTER `draft` was
      // already set to `active` for the current iteration. This guard runs
      // AFTER all patches have been processed and enforces a single rule:
      //
      //   If draft is active, then review/apply/summarize CANNOT be done.
      //
      // This eliminates the visual glitch of "起草=进行中 + 应用=完成".
      if (next.nodeStatuses.draft === 'active') {
        if (next.nodeStatuses.review === 'done') next.nodeStatuses.review = 'pending';
        if (next.nodeStatuses.apply === 'done') next.nodeStatuses.apply = 'pending';
        if (next.nodeStatuses.summarize === 'done') next.nodeStatuses.summarize = 'pending';
      }

      return next;
    }
    case 'paused':
      // Reset later-stage nodes whenever we pause for review. Without
      // this, a previous iteration's "summarize/done" or "apply/done" can
      // linger and make the right column show contradictory state
      // (summarize ✓ AND review ⏸ at the same time).
      return {
        ...state,
        nodeStatuses: {
          ...state.nodeStatuses,
          review: 'paused',
          // 'apply' / 'summarize' / 'draft' belong to the iteration AFTER
          // the user decides — keep them clean for accurate visuals.
          apply: 'pending',
          summarize: 'pending',
        },
        activeEmailId: action.emailId,
      };
    case 'decision':
      return {
        ...state,
        activeEmailId: null,
        doneEmailIds: new Set([...state.doneEmailIds, action.emailId]),
        // Optimistic bump — the backend's apply will emit cursor and
        // overwrite this anyway, but bumping here makes the "X / Y"
        // counter feel snappy. (regenerate path doesn't bump — see below.)
        runIteration: state.runIteration + 1,
        // After the user submits, the next stream from review.py will
        // re-emit state_update for review/apply nodes. Mark the immediate
        // transition: review goes back to 'active' (apply runs first, then
        // possibly looping back to draft for the next email). We DON'T
        // touch apply / summarize here — the state_update reducer will set
        // apply to 'done' when it runs, then the next 'draft' state_update
        // will reset both apply and summarize back to 'pending' for the
        // new iteration (see the ``nodeName === 'draft'`` branch above).
        nodeStatuses: { ...state.nodeStatuses, review: 'active' },
      };
    case 'regenerate':
      // Regenerate keeps the SAME email active — backend will produce a new
      // draft for it. Critical: doneEmailIds and runIteration are NOT updated
      // (the email isn't done yet) so the progress counter doesn't jump.
      //
      // Pipeline sync: previous iteration may have left review/apply/summarize
      // looking ``done`` (if this is a repeated regenerate) — wipe them so the
      // user doesn't see "draft loading + apply ✓" simultaneously while the
      // new draft is being generated. The fresh state_update events from the
      // re-running graph will mark them again as the iteration proceeds.
      return {
        ...state,
        activeEmailId: action.emailId,
        nodeStatuses: {
          ...state.nodeStatuses,
          draft: 'active',
          review: 'pending',
          apply: 'pending',
          summarize: 'pending',
        },
      };
    case 'error':
      return {
        ...state,
        nodeStatuses: { ...state.nodeStatuses, ...errorStuckNode(state.nodeStatuses) },
      };
    case 'stop':
      // User clicked stop — clear all "in-flight" visuals: active/paused
      // nodes revert to pending, active email highlight clears.
      return {
        ...state,
        activeEmailId: null,
        nodeStatuses: Object.fromEntries(
          Object.entries(state.nodeStatuses).map(([k, v]) =>
            v === 'active' || v === 'paused' ? [k, 'pending'] : [k, v],
          ),
        ) as Partial<Record<PipelineNode, NodeStatus>>,
      };
    case 'restore': {
      // Wipe to a clean slate but keep the snapshot fields the user expects
      // to still see when they click a past conversation in HistorySidebar.
      // No run is in flight, so counters / cached-node flags / fetched count
      // start at zero — the next click on "处理待回邮件" will populate them.
      //
      // ``scoresLocked: true`` because we DO have a snapshot — without it,
      // the toolbar's "强制刷新" button hides (gated on scoresLocked &&
      // classified.length > 0). Force refresh issues a 'reset' first which
      // flips scoresLocked back to false, so the next live prioritize emit
      // can overwrite the restored data with fresh data.
      const base: PipelineState = {
        ...INITIAL_PIPELINE,
        classified: action.classified,
        doneEmailIds: new Set(action.doneEmailIds),
        scoresLocked: action.classified.length > 0,
      };
      // ``pausedAtReview``: graph was paused at HITL when the tab was closed.
      // Re-seed the per-run counters and node statuses so the UI matches what
      // the user left behind: pipeline shows "fetch ✓ classify ✓ prioritize ✓
      // draft ✓ review ⏸", counter shows X / Y, and the row of the email
      // currently being reviewed lights up in the left column.
      if (action.pausedAtReview) {
        return {
          ...base,
          activeEmailId: action.pausedAtReview.emailId,
          runIteration: action.pausedAtReview.iteration,
          runTotal: action.pausedAtReview.total,
          nodeStatuses: {
            fetch: 'done',
            classify: 'done',
            prioritize: 'done',
            draft: 'done',
            review: 'paused',
            apply: 'pending',
            summarize: 'pending',
          },
        };
      }
      return base;
    }
  }
}

/** Whichever node is currently active becomes the error focal point. */
function errorStuckNode(
  cur: Partial<Record<PipelineNode, NodeStatus>>,
): Partial<Record<PipelineNode, NodeStatus>> {
  const active = Object.entries(cur).find(([, v]) => v === 'active' || v === 'paused');
  if (!active) return {};
  return { [active[0] as PipelineNode]: 'error' };
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function App() {
  const { t, locale, toggleLocale } = useI18n();
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [pending, setPending] = useState<PendingDraft | null>(null);
  const [running, setRunning] = useState(false);
  const [pipeline, dispatchPipeline] = useReducer(pipelineReducer, INITIAL_PIPELINE);
  // Keep the browser tab title in sync with the UI locale (index.html ships
  // a neutral English title; zh users get the Chinese one once React mounts).
  useEffect(() => {
    document.title = `${t('appTitle')} · ${t('appSubtitle')} | EdgeOne Makers`;
  }, [t]);
  /** Stable for the lifetime of a "session" — multiple runs (triage_only,
   * single_reply, daily_digest) share this conversation_id so LangGraph's
   * checkpointer can accumulate state via the Annotated[..., add] reducers
   * (review_decisions, drafts, final_actions). The "新会话" button bumps it. */
  const conversationIdRef = useRef<string>('');
  const taskRef = useRef<RunTask | null>(null);
  // True once we've emitted the per-run "📥 收到 X 封邮件…" summary message —
  // prevents duplicates if the backend re-emits prioritize on resume.
  const summaryEmittedRef = useRef(false);
  // Synchronous mirror of doneEmailIds — used by handleFrame to detect
  // duplicate human_review_required events without waiting for React's
  // next render to commit the reducer state.
  const doneEmailIdsRef = useRef<Set<string>>(new Set());
  // Show the "checkpoint isn't persisting" warning at most once per run.
  const checkpointWarningShownRef = useRef(false);
  /** Bumped to force HistorySidebar to re-fetch — increment after every
   * run so a brand-new conversation appears in the list immediately. */
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  /** True while we're hydrating from a past conversation. Disables most
   * actions to avoid a click race during the round-trip. */
  const [restoring, setRestoring] = useState(false);
  /** Drawer open/close state — owned here so we can auto-close after
   * picking a row or clicking "新会话". */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Controls the custom confirmation modal for "AI 智能处理". */
  const [showAiConfirm, setShowAiConfirm] = useState(false);
  /** True after the mount-time restoreSession has resolved. Until then we
   * keep the conversation column in a loading state — without this gate,
   * the user sees the OnboardingPanel for ~200ms and then it abruptly
   * swaps to the restored timeline. */
  const [initialized, setInitialized] = useState(false);
  /** Current email provider detected from backend health endpoint.
   * Drives the onboarding panel's data-source indicator. */
  const [emailProvider, setEmailProvider] = useState<string>('mock');
  /** Latest narration line emitted by a node (via stream_mode="custom").
   * Renders as a live chip at the bottom of the conversation column so the
   * user sees what the backend is doing during long ops (classify ~10s,
   * draft ~20-30s) instead of staring at a frozen UI. Cleared on stream
   * end / pause / cancel so we never show a stale "thinking…" message. */
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  /** Token-by-token LLM output for the active phase (currently
   * ``summarize`` and ``draft``). Renders as a "live writing" bubble in
   * the conversation column with a blinking cursor, so users watch the
   * markdown / draft body materialize in real time. Replaced (not
   * appended-to) when the phase changes — e.g. summarize tokens never
   * mix with draft tokens. Cleared on the same events as ``progress``. */
  const [streamingText, setStreamingText] = useState<{
    phase: 'summarize' | 'draft';
    text: string;
  } | null>(null);
  /** Which email's detail drawer is open (null = closed). Set when the user
   * clicks an email row in the left column; cleared on close / Esc / backdrop. */
  const [selectedEmailId, setSelectedEmailId] = useState<string | null>(null);
  /** AbortController for the current streaming fetch (run / review). Aborting
   * this immediately terminates the client-side SSE connection. The server-side
   * `/stop` endpoint is a courtesy notification that also sets request.signal
   * on the backend handler, but the client abort is what gives instant UX. */
  const abortControllerRef = useRef<AbortController | null>(null);
  /** Accumulated draft outputs keyed by email_id. Populated from state_update
   * events (draft node emits ``pending_review``) and when the user submits an
   * "edit" decision (we store the final version). Used by EmailDetailDrawer to
   * show the draft for any email the user clicks — even after the HITL card
   * has been dismissed and we've moved on to the next email. */
  const [draftsMap, setDraftsMap] = useState<Map<string, DraftItem>>(new Map());

  const addMessage = useCallback((msg: Omit<StreamMessage, 'id' | 'ts'>) => {
    setMessages((prev) => [
      ...prev,
      { id: `m-${prev.length}-${Date.now()}`, ts: Date.now(), ...msg },
    ]);
  }, []);

  const handleFrame = useCallback(
    (frame: SSEFrame) => {
      const ev = frame.event;
      if (ev === 'session') {
        // First frame of every stream — only render verbose narration on the
        // very first `run` (skip resumed sessions to keep the timeline clean).
        // Use the same label format as backend's append_message so
        // restored timelines and live timelines look identical.
        const payload = (frame.data || {}) as { resumed?: boolean; task?: RunTask };
        if (!payload.resumed) {
          const label = payload.task
            ? t(TASK_LABEL_KEY[payload.task] ?? ('taskLabelDaily' as TranslationKey)) || payload.task
            : null;
          addMessage({
            kind: 'session',
            text: label ? `[task] ${label}` : t('sessionStarted'),
          });
        }
        return;
      }
      if (ev === 'progress' && typeof frame.data === 'object' && frame.data) {
        const payload = frame.data as ProgressPayload;
        // ``token`` stage is special — it's a token chunk, not narration.
        // Accumulate into ``streamingText`` so the conversation column can
        // render the LLM output as it streams. Reset to a fresh
        // {phase, text} when the phase changes (e.g. draft tokens don't
        // mix with the previous run's summarize tokens that haven't been
        // cleared yet).
        if (payload.stage === 'token' && payload.delta) {
          const phase = payload.phase as 'summarize' | 'draft';
          if (phase !== 'summarize' && phase !== 'draft') return;
          setStreamingText((prev) => {
            if (prev && prev.phase === phase) {
              return { phase, text: prev.text + payload.delta };
            }
            return { phase, text: payload.delta || '' };
          });
          return;
        }
        // Lifecycle event (started / completed / skipped / agent_start / etc.)
        // — feeds the chip + per-node sub-label. Don't push into messages.
        setProgress(payload);
        return;
      }
      if (ev === 'state_update' && typeof frame.data === 'object' && frame.data) {
        const payload = frame.data as Record<string, unknown>;
        // Skip the LangGraph-internal __interrupt__ event — handled via human_review_required
        if ('__interrupt__' in payload) return;
        dispatchPipeline({ type: 'state_update', payload });

        // ─── Draft accumulation for EmailDetailDrawer ─────────────────
        // The draft node emits ``pending_review`` (current draft); store it
        // keyed by email_id so the drawer can show it when the user clicks
        // an already-processed row. Apply node may also emit updated drafts
        // (after "edit" action), so check both.
        for (const patch of Object.values(payload)) {
          if (patch && typeof patch === 'object') {
            const p = patch as Record<string, unknown>;
            if (p.pending_review && typeof p.pending_review === 'object') {
              const d = p.pending_review as DraftItem;
              if (d.email_id) {
                setDraftsMap((prev) => new Map(prev).set(d.email_id, d));
              }
            }
            // drafts array (from apply with edited body)
            if (Array.isArray(p.drafts)) {
              for (const item of p.drafts) {
                if (item && typeof item === 'object' && (item as DraftItem).email_id) {
                  const d = item as DraftItem;
                  setDraftsMap((prev) => new Map(prev).set(d.email_id, d));
                }
              }
            }
          }
        }

        // Surface backend-side warnings/errors from any node patch's
        // ``errors`` field — e.g. prioritize tells us "target email not in
        // cached classified, hit force-refresh". Without this surface they
        // sit silently in state and the user sees a confusing skip-to-summarize.
        for (const patch of Object.values(payload)) {
          if (
            patch &&
            typeof patch === 'object' &&
            Array.isArray((patch as { errors?: unknown }).errors)
          ) {
            for (const err of (patch as { errors: unknown[] }).errors) {
              if (typeof err === 'string' && err.trim()) {
                addMessage({ kind: 'error', text: err });
              }
            }
          }
        }

        // High-signal task summary — emit ONCE per run when prioritize first
        // produces results. The right-column NodeFlowVisualizer is the
        // canonical source for live pipeline status; we don't pollute the
        // chat timeline with per-node narrations.
        if (!summaryEmittedRef.current && 'prioritize' in payload) {
          const prio = (payload.prioritize as { prioritized?: unknown[] }) || {};
          const classifyNow = (payload.classify as { classified?: unknown[] }) || {};
          const totalClassified =
            classifyNow.classified?.length ?? pipeline.classified.length;
          const needReply = prio.prioritized?.length ?? 0;
          if (totalClassified > 0) {
            summaryEmittedRef.current = true;
            const text =
              taskRef.current === 'triage_only'
                ? t('classifyDoneTriage', { count: totalClassified })
                : taskRef.current === 'single_reply'
                ? needReply > 0
                  ? t('singleReplyHit')
                  : t('singleReplyMiss')
                : needReply > 0
                ? t('digestHasDrafts', { total: totalClassified, need: needReply })
                : t('digestNoDrafts', { count: totalClassified });
            addMessage({ kind: 'system', text });
          }
        }
        // No per-node pipeline messages — the right column already shows
        // node status with pulse / done / paused indicators.
        return;
      }
      if (ev === 'human_review_required' && typeof frame.data === 'object' && frame.data) {
        const payload = frame.data as { draft: DraftItem; remaining?: number; email_id: string };
        // Pause is the only "stop" that should keep the live chip — but
        // the backend already emitted the final draft "✅ 草稿就绪" line
        // right before the interrupt, so the user sees a coherent end-of-
        // pipeline narration. Clear here so we don't show "正在起草…"
        // when we actually need approval.
        setProgress(null);
        // The streaming draft preview gets replaced by the (much-prettier)
        // DraftReviewCard the moment we hit interrupt — clear here so the
        // raw markdown body and the polished card don't overlap visually.
        setStreamingText(null);
        // The streaming draft preview gets replaced by the (much-prettier)
        // DraftReviewCard the moment we hit interrupt — clear here so the
        // raw markdown body and the polished card don't overlap visually.
        setStreamingText(null);
        // Pause is the only "stop" that should keep the live chip — but
        // the backend already emitted the final draft "✅ 草稿就绪" line
        // right before the interrupt, so the user sees a coherent end-of-
        // pipeline narration. Clear here so we don't show "正在起草…"
        // when we actually need approval.
        setProgress(null);
        // Detect a likely backend-side checkpointer issue: the same email
        // is being asked for review again after the user already decided.
        // Almost always means the backend lost its checkpoint and re-ran the
        // pipeline from START. Show the warning once, then keep going.
        if (
          doneEmailIdsRef.current.has(payload.email_id) &&
          !checkpointWarningShownRef.current
        ) {
          checkpointWarningShownRef.current = true;
          addMessage({
            kind: 'error',
            text: t('checkpointWarning', { id: payload.email_id }),
          });
        }
        setPending({ draft: payload.draft, remaining: payload.remaining ?? 0 });
        dispatchPipeline({ type: 'paused', emailId: payload.email_id });
        addMessage({
          kind: 'review',
          text: t('reviewPrompt', {
            subject: payload.draft.subject || t('draftNoSubjectHint'),
          }),
        });
        return;
      }
      if (ev === 'done' && typeof frame.data === 'object' && frame.data) {
        const payload = frame.data as { summary: string };
        if (payload.summary) {
          addMessage({ kind: 'summary', text: payload.summary });
        }
        setProgress(null);
        // The final summary now lives in ``messages`` — the streaming bubble
        // would be a duplicate render, hide it.
        setStreamingText(null);
        return;
      }
      if (ev === 'error_message' && typeof frame.data === 'object' && frame.data) {
        const payload = frame.data as { error: string };
        dispatchPipeline({ type: 'error' });
        addMessage({ kind: 'error', text: payload.error || t('backendError') });
        setProgress(null);
        setStreamingText(null);
        return;
      }
      if (ev === 'cancelled') {
        addMessage({ kind: 'system', text: t('cancelled') });
        setProgress(null);
        setStreamingText(null);
        return;
      }
      // [PAUSED] / [DONE] / [CANCELLED] sentinels arrive as raw strings —
      // we already handled the meaningful events above, so just ignore.
    },
    [addMessage, t],
  );

  const startRun = useCallback(
    async (
      task: RunTask,
      opts?: { forceRefresh?: boolean; targetEmailId?: string },
    ) => {
      // Stable conversation_id across all runs in this browser session —
      // unchanged by the click. We grabbed it at mount-time. This is what
      // lets ``review_decisions`` accumulate via LangGraph's add reducer,
      // so the final summary covers ALL emails handled across triage_only
      // / single_reply / daily_digest in this session.
      const cid = conversationIdRef.current;
      taskRef.current = task;
      summaryEmittedRef.current = false;
      // Clear the "was stopped" flag so re-running this conversation
      // correctly restores HITL state if the user refreshes mid-review.
      try { window.localStorage.removeItem(`email-stop-${cid}`); } catch { /* noop */ }
      // doneEmailIdsRef is the synchronous mirror of doneEmailIds — clear it
      // ONLY on a force refresh; otherwise we want the per-session "✓ done"
      // state to accumulate across multi-step single_reply clicks.
      if (opts?.forceRefresh) {
        doneEmailIdsRef.current = new Set();
      }
      checkpointWarningShownRef.current = false;
      setRunning(true);
      // Persist (or refresh) the sidebar entry for this conversation. FWW
      // semantics: the FIRST task on this cid wins as the title — re-running
      // a different task on the same cid only bumps updatedAt to float the
      // row to the top. Mirrors backend ``_maybe_set_title_first_run``.
      saveLocalConversation(cid, `[task] ${t(TASK_LABEL_KEY[task])}`, task);
      // Don't clear messages — timeline accumulates across runs in the same
      // session. The user clicked "新会话" if they wanted a clean slate.
      setPending(null);
      setProgress(null);  // wipe stale chip from a previous run
      setStreamingText(null); // wipe stale streaming bubble from a previous run
      setStreamingText(null); // wipe stale streaming bubble from a previous run
      setProgress(null);  // wipe stale chip from a previous run

      // Snapshot the previously classified inbox BEFORE reset clears the
      // reducer's lock — we want to feed it to the backend as a cache hint
      // so fetch + classify can short-circuit. Skipped when the user
      // explicitly clicks "force refresh" (they want fresh mail).
      const cached =
        !opts?.forceRefresh && pipeline.classified.length > 0
          ? pipeline.classified
          : undefined;

      // Skip-list: emails the user already processed via earlier
      // single_reply clicks. Backend prioritize filters them out in
      // daily_digest mode so we don't re-prompt. Cleared on force refresh.
      const skipIds =
        !opts?.forceRefresh && task === 'daily_digest' && pipeline.doneEmailIds.size > 0
          ? Array.from(pipeline.doneEmailIds)
          : undefined;

      dispatchPipeline({
        type: 'reset',
        task,
        // Force refresh = wipe stale snapshot so the user actually sees
        // the result of "fresh fetch from email provider", not the cached
        // inbox flashing before new data arrives.
        clearDone: opts?.forceRefresh,
        clearClassified: opts?.forceRefresh,
      });

      try {
        // Create a fresh AbortController for this streaming request so the
        // stop button can terminate it immediately via controller.abort().
        const controller = new AbortController();
        abortControllerRef.current = controller;
        for await (const frame of runEmailAssistant({
          task,
          conversationId: cid,
          locale,
          preloadedClassified: cached as unknown[] | undefined,
          targetEmailId: opts?.targetEmailId,
          skipEmailIds: skipIds,
          forceRefresh: opts?.forceRefresh,
          signal: controller.signal,
        })) {
          handleFrame(frame);
        }
      } catch (e) {
        // AbortError is expected when the user clicks stop — don't surface it.
        if ((e as Error).name !== 'AbortError') {
          addMessage({ kind: 'error', text: (e as Error).message });
        }
      } finally {
        abortControllerRef.current = null;
        setRunning(false);
        // The localStorage entry was already upserted at startRun (see
        // saveLocalConversation call above). Drop the api.ts cache too in
        // case the user later clicks "从云端恢复" — they should see this
        // run's data, not a stale snapshot. Bump refreshKey so the
        // sidebar re-reads localStorage for any concurrent edits.
        invalidateConversationCache();
        setHistoryRefreshKey((k) => k + 1);
      }
    },
    [
      addMessage,
      handleFrame,
      locale,
      t,
      pipeline.classified,
      pipeline.doneEmailIds,
    ],
  );

  /** Send a stop signal to the backend for the active conversation. The
   * SSE generator notices via ``request.signal`` on its next iteration and
   * exits cleanly. Also aborts the client-side fetch immediately so the UI
   * stops receiving frames without waiting for the server round-trip. */
  const stopCurrentRun = useCallback(async () => {
    const cid = conversationIdRef.current;
    if (!cid) return;

    // 1. Client-side abort — instantly terminates the streaming fetch.
    // The for-await loop in startRun / submitDecision catches AbortError
    // and exits cleanly.
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    // 2. Server-side notification — fire-and-forget, sets request.signal
    // on the backend handler so it cleans up on its next iteration.
    try {
      await apiStopRun(cid);
    } catch {
      // Ignore — the client abort already did the job.
    }

    // 3. Mark this conversation as "user-stopped" so restoreSession won't
    // resurrect the HITL card on refresh. The LangGraph checkpoint still
    // holds the interrupt, but the user's intent was to abandon it.
    try {
      window.localStorage.setItem(`email-stop-${cid}`, '1');
    } catch { /* noop */ }

    setPending(null);
    // Reset pipeline visuals: active/paused nodes revert to pending,
    // active email highlight in the left column clears.
    dispatchPipeline({ type: 'stop' });
    addMessage({ kind: 'system', text: t('stopped') });
    setRunning(false);
    setProgress(null);
    setStreamingText(null);
  }, [addMessage, t]);

  /** Generate a fresh conversation_id and reset all state. The previous
   * conversation is preserved in the platform's store and remains visible
   * in HistorySidebar. */
  const startNewSession = useCallback(() => {
    if (running) return; // refuse to throw away an in-flight run
    const fresh = generateConvId();
    conversationIdRef.current = fresh;
    persistSessionId(fresh);
    setMessages([]);
    setPending(null);
    setProgress(null);
    setStreamingText(null);
    setStreamingText(null);
    setProgress(null);
    doneEmailIdsRef.current = new Set();
    taskRef.current = null;
    summaryEmittedRef.current = false;
    checkpointWarningShownRef.current = false;
    // Brand new conversation — wipe both the inbox snapshot and the done
    // markers so the user sees a true fresh slate. Without ``clearClassified``
    // the left column would still show the previous session's emails until
    // the user triggers a run on the new conv (which would then fetch fresh
    // and replace).
    dispatchPipeline({
      type: 'reset',
      task: 'triage_only',
      clearDone: true,
      clearClassified: true,
    });
    invalidateConversationCache();
    setHistoryRefreshKey((k) => k + 1);
    setHistoryOpen(false); // dismiss drawer once user committed to fresh slate
  }, [running]);

  /** Switch to a past conversation: hydrate messages + pipeline state from
   * the platform's stored copy. */
  const restoreSession = useCallback(
    async (id: string, opts?: { silent?: boolean }) => {
      if (running) return; // never swap mid-run
      // Race guard: a user-initiated click should NOT overlap with the
      // mount-time silent restore. ``silent`` callers (only the mount
      // effect) bypass this so they can always proceed.
      if (restoring && !opts?.silent) return;
      if (!id) return;
      setRestoring(true);
      // Clear ephemeral pieces of the previous session that have no
      // backing in store: the pending HITL card, live progress chip,
      // streaming bubble, drawer selection. ``messages`` is intentionally
      // NOT cleared here — ConversationStream's restoring=true short-
      // circuit replaces ALL content with the skeleton, and keeping
      // messages avoids a brief empty-array → repopulate flash if React
      // batches the next set across the await boundary.
      setPending(null);
      setProgress(null);
      setStreamingText(null);
      setSelectedEmailId(null);
      // Close the sidebar early so the user sees the transition (loading
      // state in the center) immediately instead of waiting for the fetch.
      setHistoryOpen(false);
      try {
        const detail = await getConversation(id);

        // ── Dead-row detection ────────────────────────────────────────
        // If the platform returns "no messages, no graph state, no next
        // nodes", AND the user has this id in their localStorage list,
        // it was deleted from another device (or the platform's storage
        // dropped it). Auto-clean: remove the local row, surface a brief
        // notice, and reset to a fresh session so the user isn't stuck
        // looking at an empty conversation that "shouldn't exist".
        //
        // The localStorage-presence guard prevents false positives on
        // brand-new conversation_ids that simply haven't run yet (those
        // wouldn't be in the list either way, since saveLocalConversation
        // only fires in startRun).
        const isDeadRow =
          detail.messages.length === 0 &&
          detail.state === null &&
          (detail.nextNodes?.length ?? 0) === 0 &&
          getLocalConversations().some((c) => c.id === id);
        if (isDeadRow) {
          removeLocalConversation(id);
          if (!opts?.silent) {
            addMessage({
              kind: 'error',
              text: t('historyDeletedRemote'),
            });
          }
          // Inline the equivalent of startNewSession (we're already mid-
          // restoreSession so we can't call it directly without recursion).
          // If startNewSession grows additional cleanup steps in the future,
          // they need to be replicated here.
          const fresh = generateConvId();
          conversationIdRef.current = fresh;
          persistSessionId(fresh);
          setMessages([]);
          setPending(null);
          doneEmailIdsRef.current = new Set();
          setDraftsMap(new Map());
          dispatchPipeline({
            type: 'reset',
            task: 'triage_only',
            clearDone: true,
            clearClassified: true,
          });
          setHistoryRefreshKey((k) => k + 1);
          return;  // setRestoring(false) still runs in the finally block
        }

        conversationIdRef.current = id;
        persistSessionId(id);
        const restored = detail.messages.map(storedToStreamMessage);

        // ── URL-shared / new-device session: ensure sidebar entry ───
        // If this id isn't in the local index AND the conversation has
        // content, synthesize a localStorage row so the sidebar reflects
        // what the user is actually looking at. Title comes from the
        // first user message (mirrors history.py:_derive_title) so it
        // matches the "[task] xxx" format saveLocalConversation would
        // have written.
        if (
          detail.messages.length > 0 &&
          !getLocalConversations().some((c) => c.id === id)
        ) {
          const title = deriveTitleFromMessages(detail.messages) || t('historyUntitled');
          saveLocalConversation(id, title);
          setHistoryRefreshKey((k) => k + 1);
        }

        setMessages(restored);
        setPending(null);
        setProgress(null);
        setStreamingText(null);
        if (detail.state) {
          const classified =
            (detail.state.classified as ClassifiedEmail[] | undefined) ?? [];
          const decisions =
            (detail.state.review_decisions as
              | { email_id: string; action: string }[]
              | undefined) ?? [];
          const doneIds = new Set(
            decisions
              .filter((d) => d.action !== 'regenerate')
              .map((d) => d.email_id),
          );
          doneEmailIdsRef.current = new Set(doneIds);

          // Restore accumulated drafts so the Drawer can show them
          // after page refresh without re-running the pipeline.
          const stateDrafts =
            (detail.state.drafts as DraftItem[] | undefined) ?? [];
          if (stateDrafts.length > 0) {
            const restored = new Map<string, DraftItem>();
            for (const d of stateDrafts) {
              if (d && d.email_id) {
                restored.set(d.email_id, d);
              }
            }
            setDraftsMap(restored);
          } else {
            setDraftsMap(new Map());
          }

          // ── HITL resume detection ──
          // The graph is paused at an interrupt() iff:
          //   - LangGraph snapshot's ``next`` contains 'review' (the
          //     interrupt happens INSIDE the review node), AND
          //   - state.pending_review still holds the unresolved draft.
          // Both conditions matter: ``next`` alone could be stale
          // (LangGraph keeps it after error too), and ``pending_review``
          // alone could be a leftover from a finished run if the apply
          // node didn't clear it. Combined they're a reliable signal.
          const nextNodes = detail.nextNodes ?? [];
          const pausedAtReview = nextNodes.includes('review');
          const pendingDraft = detail.state.pending_review as
            | DraftItem
            | null
            | undefined;

          // If the user previously clicked "stop" on this conversation,
          // don't resurrect the HITL card — they intentionally abandoned it.
          // The LangGraph checkpoint still holds the interrupt but the user's
          // intent was "I'm done with this run". Clear the flag on next
          // startRun so re-running the same conversation works normally.
          let wasStopped = false;
          try {
            wasStopped = !!window.localStorage.getItem(`email-stop-${id}`);
          } catch { /* noop */ }

          if (
            pausedAtReview &&
            pendingDraft &&
            !wasStopped &&
            typeof pendingDraft === 'object' &&
            typeof pendingDraft.email_id === 'string'
          ) {
            // Reconstruct counter context from the prioritize snapshot —
            // total = how many emails this run was supposed to handle,
            // iteration = how many already finished (the cursor before
            // apply runs for the current draft). The "X / Y" chip in the
            // header derives display = iteration + (pending ? 1 : 0), so
            // setting iteration = cursor and pending non-null lands on
            // the right "now reviewing #N of M" string.
            const prioritized =
              (detail.state.prioritized as ClassifiedEmail[] | undefined) ?? [];
            const cursor = (detail.state.cursor as number | undefined) ?? 0;
            const remaining = Math.max(0, prioritized.length - cursor - 1);

            setPending({ draft: pendingDraft, remaining });
            dispatchPipeline({
              type: 'restore',
              classified,
              doneEmailIds: doneIds,
              pausedAtReview: {
                emailId: pendingDraft.email_id,
                iteration: cursor,
                total: prioritized.length,
              },
            });
            // Make the "you're back at a paused review" intent obvious —
            // the user just refreshed and the timeline alone wouldn't
            // make it clear that the DraftReviewCard at the bottom is
            // the same one they were looking at before. ``silent: true``
            // (mount-time auto-restore) skips this so a freshly opened
            // tab doesn't shout at the user.
            if (!opts?.silent) {
              addMessage({
                kind: 'system',
                text: t('restoredToReview'),
              });
            }
            // Mirror to the sync ref so handleFrame's duplicate detector
            // works correctly when the resumed stream emits decisions.
            // (We add doneIds + nothing else; the currently-paused email
            // is intentionally NOT in the done set yet.)
          } else {
            dispatchPipeline({
              type: 'restore',
              classified,
              doneEmailIds: doneIds,
            });
          }
        } else {
          doneEmailIdsRef.current = new Set();
          dispatchPipeline({
            type: 'restore',
            classified: [],
            doneEmailIds: new Set(),
          });
        }
        taskRef.current = null;
        summaryEmittedRef.current = false;
        checkpointWarningShownRef.current = false;
      } catch (e) {
        if (!opts?.silent) {
          addMessage({
            kind: 'error',
            text: t('loadSessionFailed', { msg: (e as Error).message }),
          });
        }
        // Failed restore: clear left column too, otherwise the prior
        // session's emails would leak through when the skeleton lifts
        // (restoring=false → EmailInboxTree renders pipeline.classified
        // which still holds the OLD session). Empty state is honest.
        doneEmailIdsRef.current = new Set();
        dispatchPipeline({
          type: 'restore',
          classified: [],
          doneEmailIds: new Set(),
        });
      } finally {
        setRestoring(false);
      }
    },
    [running, restoring, addMessage, t],
  );

  // Mount: pick / generate the session id, persist to URL + localStorage,
  // and try to restore prior state (if any). Runs ONCE — the empty deps
  // array is intentional, the refs / setters captured here are stable.
  // ``initialized`` flips to true regardless of success/failure so the UI
  // unblocks even if the network is dead.
  //
  // Optimisation: if the id has no local record (brand-new session or
  // freshly generated UUID), skip the network round-trip entirely —
  // there's nothing to restore, so we can render immediately.
  useEffect(() => {
    const id = getOrCreateSessionId();
    conversationIdRef.current = id;
    persistSessionId(id);

    const hasLocalRecord = getLocalConversations().some((c) => c.id === id);
    if (hasLocalRecord) {
      void restoreSession(id, { silent: true }).finally(() => {
        setInitialized(true);
      });
    } else {
      // Nothing to restore — unblock UI instantly.
      setInitialized(true);
    }
    // Detect email provider for the onboarding panel data-source indicator
    void getEmailProvider().then(setEmailProvider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const processSingleEmail = useCallback(
    (emailId: string) => {
      // single_reply re-uses cached classified; user can still hit "force
      // refresh" beforehand if they want fresh mail. We don't auto-force
      // here because the user just clicked one specific email — they
      // already trust the snapshot.
      void startRun('single_reply', { targetEmailId: emailId });
    },
    [startRun],
  );

  const submitDecision = useCallback(
    async (decision: ReviewDecisionInput) => {
      const cid = conversationIdRef.current;
      if (!cid || !pending) return;
      // Echo the decision into the timeline immediately
      addMessage({ kind: 'decision', text: decisionLabel(decision, t) });
      // 'regenerate' keeps the same email active — don't add it to doneEmailIds.
      // Other actions (approve / edit / reject / skip) finalize this email.
      if (decision.action === 'regenerate') {
        dispatchPipeline({ type: 'regenerate', emailId: pending.draft.email_id });
      } else {
        dispatchPipeline({ type: 'decision', emailId: pending.draft.email_id });
        // Mirror into the synchronous ref so handleFrame can check duplicates
        // before React has committed the reducer state.
        doneEmailIdsRef.current = new Set([
          ...doneEmailIdsRef.current,
          pending.draft.email_id,
        ]);
      }
      setPending(null);
      setRunning(true);

      try {
        const controller = new AbortController();
        abortControllerRef.current = controller;
        for await (const frame of submitReview({ conversationId: cid, decision, locale, signal: controller.signal })) {
          handleFrame(frame);
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          addMessage({ kind: 'error', text: (e as Error).message });
        }
      } finally {
        abortControllerRef.current = null;
        setRunning(false);
      }
    },
    [addMessage, handleFrame, locale, t, pending],
  );

  const nodeStatusesForViz = useMemo(
    () => deriveActiveNode(pipeline.nodeStatuses, running, !!pending),
    [pipeline.nodeStatuses, running, pending],
  );

  // Display counter — per-run, NOT cumulative across runs. While a draft is
  // pending the user's decision, count it as "in progress" (n+1 / total) so
  // the chip says "运行中 · 2 / 5" while the user is on email #2 of 5, then
  // ticks to 3 / 5 after they decide. runIteration comes from the apply
  // node's cursor (authoritative); we add (pending ? 1 : 0) for in-flight.
  const displayIteration = pipeline.runIteration + (pending ? 1 : 0);
  const displayTotal = pipeline.runTotal;
  const showCounter = displayTotal > 0 && pipeline.currentTask !== 'single_reply';

  return (
  <>
    <ChatLayout
      header={
        <div style={headerInner}>
          <div style={brandWrap}>
            <div style={brandMark} aria-hidden>
              <Icon name="mail" size={18} strokeWidth={2} />
            </div>
            <div>
              <h1 style={appTitle}>{t('appTitle')}</h1>
              <span style={appSubtitle}>
                {t('appSubtitle')}
              </span>
            </div>
          </div>
          {/* Language toggle + Deploy + GitHub */}
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space[2] }}>
            <DeployButton />
            <GitHubButton />
            <button
              type="button"
              onClick={toggleLocale}
              style={langToggleBtn}
              title="Switch language / 切换语言"
            >
              {locale === 'zh' ? 'EN' : '中文'}
            </button>
            <RuntimeStatusChip
            running={running}
            paused={!!pending}
            messagesCount={messages.length}
            iteration={displayIteration}
            total={displayTotal}
            showCounter={showCounter}
          />
          </div>
        </div>
      }
      toolbar={
        <div style={toolbarInner}>
          <div style={toolbarGroup}>
            <button
              onClick={() => startRun('triage_only', { forceRefresh: true })}
              disabled={running || restoring || !initialized}
              style={primaryBtn}
              title={t('fetchEmails')}
            >
              <Icon name="inbox" size={14} />
              <span>{t('fetchEmails')}</span>
            </button>
            <button
              onClick={() => setShowAiConfirm(true)}
              disabled={running || restoring || !initialized}
              style={primaryBtn}
              title={t('aiSmartProcess')}
            >
              <Icon name="sparkles" size={14} />
              <span>{t('aiSmartProcess')}</span>
            </button>
            {running && (
              <button
                type="button"
                onClick={stopCurrentRun}
                style={stopBtn}
                title={t('stop')}
              >
                <Icon name="x" size={13} strokeWidth={2.5} />
                <span>{t('stop')}</span>
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={startNewSession}
            disabled={running || restoring || !initialized}
            style={{ ...newSessionBtn, marginLeft: 'auto' }}
            title={t('newSession')}
          >
            <Icon name="sparkles" size={13} />
            <span>{t('newSession')}</span>
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            style={historyToggleBtn}
            aria-pressed={historyOpen}
            title={t('history')}
          >
            <Icon name="archive" size={13} />
            <span>{t('history')}</span>
          </button>
        </div>
      }
      history={
        <HistorySidebar
          activeId={conversationIdRef.current}
          onSelect={(id) => void restoreSession(id)}
          refreshKey={historyRefreshKey}
          busy={running || restoring}
        />
      }
      historyOpen={historyOpen}
      onCloseHistory={() => setHistoryOpen(false)}
      left={
        <>
          <EmailInboxTree
            emails={pipeline.classified}
            activeEmailId={pipeline.activeEmailId}
            doneEmailIds={pipeline.doneEmailIds}
            // Banner only while we're ACTUALLY mid-fetch (i.e. fetch hasn't
            // completed yet). Tying it to fetch's status — instead of the
            // older "running && !scoresLocked" heuristic — means the banner
            // doesn't linger throughout draft / review / apply / summarize.
            // Cache hits flip fetch:done immediately, so the banner barely
            // flashes for them. ✓
            refreshing={
              running &&
              pipeline.nodeStatuses.fetch !== 'done' &&
              pipeline.classified.length > 0
            }
            fetchedCount={pipeline.fetchedCount}
            classifying={
              // We've fetched but classify hasn't finished — show
              // "已拉取 N 封,正在分类..." in the empty state instead of
              // the placeholder onboarding text.
              pipeline.nodeStatuses.fetch === 'done' &&
              pipeline.nodeStatuses.classify !== 'done' &&
              pipeline.fetchedCount > 0
            }
            onProcessSingle={processSingleEmail}
            onSelectEmail={setSelectedEmailId}
            actionsDisabled={running}
            restoring={restoring}
          />
          <EmailDetailDrawer
            email={
              selectedEmailId
                ? pipeline.classified.find((c) => c.email.id === selectedEmailId) ?? null
                : null
            }
            draft={selectedEmailId ? draftsMap.get(selectedEmailId) ?? null : null}
            isOpen={selectedEmailId !== null}
            onClose={() => setSelectedEmailId(null)}
          />
        </>
      }
      center={
        initialized ? (
          <ConversationStream
            messages={messages}
            pendingDraft={pending}
            onSubmitDecision={submitDecision}
            decisionDisabled={running}
            progress={progress}
            streamingText={streamingText}
            restoring={restoring}
            emailProvider={emailProvider}
          />
        ) : (
          // Mount-time loading — show the same skeleton as session restore
          // so the user sees a consistent loading state regardless of whether
          // they're refreshing the page or switching history sessions.
          <ConversationStream
            messages={[]}
            restoring={true}
            emailProvider={emailProvider}
          />
        )
      }
      right={
        <NodeFlowVisualizer
          statuses={nodeStatusesForViz}
          cachedNodes={pipeline.cachedNodes}
          progress={progress}
        />
      }
    />

    {/* AI Smart Process confirmation modal */}
    {showAiConfirm && (
      <div style={modalBackdrop} onClick={() => setShowAiConfirm(false)}>
        <div style={modalCard} onClick={(e) => e.stopPropagation()}>
          <div style={modalIcon}>
            <Icon name="sparkles" size={20} />
          </div>
          <h3 style={modalTitle}>{t('aiConfirmTitle')}</h3>
          <p style={modalBody}>
            {t('aiConfirmBody')}
          </p>
          <div style={modalActions}>
            <button
              style={modalCancelBtn}
              onClick={() => setShowAiConfirm(false)}
            >
              {t('aiConfirmCancel')}
            </button>
            <button
              style={modalConfirmBtn}
              onClick={() => {
                setShowAiConfirm(false);
                startRun('daily_digest');
              }}
            >
              {t('aiConfirmStart')}
            </button>
          </div>
        </div>
      </div>
    )}
  </>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function decisionLabel(d: ReviewDecisionInput, t: (key: TranslationKey, vars?: Record<string, string | number>) => string): string {
  switch (d.action) {
    case 'approve':
      return t('decApprove');
    case 'edit':
      return d.edited_body ? t('decEdit') : t('decApproveEdited');
    case 'reject':
      return t('decReject');
    case 'regenerate':
      return d.feedback ? t('decRegenerateWith', { feedback: d.feedback }) : t('decRegenerate');
    case 'skip':
      return t('decSkip');
  }
}

/** Bring the active node forward — whichever pipeline step is "next" but not yet done. */
function deriveActiveNode(
  done: Partial<Record<PipelineNode, NodeStatus>>,
  running: boolean,
  isPaused: boolean,
): Partial<Record<PipelineNode, NodeStatus>> {
  const PIPELINE_ORDER: PipelineNode[] = [
    'fetch',
    'classify',
    'prioritize',
    'draft',
    'review',
    'apply',
    'summarize',
  ];
  const next: Partial<Record<PipelineNode, NodeStatus>> = { ...done };
  if (isPaused) {
    next.review = 'paused';
    return next;
  }
  if (!running) return next;
  // Find first pipeline node whose status is NOT done — that's where we are now
  for (const n of PIPELINE_ORDER) {
    if (next[n] !== 'done') {
      next[n] = 'active';
      break;
    }
  }
  return next;
}

// ─── styles ─────────────────────────────────────────────────────────────────

const headerInner: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: tokens.space[3],
};

const brandWrap: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[3],
};

const brandMark: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: tokens.radius.md,
  background: tokens.color.text,
  color: tokens.color.textInverted,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const appTitle: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.xl,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.text,
  letterSpacing: '-0.03em',
  lineHeight: 1.2,
};

const appSubtitle: React.CSSProperties = {
  fontSize: tokens.fontSize.xs,
  color: tokens.color.textSubtle,
  fontFamily: tokens.font.mono,
  letterSpacing: '0.01em',
};

const toolbarInner: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[3],
  flexWrap: 'wrap',
};

const toolbarGroup: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: tokens.space[2],
};

const toolbarDivider: React.CSSProperties = {
  width: 1,
  height: 18,
  background: tokens.color.border,
  display: 'inline-block',
};

const primaryBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: tokens.space[2],
  background: tokens.color.bg,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  padding: '7px 14px',
  borderRadius: tokens.radius.md,
  fontSize: tokens.fontSize.base,
  fontWeight: tokens.fontWeight.medium,
  lineHeight: 1.2,
  cursor: 'pointer',
};

const primaryBtnFilled: React.CSSProperties = {
  ...primaryBtn,
  background: tokens.color.text,
  color: tokens.color.textInverted,
  border: `1px solid transparent`,
};

const ghostBtn: React.CSSProperties = {
  ...primaryBtn,
  background: 'transparent',
  color: tokens.color.textSubtle,
  border: `1px solid ${tokens.color.border}`,
};

/** "停止" button — danger-toned, minimal. */
const stopBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: tokens.space[2],
  padding: '7px 14px',
  borderRadius: tokens.radius.md,
  fontSize: tokens.fontSize.base,
  fontWeight: tokens.fontWeight.medium,
  lineHeight: 1.2,
  cursor: 'pointer',
  color: tokens.color.danger,
  background: tokens.color.dangerSoft,
  border: `1px solid ${tokens.color.border}`,
};

/** Toolbar's "历史" toggle — ghost. */
const historyToggleBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '7px 12px',
  borderRadius: tokens.radius.md,
  fontSize: tokens.fontSize.sm,
  fontFamily: tokens.font.sans,
  fontWeight: tokens.fontWeight.medium,
  color: tokens.color.textSubtle,
  background: 'transparent',
  border: `1px solid ${tokens.color.border}`,
  cursor: 'pointer',
  lineHeight: 1.2,
};

const langToggleBtn: React.CSSProperties = {
  padding: '5px 10px',
  borderRadius: tokens.radius.md,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.bg,
  color: tokens.color.textMuted,
  fontSize: tokens.fontSize.xs,
  fontWeight: tokens.fontWeight.medium,
  cursor: 'pointer',
  lineHeight: 1.2,
};

/** "新会话" — minimal brand tint. */
const newSessionBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '7px 12px',
  borderRadius: tokens.radius.md,
  fontSize: tokens.fontSize.sm,
  fontFamily: tokens.font.sans,
  fontWeight: tokens.fontWeight.medium,
  color: tokens.color.brand,
  background: 'transparent',
  border: `1px solid ${tokens.color.border}`,
  cursor: 'pointer',
  lineHeight: 1.2,
};

// ─── AI Confirm Modal ───────────────────────────────────────────────────────

const modalBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.4)',
  backdropFilter: 'blur(4px)',
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const modalCard: React.CSSProperties = {
  width: 380,
  maxWidth: '90vw',
  background: tokens.color.bg,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.xl,
  padding: `${tokens.space[6]}px ${tokens.space[5]}px`,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: tokens.space[4],
  boxShadow: tokens.shadow.pop,
};

const modalIcon: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: tokens.radius.lg,
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.border}`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: tokens.color.brand,
};

const modalTitle: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.lg,
  fontWeight: tokens.fontWeight.semibold,
  color: tokens.color.text,
};

const modalBody: React.CSSProperties = {
  margin: 0,
  fontSize: tokens.fontSize.base,
  color: tokens.color.textMuted,
  lineHeight: 1.6,
  textAlign: 'center',
};

const modalActions: React.CSSProperties = {
  display: 'flex',
  gap: tokens.space[3],
  width: '100%',
  marginTop: tokens.space[2],
};

const modalCancelBtn: React.CSSProperties = {
  flex: 1,
  padding: '9px 16px',
  borderRadius: tokens.radius.md,
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.bg,
  color: tokens.color.textMuted,
  fontSize: tokens.fontSize.base,
  fontWeight: tokens.fontWeight.medium,
  cursor: 'pointer',
};

const modalConfirmBtn: React.CSSProperties = {
  flex: 1,
  padding: '9px 16px',
  borderRadius: tokens.radius.md,
  border: `1px solid transparent`,
  background: tokens.color.text,
  color: tokens.color.textInverted,
  fontSize: tokens.fontSize.base,
  fontWeight: tokens.fontWeight.medium,
  cursor: 'pointer',
};

// ─── Mount-time loading center ──────────────────────────────────────────────

const loadingShell: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: tokens.color.bg,
};

const loadingCard: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: tokens.space[2],
  padding: `${tokens.space[3]}px ${tokens.space[4]}px`,
  borderRadius: tokens.radius.lg,
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.border}`,
  color: tokens.color.textMuted,
  fontSize: tokens.fontSize.sm,
  fontFamily: tokens.font.mono,
};

// ─── RuntimeStatusChip ──────────────────────────────────────────────────────

interface StatusChipProps {
  running: boolean;
  paused: boolean;
  messagesCount: number;
  iteration: number;
  total: number;
  /** Whether to show the "X / Y" suffix. False for ``triage_only`` (no
   * iterations) and ``single_reply`` (always 1 / 1 — counter is noise). */
  showCounter: boolean;
}

function RuntimeStatusChip({
  running,
  paused,
  messagesCount,
  iteration,
  total,
  showCounter,
}: StatusChipProps) {
  const { t } = useI18n();
  // Idle: hide entirely so the header stays clean before the user clicks anything.
  if (!running && messagesCount === 0) return null;

  let tone: 'brand' | 'warning' | 'success' = 'success';
  let icon: JSX.Element;
  let label: string;

  if (paused) {
    tone = 'warning';
    icon = <Icon name="pause" size={12} />;
    label = showCounter ? t('chipAwaitingCount', { i: iteration, t: total }) : t('chipAwaiting');
  } else if (running) {
    tone = 'brand';
    icon = <IconSpinner size={12} />;
    label = showCounter ? t('chipRunningCount', { i: iteration, t: total }) : t('chipRunning');
  } else {
    tone = 'success';
    icon = <Icon name="check-circle" size={12} />;
    label = showCounter ? t('chipDoneCount', { i: iteration, t: total }) : t('chipDone');
  }

  const palette = {
    brand: { bg: tokens.color.brandSoft, fg: tokens.color.brand, bd: tokens.color.brandBorder },
    warning: { bg: tokens.color.warningSoft, fg: tokens.color.warning, bd: '#fde68a' },
    success: { bg: tokens.color.successSoft, fg: tokens.color.success, bd: '#bbf7d0' },
  }[tone];

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: tokens.space[2],
        padding: `4px ${tokens.space[3]}px`,
        borderRadius: tokens.radius.pill,
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.bd}`,
        fontSize: tokens.fontSize.xs,
        fontFamily: tokens.font.mono,
        fontWeight: tokens.fontWeight.medium,
        whiteSpace: 'nowrap',
      }}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}
