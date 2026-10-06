import type { MapProfile } from '@atlas/core';
import { useEffect, useRef, useState } from 'react';
import { mapProfileIcon } from '../icons.js';

interface MapProfileSwitchProps {
  /** Id of the active profile. */
  active: string;
  profiles: readonly MapProfile[];
  /**
   * Pick a profile. App handles it rather than the hook alone, because a pick
   * also moves the route planner's travel mode — an explicit user action, not
   * an effect that could fight a restored plan or a share link.
   */
  onPick: (id: string) => void;
}

/**
 * Compact activity picker beside the layer control, with the same list of
 * labelled profiles Android opens from its active-profile button.
 */
export function MapProfileSwitch({ active, profiles, onPick }: MapProfileSwitchProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = profiles.find((profile) => profile.id === active) ?? profiles[0];
  const CurrentIcon = current ? mapProfileIcon(current.id) : null;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <div className="profile-switch" ref={root}>
      <button
        type="button"
        className="profile-switch-trigger"
        aria-label={`Map profile: ${current?.label ?? 'Choose'}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        {CurrentIcon && <CurrentIcon size={21} />}
        <span>{current?.label}</span>
        <span aria-hidden="true">⌃</span>
      </button>
      {open && (
        <div className="profile-switch-menu" role="radiogroup" aria-label="Map profile">
          {profiles.map((profile) => {
            const selected = profile.id === active;
            const Icon = mapProfileIcon(profile.id);
            return (
              <button
                key={profile.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`profile-switch-item${selected ? ' profile-switch-item-on' : ''}`}
                onClick={() => {
                  onPick(profile.id);
                  setOpen(false);
                }}
              >
                <Icon size={21} />
                <span>{profile.label}</span>
                {selected && <span className="profile-switch-check">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
