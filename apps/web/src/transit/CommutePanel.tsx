import type { CommuteConfig, CommuteController } from '@atlas/app-hooks';
import { liveTimetableLabel, tripSummary, type TransitTrip } from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useState } from 'react';

function FilterInput({
  label,
  values,
  placeholder,
  disabled = false,
  onCommit,
}: {
  label: string;
  values: string[];
  placeholder: string;
  disabled?: boolean;
  onCommit: (values: string[]) => void;
}) {
  const [text, setText] = useState(values.join(', '));
  useEffect(() => setText(values.join(', ')), [values]);
  const commit = () =>
    onCommit(
      text
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
  return (
    <label className="commute-filter">
      <span>{label}</span>
      <input
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function FavoriteSelect({
  label,
  value,
  places,
  allowNone = false,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string | null;
  places: readonly PlaceRecord[];
  allowNone?: boolean;
  disabled?: boolean;
  onChange: (id: string | null) => void;
}) {
  return (
    <label className="commute-favorite">
      <span>{label}</span>
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">{allowNone ? 'No interchange' : 'Choose a favorite…'}</option>
        {places.map((place) => (
          <option value={place.id} key={place.id}>
            {place.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function TripRow({ trip }: { trip: TransitTrip }) {
  const summary = tripSummary(trip);
  return (
    <li>
      <div className="commute-trip-head">
        <strong>{summary.times}</strong>
        <span>{summary.meta}</span>
      </div>
      <div className="commute-lines" aria-label={summary.lineCodes.join(', then ')}>
        {summary.lineCodes.map((line, index) => (
          <span key={`${line}-${index}`}>{line}</span>
        ))}
      </div>
      {summary.delay && <span className="commute-delay">{summary.delay}</span>}
      {summary.severityLabel && <span className="commute-warning">{summary.severityLabel}</span>}
    </li>
  );
}

export function CommutePanel({
  commute,
  places,
  onClose,
}: {
  commute: CommuteController;
  places: readonly PlaceRecord[];
  onClose: () => void;
}) {
  const [direction, setDirection] = useState<'outbound' | 'inbound'>('outbound');
  const patch = (next: Partial<CommuteConfig>) => commute.setConfig({ ...commute.config, ...next });
  const trips = commute.result?.[direction].trips ?? [];
  const fromName = direction === 'outbound' ? commute.query?.from.name : commute.query?.to.name;
  const toName = direction === 'outbound' ? commute.query?.to.name : commute.query?.from.name;

  return (
    <aside className="commute-panel" aria-label="Commute board">
      <div className="commute-header">
        <div>
          <strong>Commute</strong>
          <span>Favorite-to-favorite live journeys</span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      <div className="commute-body">
        {places.length < 2 && (
          <p className="commute-state">
            Save at least two favorite destinations in Collections to build this board.
          </p>
        )}
        {!commute.ready && <p className="commute-state">Loading saved commute…</p>}
        <div className="commute-fields">
          <FavoriteSelect
            label="From"
            value={commute.config.fromId}
            places={places}
            disabled={!commute.ready}
            onChange={(fromId) => patch({ fromId })}
          />
          <FavoriteSelect
            label="Via"
            value={commute.config.viaId}
            places={places}
            allowNone
            disabled={!commute.ready}
            onChange={(viaId) => patch({ viaId })}
          />
          <FavoriteSelect
            label="To"
            value={commute.config.toId}
            places={places}
            disabled={!commute.ready}
            onChange={(toId) => patch({ toId })}
          />
          <FilterInput
            label="Only bus lines"
            values={commute.config.allowedBusLines}
            placeholder="280, 71"
            disabled={!commute.ready}
            onCommit={(allowedBusLines) => patch({ allowedBusLines })}
          />
          <FilterInput
            label="Train must skip"
            values={commute.config.excludedRailStops}
            placeholder="Hvalstad"
            disabled={!commute.ready}
            onCommit={(excludedRailStops) => patch({ excludedRailStops })}
          />
        </div>
        <p className="commute-rule">
          Walking transfers are allowed. Other bus lines and trains calling at an excluded stop are
          hidden.
        </p>
        <div className="commute-directions" role="tablist" aria-label="Commute direction">
          <button
            type="button"
            role="tab"
            aria-selected={direction === 'outbound'}
            onClick={() => setDirection('outbound')}
          >
            Outbound
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={direction === 'inbound'}
            onClick={() => setDirection('inbound')}
          >
            Return
          </button>
        </div>
        {commute.query && (
          <div className="commute-route">
            <strong>
              {fromName} → {toName}
            </strong>
            {commute.query.via.length > 0 && <span>via {commute.query.via[0]!.name}</span>}
          </div>
        )}
        {commute.loading && <p className="commute-state">Checking upcoming journeys…</p>}
        {commute.error && <p className="commute-state commute-error">{commute.error}</p>}
        {!commute.query && places.length >= 2 && (
          <p className="commute-state">Choose both ends and at least one allowed bus line.</p>
        )}
        {commute.result && trips.length === 0 && (
          <p className="commute-state">
            No upcoming journey matches these exact line and stop rules.
          </p>
        )}
        {trips.length > 0 && (
          <ol className="commute-trips">
            {trips.slice(0, 5).map((trip, index) => (
              <TripRow trip={trip} key={`${trip.startMs}-${index}`} />
            ))}
          </ol>
        )}
        <div className="commute-live">
          <span>Entur · {liveTimetableLabel(commute.updatedMs)}</span>
          <button
            type="button"
            onClick={commute.refresh}
            disabled={commute.loading || !commute.query}
          >
            Refresh
          </button>
        </div>
      </div>
    </aside>
  );
}
