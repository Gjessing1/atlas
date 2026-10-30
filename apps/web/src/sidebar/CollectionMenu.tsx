import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Named actions in a portal so a long folder cannot clip its last row's menu. */
export function CollectionMenu({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const root = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const menu = panel.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(rect.right - menu.width, window.innerWidth - menu.width - 8)),
      top:
        rect.bottom + menu.height < window.innerHeight - 8
          ? rect.bottom
          : Math.max(8, rect.top - menu.height),
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  return (
    <span
      className="collection-menu"
      ref={root}
      onBlur={(event) => {
        if (
          !root.current?.contains(event.relatedTarget) &&
          !panel.current?.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-label={`More actions for ${title}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open &&
        createPortal(
          <span
            ref={panel}
            style={position}
            className="collection-menu-panel"
            role="group"
            aria-label={`${title} actions`}
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest('button')) {
                setOpen(false);
                trigger.current?.focus();
              }
            }}
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}
