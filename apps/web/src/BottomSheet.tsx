import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A gesture-driven bottom sheet for the phone layout. Desktop is untouched: the
 * hook only arms itself when the mobile media query matches, and everything it
 * does is imperative (transform written straight to the element), so on a wide
 * viewport the returned props are inert and the panel keeps its floating-card
 * styling from CSS.
 *
 * The sheet occupies a fixed frame anchored to the bottom (`bottom: 0`,
 * `max-height`) and is moved with `translateY`: pushing it *down* reveals less.
 * Three rest positions (snaps) are expressed as a *visible height* and turned
 * into a translate offset against the sheet's measured height:
 *
 *   full → the whole frame (internal scroll takes over past the cap)
 *   half → about half the viewport, so the map still reads above it
 *   peek → just the grabber + header strip, out of the map's way
 *
 * A drag follows the finger between full and just past peek; on release the
 * throw is projected forward by its velocity and the nearest snap wins, so a
 * flick carries to the next stop the way a native sheet does. A hard downward
 * throw (or a drag dropped below peek) dismisses.
 */
export type SheetSnap = 'peek' | 'half' | 'full';

const SNAP_ORDER: readonly SheetSnap[] = ['peek', 'half', 'full'];

// How much of the sheet stays on screen at the peek snap: enough for the
// grabber, the title row, and the travel-mode chips beneath them.
const PEEK_PX = 140;
// A release is projected this far along its current velocity before the nearest
// snap is chosen — the "momentum" that lets a flick skip a snap.
const PROJECT_MS = 130;
// Slack below the peek offset the finger may drag into; dropping past the
// threshold (or flicking down hard from peek) closes the sheet.
const DISMISS_SLACK = 96;
const DISMISS_THRESHOLD = 56;
// Pointer travel under this (px) counts as a tap, not a drag.
const TAP_SLOP = 6;
const SPRING = 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1)';

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** Visible-height target for a snap, clamped to what the sheet can actually show. */
function visibleFor(snap: SheetSnap, sheetH: number, viewportH: number): number {
  switch (snap) {
    case 'full':
      return sheetH;
    case 'half':
      return Math.min(sheetH, viewportH * 0.5);
    case 'peek':
      return Math.min(sheetH, PEEK_PX);
  }
}

/** translateY offset (px, ≥0) that leaves `visibleFor(snap)` of the sheet showing. */
function offsetFor(snap: SheetSnap, sheetH: number, viewportH: number): number {
  return Math.max(0, sheetH - visibleFor(snap, sheetH, viewportH));
}

interface DragState {
  startY: number;
  startOffset: number;
  lastY: number;
  lastT: number;
  velocity: number; // px/ms, positive = downward
  moved: number; // peak absolute travel, for tap detection
}

export interface BottomSheet {
  /** True only on the phone layout; false leaves every prop below inert. */
  active: boolean;
  snap: SheetSnap;
  setSnap: (snap: SheetSnap) => void;
  /** Raise the sheet to at least `half` — used when a field inside it focuses. */
  ensureVisible: () => void;
  sheetRef: React.RefObject<HTMLDivElement | null>;
  grabberProps: React.HTMLAttributes<HTMLDivElement>;
}

export function useBottomSheet(
  opts: {
    onDismiss?: () => void;
    initial?: SheetSnap;
  } = {},
): BottomSheet {
  const { onDismiss, initial = 'half' } = opts;
  const [active, setActive] = useState(false);
  const [snap, setSnapState] = useState<SheetSnap>(initial);

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // Last offset written to the element, so a drag can start from wherever the
  // sheet currently rests without re-parsing the computed transform.
  const offsetRef = useRef(0);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Arm only on the phone layout; the breakpoint mirrors index.css (640px).
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 640px)');
    const sync = () => setActive(mql.matches);
    sync();
    mql.addEventListener('change', sync);
    return () => mql.removeEventListener('change', sync);
  }, []);

  const writeOffset = useCallback((offset: number, animate: boolean) => {
    const el = sheetRef.current;
    if (!el) return;
    el.style.transition = animate ? SPRING : 'none';
    el.style.transform = `translateY(${offset}px)`;
    offsetRef.current = offset;
  }, []);

  const applySnap = useCallback(
    (target: SheetSnap, animate: boolean) => {
      const el = sheetRef.current;
      if (!el) return;
      writeOffset(
        offsetFor(target, el.getBoundingClientRect().height, window.innerHeight),
        animate,
      );
    },
    [writeOffset],
  );

  // Rest the sheet at its snap whenever the snap, the arming, or the geometry
  // changes. Desktop clears the inline transform so the CSS card is unaffected.
  useLayoutEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    if (!active) {
      el.style.transform = '';
      el.style.transition = '';
      return;
    }
    applySnap(snap, true);
    // Content growing/shrinking (a route resolves, the transit board loads) or
    // the viewport resizing must keep the current snap pinned, without a spring.
    const ro = new ResizeObserver(() => {
      if (!dragRef.current) applySnap(snap, false);
    });
    ro.observe(el);
    const onResize = () => {
      if (!dragRef.current) applySnap(snap, false);
    };
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [active, snap, applySnap]);

  const setSnap = useCallback((next: SheetSnap) => setSnapState(next), []);
  const ensureVisible = useCallback(() => {
    setSnapState((cur) => (cur === 'peek' ? 'full' : cur));
  }, []);

  const settle = useCallback(() => {
    const el = sheetRef.current;
    const drag = dragRef.current;
    dragRef.current = null;
    if (!el || !drag) return;

    const sheetH = el.getBoundingClientRect().height;
    const viewportH = window.innerHeight;
    const peekOffset = offsetFor('peek', sheetH, viewportH);
    const projected = offsetRef.current + drag.velocity * PROJECT_MS;

    // A throw or drag that lands well below peek closes the sheet.
    if (onDismissRef.current && projected > peekOffset + DISMISS_THRESHOLD) {
      onDismissRef.current();
      return;
    }

    // Otherwise the snap whose rest offset is nearest the projected landing.
    let best: SheetSnap = 'peek';
    let bestDist = Infinity;
    for (const candidate of SNAP_ORDER) {
      const dist = Math.abs(offsetFor(candidate, sheetH, viewportH) - projected);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
    if (best === snap) applySnap(best, true);
    else setSnapState(best);
  }, [snap, applySnap]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!active) return;
      const el = sheetRef.current;
      if (!el) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const now = performance.now();
      dragRef.current = {
        startY: e.clientY,
        startOffset: offsetRef.current,
        lastY: e.clientY,
        lastT: now,
        velocity: 0,
        moved: 0,
      };
      el.style.transition = 'none';
    },
    [active],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const el = sheetRef.current;
      if (!drag || !el) return;
      const now = performance.now();
      const dt = now - drag.lastT;
      if (dt > 0) drag.velocity = (e.clientY - drag.lastY) / dt;
      drag.lastY = e.clientY;
      drag.lastT = now;
      drag.moved = Math.max(drag.moved, Math.abs(e.clientY - drag.startY));

      const sheetH = el.getBoundingClientRect().height;
      const peekOffset = offsetFor('peek', sheetH, window.innerHeight);
      const next = clamp(
        drag.startOffset + (e.clientY - drag.startY),
        0,
        peekOffset + DISMISS_SLACK,
      );
      writeOffset(next, false);
    },
    [writeOffset],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // A tap on the grabber cycles up through the snaps (peek→half→full→peek),
      // the no-look way to expand a collapsed sheet.
      if (drag.moved < TAP_SLOP) {
        dragRef.current = null;
        setSnapState((cur) => SNAP_ORDER[(SNAP_ORDER.indexOf(cur) + 1) % SNAP_ORDER.length]!);
        return;
      }
      settle();
    },
    [settle],
  );

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const step = e.key === 'ArrowUp' ? 1 : -1;
      setSnapState(
        (cur) => SNAP_ORDER[clamp(SNAP_ORDER.indexOf(cur) + step, 0, SNAP_ORDER.length - 1)]!,
      );
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSnapState((cur) => (cur === 'full' ? 'peek' : 'full'));
    } else if (e.key === 'Escape' && onDismissRef.current) {
      onDismissRef.current();
    }
  }, []);

  return {
    active,
    snap,
    setSnap,
    ensureVisible,
    sheetRef,
    grabberProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onKeyDown,
      role: 'slider',
      tabIndex: active ? 0 : -1,
      'aria-label': 'Resize route panel — drag, or use arrow keys',
      'aria-valuetext': snap,
    } as React.HTMLAttributes<HTMLDivElement>,
  };
}
