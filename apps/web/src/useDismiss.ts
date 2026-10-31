import { useEffect, useRef, type RefObject } from 'react';

/**
 * Close a floating menu like a menu: a press anywhere outside `root`, or
 * Escape. One contract for every quick switcher over the map (profile, layers,
 * filters, quarry), which had each grown their own copy of it.
 *
 * Both listeners run in the capture phase and Escape is marked handled, so the
 * same key press closes the menu without also closing the drawer behind it —
 * App's drawer Escape runs in the bubble phase and skips a handled event.
 */
export function useDismiss(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  // Latest callback without re-subscribing on every render of the caller.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, root]);
}
