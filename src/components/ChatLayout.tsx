/**
 * ChatLayout — three-column responsive shell with a history drawer.
 *
 *  ┌─────────────────────────────────────────────────────────────────┐
 *  │                          Header                                  │
 *  ├─────────────────────────────────────────────────────────────────┤
 *  │                          Toolbar (with 历史 toggle)              │
 *  ├──────────────┬──────────────────────────┬──────────────┤
 *  │   inbox      │     conversation         │   pipeline    │
 *  │   (260)      │       (flex)             │   (280)       │
 *  └──────────────┴──────────────────────────┴──────────────┘
 *
 * History sidebar lives behind the "历史" toggle button — slides in as an
 * overlay panel from the left. We picked this over a permanent fourth
 * column because the inbox + conversation + pipeline trio is what the user
 * works with all the time; history is meta-navigation, used occasionally.
 *
 * Drawer state is OWNED BY THE PARENT (App.tsx) so it can auto-close after
 * the user selects a row or clicks "新会话". ChatLayout just renders the
 * overlay when ``historyOpen`` is true and calls ``onCloseHistory`` on
 * backdrop click / ESC.
 *
 * Animation: the drawer slides in from the left + the backdrop fades in
 * (~240ms). When closing we keep the panel mounted through the exit
 * transition so it animates out, then unmount. ``useDrawerTransition``
 * encodes that lifecycle. Honors ``prefers-reduced-motion``.
 */
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { tokens } from '../design-tokens';
import { useI18n } from '../i18n';

interface Props {
  header: ReactNode;
  toolbar?: ReactNode;
  /** Optional history slot — rendered in the slide-out drawer. Pass ``null``
   * to disable history entirely (the toggle button stays in App's toolbar). */
  history?: ReactNode;
  /** Whether the history drawer is open. Owned by parent. */
  historyOpen?: boolean;
  /** Backdrop / ESC handler — parent closes the drawer. */
  onCloseHistory?: () => void;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
}

// One-time check on module load. Picks up the user's OS-level setting; if
// they toggle reduced-motion mid-session a refresh is required to feel it,
// which is fine for a single-user demo template.
const prefersReducedMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ENTER_MS = prefersReducedMotion ? 0 : 240;
const EXIT_MS = prefersReducedMotion ? 0 : 200;

export default function ChatLayout({
  header,
  toolbar,
  history,
  historyOpen,
  onCloseHistory,
  left,
  center,
  right,
}: Props) {
  const compact = useCompactLayout();
  const drawer = useDrawerTransition(!!historyOpen);
  const [leftWidth, setLeftWidth] = useState(280);
  const draggingRef = useRef(false);
  const { t } = useI18n();

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = leftWidth;
    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = ev.clientX - startX;
      setLeftWidth(Math.max(180, Math.min(450, startW + delta)));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [leftWidth]);

  // Close on Escape — universal "drawer dismiss" affordance. Only attaches
  // the listener when the drawer is open so we don't pay the cost otherwise.
  useEffect(() => {
    if (!historyOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseHistory?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [historyOpen, onCloseHistory]);

  return (
    <div style={shell}>
      <header style={headerStyle}>{header}</header>
      {toolbar && <div style={toolbarStyle}>{toolbar}</div>}
      <div
        style={{
          ...body,
          gridTemplateColumns: compact ? '1fr' : `${leftWidth}px 4px 1fr 280px`,
        }}
      >
        <div style={{ ...col, order: compact ? 1 : 0, minHeight: compact ? 200 : 0 }}>{left}</div>
        {!compact && (
          <div
            style={resizeHandle}
            onMouseDown={onMouseDown}
            title={t('resizeHandleTitle')}
          />
        )}
        <div style={{ ...col, order: compact ? 0 : 0 }}>{center}</div>
        <div style={{ ...col, order: compact ? 2 : 0, minHeight: compact ? 200 : 0 }}>{right}</div>
      </div>

      {/* History drawer — overlay + slide-in panel from the RIGHT. Stays
          mounted during the exit transition so the slide-out actually plays. */}
      {drawer.mounted && history && (
        <>
          <div
            style={{
              ...overlayBackdrop,
              opacity: drawer.visible ? 1 : 0,
              // Block input only while it's visually present; during the
              // fade-out a click on the area shouldn't re-trigger close.
              pointerEvents: drawer.visible ? 'auto' : 'none',
              transition: `opacity ${drawer.visible ? ENTER_MS : EXIT_MS}ms ease`,
            }}
            onClick={onCloseHistory}
            aria-hidden
          />
          <div
            style={{
              ...overlayPanel,
              // Slide IN from the right (off-screen → 0). When closing,
              // animate back to translateX(100%).
              transform: drawer.visible ? 'translateX(0)' : 'translateX(100%)',
              transition: drawer.visible
                ? `transform ${ENTER_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`
                : `transform ${EXIT_MS}ms cubic-bezier(0.4, 0, 1, 1)`,
            }}
            role="dialog"
            aria-label={t('historyTitle')}
          >
            {history}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Two-stage drawer lifecycle so we can animate both directions:
 *
 *   open=false → open=true : mount immediately, flip ``visible`` to true on
 *                            the next frame so the CSS transition plays.
 *   open=true  → open=false: flip ``visible`` to false (triggers exit
 *                            transition), keep mounted for ``EXIT_MS``,
 *                            then unmount.
 *
 * Two ``requestAnimationFrame`` calls are needed for the enter case: the
 * first ensures the panel has been laid out with ``translateX(-100%)``,
 * the second toggles to ``translateX(0)`` so the transition actually has
 * a starting frame to interpolate from.
 */
function useDrawerTransition(open: boolean): { mounted: boolean; visible: boolean } {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  // Track which RAFs / timeouts are pending so we can cancel cleanly when
  // the user toggles open/close rapidly.
  const rafA = useRef<number | null>(null);
  const rafB = useRef<number | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Cancel any pending transition work — toggling mid-animation should
    // adopt the new direction immediately.
    if (rafA.current !== null) cancelAnimationFrame(rafA.current);
    if (rafB.current !== null) cancelAnimationFrame(rafB.current);
    if (exitTimer.current !== null) clearTimeout(exitTimer.current);
    rafA.current = null;
    rafB.current = null;
    exitTimer.current = null;

    if (open) {
      setMounted(true);
      // Mount → next frame → set visible. Two RAFs guarantee the browser
      // has painted the initial off-screen position before we change to
      // on-screen — without this the transition gets skipped on the first
      // open because the element renders directly at the final state.
      rafA.current = requestAnimationFrame(() => {
        rafB.current = requestAnimationFrame(() => {
          setVisible(true);
        });
      });
    } else {
      // Closing → trigger exit transition immediately, unmount after it.
      setVisible(false);
      exitTimer.current = setTimeout(() => {
        setMounted(false);
      }, EXIT_MS);
    }

    return () => {
      if (rafA.current !== null) cancelAnimationFrame(rafA.current);
      if (rafB.current !== null) cancelAnimationFrame(rafB.current);
      if (exitTimer.current !== null) clearTimeout(exitTimer.current);
    };
  }, [open]);

  return { mounted, visible };
}

function useCompactLayout(): boolean {
  const [compact, setCompact] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 1100 : false,
  );
  useEffect(() => {
    function onResize() {
      setCompact(window.innerWidth < 1100);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return compact;
}

const shell: React.CSSProperties = {
  display: 'grid',
  gridTemplateRows: 'auto auto 1fr',
  height: '100vh',
  background: tokens.color.bg,
  fontFamily: tokens.font.sans,
  color: tokens.color.text,
};

const headerStyle: React.CSSProperties = {
  padding: `${tokens.space[3]}px ${tokens.space[5]}px`,
  borderBottom: `1px solid ${tokens.color.border}`,
  background: tokens.color.bg,
};

const toolbarStyle: React.CSSProperties = {
  padding: `${tokens.space[2]}px ${tokens.space[5]}px`,
  borderBottom: `1px solid ${tokens.color.border}`,
  background: tokens.color.bg,
};

const body: React.CSSProperties = {
  display: 'grid',
  minHeight: 0,
};

const col: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  overflow: 'hidden',
};

const resizeHandle: React.CSSProperties = {
  width: 4,
  cursor: 'col-resize',
  background: 'transparent',
  position: 'relative',
  zIndex: 2,
  transition: 'background 150ms ease',
  // Expand hit area beyond visual width for easier grabbing
};

const overlayBackdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.4)',
  zIndex: 50,
  backdropFilter: 'blur(2px)',
  // ``opacity`` and ``transition`` are set inline per state in the JSX —
  // the static base just declares the layout properties.
};

const overlayPanel: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 320,
  zIndex: 51,
  background: tokens.color.surface,
  // Drawer from the RIGHT — the divider sits on the LEFT edge of the
  // panel (where it meets the main content), and the shadow flares to
  // the LEFT (away from the screen edge).
  borderLeft: `1px solid ${tokens.color.border}`,
  boxShadow: '-12px 0 40px rgba(15,23,42,0.16)',
  display: 'flex',
  flexDirection: 'column',
  // ``transform`` and ``transition`` flip per state in the JSX. Setting a
  // ``willChange`` hint nudges the browser to keep this on its own
  // compositor layer, so the slide stays buttery on lower-end devices.
  willChange: 'transform',
};
