import type { MapProfile } from '@atlas/core';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CheckIcon, ChevronIcon, mapProfileIcon } from '../icons.js';
import { useDismiss } from '../useDismiss.js';

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

  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => {
    // Hand focus back to the trigger only when it was inside the menu, so a
    // click on the map is not followed by the page scrolling to the corner.
    const hadFocus = menu.current?.contains(document.activeElement) ?? false;
    setOpen(false);
    if (hadFocus) trigger.current?.focus();
  };
  useDismiss(open, root, close);

  // Opening lands on the current profile, like a native select.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === 'ArrowDown'
        ? (at + 1) % items.length
        : event.key === 'ArrowUp'
          ? (at - 1 + items.length) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className="profile-switch" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`profile-switch-trigger map-control has-tip${open ? ' open' : ''}`}
        aria-label={`Map profile: ${current?.label ?? 'Choose'}`}
        aria-expanded={open}
        aria-haspopup="true"
        data-tip="Activity profile"
        onClick={() => setOpen((value) => !value)}
      >
        {CurrentIcon && <CurrentIcon size={20} />}
        <span className="profile-switch-label">{current?.label}</span>
        <ChevronIcon className="profile-switch-chevron" size={16} />
      </button>
      {open && (
        <div
          ref={menu}
          className="profile-switch-menu map-popover"
          role="radiogroup"
          aria-label="Map profile"
          onKeyDown={onMenuKeyDown}
        >
          {profiles.map((profile) => {
            const selected = profile.id === active;
            const Icon = mapProfileIcon(profile.id);
            return (
              <button
                key={profile.id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                className={`profile-switch-item map-popover-item${selected ? ' profile-switch-item-on' : ''}`}
                onClick={() => {
                  onPick(profile.id);
                  close();
                }}
              >
                <Icon size={20} />
                <span>{profile.label}</span>
                {selected && <CheckIcon className="profile-switch-check" size={18} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
