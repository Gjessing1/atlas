import { MAP_PROFILES } from '@atlas/core';
import { mapProfileIcon } from '../icons.js';

interface MapProfileSwitchProps {
  /** Id of the active profile. */
  active: string;
  /**
   * Pick a profile. App handles it rather than the hook alone, because a pick
   * also moves the route planner's travel mode — an explicit user action, not
   * an effect that could fight a restored plan or a share link.
   */
  onPick: (id: string) => void;
}

/**
 * One-tap activity switcher, sitting above the layer quick switch.
 *
 * Every profile is a visible button rather than a menu: the whole point is a
 * single tap, and the list is curated short enough to stay a row. Picking one
 * reveals that activity's contextual overlays and sets the travel mode new
 * routes start from — see MAP_PROFILES.
 */
export function MapProfileSwitch({ active, onPick }: MapProfileSwitchProps) {
  return (
    <div className="profile-switch" role="radiogroup" aria-label="Map profile">
      {MAP_PROFILES.map((p) => {
        const on = p.id === active;
        const Icon = mapProfileIcon(p.id);
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={on}
            className={`profile-switch-item${on ? ' profile-switch-item-on' : ''}`}
            title={p.label}
            onClick={() => onPick(p.id)}
          >
            <Icon size={19} />
            <span className="profile-switch-label">{p.label}</span>
          </button>
        );
      })}
    </div>
  );
}
