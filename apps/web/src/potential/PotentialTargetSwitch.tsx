import type { PotentialTargetSwitch as TargetSwitch } from '@atlas/app-hooks';
import { useEffect, useRef, useState } from 'react';
import { FishHuntIcon } from '../icons.js';

/**
 * The Fish & Hunt sub-profile switcher, sitting directly above the layer quick
 * switch: **what are you after?**
 *
 * A row rather than a buried panel setting because it is the question the
 * profile exists to answer, and because picking the animal is what makes the
 * derived surface mean anything — the same weights over the same ground say
 * different things for ørret and for elg. Choosing one switches its surface on
 * and every other derived surface off; `usePotentialTarget` owns that rule, and
 * Android renders the identical model from the same hook.
 *
 * A menu rather than the visible chip row the profiles get, for one reason: the
 * list is three surfaces deep and a dozen animals long, and the map is what the
 * screen is for. The current pick stays legible on the trigger.
 */
export function PotentialTargetSwitch({ targets }: { targets: TargetSwitch }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss like a menu: click anywhere else, or Escape. Same contract as the
  // layer quick switch it sits on top of.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Nothing derived in this profile's catalog — outside Fish & Hunt, or on a
  // server with no derive service. Hidden rather than shown empty.
  if (targets.groups.length === 0) return null;

  const { active } = targets;

  return (
    <div className="quarry-switch" ref={rootRef}>
      {open && (
        <div className="quarry-switch-menu" role="group" aria-label="Fish &amp; game">
          {targets.groups.map((group) => (
            <div key={group.layer} className="quarry-switch-group">
              <div className="quarry-switch-group-title">{group.title}</div>
              {group.choices.map((choice) => (
                <button
                  key={`${choice.layer}:${choice.value}`}
                  type="button"
                  role="radio"
                  aria-checked={choice.active}
                  className={`quarry-switch-item${choice.active ? ' quarry-switch-item-on' : ''}`}
                  title={choice.caption ?? choice.label}
                  onClick={() => {
                    targets.select(choice.layer, choice.value);
                    setOpen(false);
                  }}
                >
                  <span className="quarry-switch-check" aria-hidden="true">
                    {choice.active ? '✓' : ''}
                  </span>
                  <span className="quarry-switch-label">{choice.label}</span>
                </button>
              ))}
            </div>
          ))}
          {active && (
            // The way back out. Without it the only way to stop drawing an
            // opinion over the map is to find the row again in the layers panel.
            <button
              type="button"
              className="quarry-switch-item quarry-switch-clear"
              onClick={() => {
                targets.clear();
                setOpen(false);
              }}
            >
              <span className="quarry-switch-check" aria-hidden="true" />
              <span className="quarry-switch-label">Turn the surface off</span>
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        className={`quarry-switch-toggle${active ? ' quarry-switch-toggle-on' : ''}`}
        aria-expanded={open}
        aria-label={
          active ? `Fish & game: ${active.label}, ${active.layerTitle}` : 'Fish & game potential'
        }
        title={active ? (active.caption ?? active.layerTitle) : 'Pick what you are after'}
        onClick={() => setOpen((v) => !v)}
      >
        <FishHuntIcon size={19} />
        <span className="quarry-switch-toggle-label">
          {active ? active.label : 'What to look for'}
        </span>
      </button>
    </div>
  );
}
