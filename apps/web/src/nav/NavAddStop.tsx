import { NAV_STOP_CATEGORIES, type NavAddStop } from '@atlas/app-hooks';
import { fmtDistanceM, fmtKm } from '@atlas/core';

/**
 * The mid-drive "add a stop" quick search: category chips (gas / charging /
 * food) over the nearest matches still ahead on the route, cheapest detour
 * first. One tap inserts the stop and guidance recalculates — nobody types a
 * search query at 90 km/h.
 */
export function NavAddStopPanel({ ctl }: { ctl: NavAddStop }) {
  if (!ctl.open) return null;
  return (
    <div className="nav-add-stop" role="dialog" aria-label="Add a stop">
      <div className="nav-add-stop-head">
        <strong>Add a stop</strong>
        <button
          type="button"
          className="icon-button"
          onClick={() => ctl.setOpen(false)}
          aria-label="Close"
        >
          ✕
        </button>
      </div>
      <div className="nav-add-stop-cats" role="tablist" aria-label="Stop category">
        {NAV_STOP_CATEGORIES.map((category) => (
          <button
            type="button"
            key={category.id}
            role="tab"
            aria-selected={ctl.category === category.id}
            className={ctl.category === category.id ? 'selected' : undefined}
            onClick={() => ctl.setCategory(category.id)}
          >
            {category.label}
          </button>
        ))}
      </div>
      {ctl.status === 'loading' ? (
        <p className="nav-add-stop-note">Searching along the route…</p>
      ) : ctl.status === 'error' ? (
        <p className="nav-add-stop-note">Search unavailable — tap a place on the map instead.</p>
      ) : ctl.hits.length === 0 ? (
        <p className="nav-add-stop-note">Nothing in this category ahead on the route.</p>
      ) : (
        <ul className="nav-add-stop-list">
          {ctl.hits.map((hit) => (
            <li key={`${hit.name}@${hit.position.lat},${hit.position.lng}`}>
              <button type="button" onClick={() => ctl.pick(hit)}>
                <span className="nav-add-stop-name">{hit.name}</span>
                <span className="nav-add-stop-dist">
                  in {fmtKm(hit.aheadM)}
                  {/* A place well off the line is honest about the detour. */}
                  {hit.offRouteM > 250 ? ` · ${fmtDistanceM(hit.offRouteM)} off route` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A tapped place while navigating: the one question that matters mid-drive is
 * "stop here on the way?", so this is that question and nothing else — the
 * full place card (wiki extract, sun times) stays an idle-time surface.
 */
export function NavStopTapCard({
  title,
  onAdd,
  onClose,
}: {
  title: string;
  onAdd: () => void;
  onClose: () => void;
}) {
  return (
    <div className="nav-stop-tap-card" role="dialog" aria-label="Add tapped place as a stop">
      <span className="nav-stop-tap-title">{title}</span>
      <button type="button" className="nav-stop-tap-add" onClick={onAdd}>
        Add stop
      </button>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </div>
  );
}
