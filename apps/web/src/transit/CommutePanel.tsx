import {
  useCommuteEditor,
  type CommuteController,
  type CommuteEditor,
  type CommuteEndKey,
  type CommuteLineOption,
  type StopLinesFn,
} from '@atlas/app-hooks';
import type { LatLng } from '@atlas/core';
import {
  defaultCommuteDirection,
  emptyDirectionNote,
  fetchTransitStopLines,
  liveTimetableLabel,
  minutesOfDayLabel,
  tripSummary,
  type TransitCommuteDirection,
  type TransitTrip,
} from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { useMemo, useState } from 'react';

import { useGeocode } from '../routing/useGeocode.js';

const fetchStopLines: StopLinesFn = (stopId, signal) => fetchTransitStopLines(stopId, { signal });

/** One end of the commute: what it is now, and a search box to change it. */
function EndField({
  field,
  label,
  editor,
  places,
}: {
  field: CommuteEndKey;
  label: string;
  editor: CommuteEditor;
  places: readonly PlaceRecord[];
}) {
  const open = editor.editing === field;
  const end = editor.config[field];
  return (
    <div className="commute-end">
      <span className="commute-end-label">{label}</span>
      {open ? (
        <div className="commute-end-search">
          <input
            type="search"
            autoFocus
            value={editor.search.query}
            placeholder="Search for a stop…"
            aria-label={`Search for the ${label} stop`}
            onChange={(event) => editor.search.setQuery(event.target.value)}
          />
          <ul className="commute-hits">
            {editor.search.hits.map((hit) => (
              <li key={`${hit.name}-${hit.position.lat}-${hit.position.lng}`}>
                <button type="button" onClick={() => editor.pickHit(field, hit)}>
                  <strong>{hit.name}</strong>
                  <span>{hit.transitStopId ? 'Stop' : hit.label}</span>
                </button>
              </li>
            ))}
            {/* Favorites stay a shortcut — they are just no longer the only
                path. Offered only before anything is typed: `useStopSearch`
                matches saved places into its own hits, so showing both would
                list every favorite twice. */}
            {editor.search.query.trim().length === 0 &&
              places.slice(0, 4).map((place) => (
                <li key={place.id}>
                  <button type="button" onClick={() => editor.pickPlace(field, place)}>
                    <strong>{place.name}</strong>
                    <span>Saved place</span>
                  </button>
                </li>
              ))}
          </ul>
          <div className="commute-end-actions">
            <button type="button" onClick={() => editor.edit(null)}>
              Cancel
            </button>
            {end && (
              <button type="button" onClick={() => editor.clear(field)}>
                Clear
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="commute-end-button"
          disabled={!editor.ready}
          onClick={() => editor.edit(field)}
        >
          <span>{editor.endLabel(field)}</span>
          {end && !editor.isStop(field) && <em>coordinate</em>}
        </button>
      )}
    </div>
  );
}

/**
 * A ticked line, never a typed code. Left-click requires the line, the small
 * button avoids it — "not the local train that stops everywhere" is a line
 * choice, which is what replaced substring-matching a station name.
 */
function LineChip({ line, editor }: { line: CommuteLineOption; editor: CommuteEditor }) {
  return (
    <span className={`commute-line commute-line-${line.state}`}>
      <button
        type="button"
        onClick={() => editor.toggleSelect(line)}
        title={[line.name, line.operator].filter(Boolean).join(' · ')}
        aria-pressed={line.state === 'select'}
      >
        <strong>{line.publicCode}</strong>
        {line.seen && <em title="Runs between your stops">✓</em>}
      </button>
      <button
        type="button"
        className="commute-line-not"
        onClick={() => editor.toggleExclude(line)}
        aria-pressed={line.state === 'exclude'}
        aria-label={`Avoid ${line.publicCode}`}
        title={`Avoid ${line.publicCode}`}
      >
        ✕
      </button>
    </span>
  );
}

/** "Leave at 07:10" / "Arrive by 08:30", per direction. */
function TimeField({
  direction,
  label,
  editor,
}: {
  direction: TransitCommuteDirection;
  label: string;
  editor: CommuteEditor;
}) {
  const time = direction === 'outbound' ? editor.config.outboundTime : editor.config.inboundTime;
  return (
    <div className="commute-time">
      <span className="commute-end-label">{label}</span>
      <div className="commute-time-row">
        <select
          value={time.arriveBy ? 'arrive' : 'leave'}
          disabled={!editor.ready}
          aria-label={`${label}: leave at or arrive by`}
          onChange={(event) => editor.setArriveBy(direction, event.target.value === 'arrive')}
        >
          <option value="leave">Leave at</option>
          <option value="arrive">Arrive by</option>
        </select>
        <input
          type="time"
          value={time.minutesOfDay === null ? '' : minutesOfDayLabel(time.minutesOfDay)}
          disabled={!editor.ready}
          aria-label={`${label} time`}
          onChange={(event) => {
            const [hours, minutes] = event.target.value.split(':');
            editor.setTime(
              direction,
              event.target.value && hours !== undefined && minutes !== undefined
                ? Number(hours) * 60 + Number(minutes)
                : null,
            );
          }}
        />
        {time.minutesOfDay !== null && (
          <button type="button" onClick={() => editor.setTime(direction, null)}>
            Now
          </button>
        )}
      </div>
    </div>
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
  getBias,
  onClose,
}: {
  commute: CommuteController;
  places: readonly PlaceRecord[];
  /** Map centre, so a stop search resolves near where the user is looking. */
  getBias: () => LatLng | null;
  onClose: () => void;
}) {
  const geocode = useGeocode(getBias);
  const editor = useCommuteEditor({ commute, places, geocode, fetchStopLines });
  // The way out before the outbound time, the way home after it — the answer a
  // board opened at 16:30 is being opened for.
  const initialDirection = useMemo(
    () => (commute.query ? defaultCommuteDirection(commute.query, Date.now()) : 'outbound'),
    [commute.query],
  );
  const [pinned, setPinned] = useState<TransitCommuteDirection | null>(null);
  const direction = pinned ?? initialDirection;
  const trips = commute.result?.[direction].trips ?? [];
  const reason = commute.emptyReason(direction);
  const [from, to] =
    direction === 'outbound'
      ? [editor.endLabel('from'), editor.endLabel('to')]
      : [editor.endLabel('to'), editor.endLabel('from')];

  return (
    <aside className="commute-panel" aria-label="Commute board">
      <div className="commute-header">
        <div>
          <strong>Commute</strong>
          <span>Your saved journey, both ways</span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      <div className="commute-body">
        {!commute.ready && <p className="commute-state">Loading saved commute…</p>}
        <div className="commute-fields">
          <EndField field="from" label="From" editor={editor} places={places} />
          <EndField field="via" label="Via" editor={editor} places={places} />
          <EndField field="to" label="To" editor={editor} places={places} />
        </div>
        <div className="commute-times">
          <TimeField direction="outbound" label="Outbound" editor={editor} />
          <TimeField direction="inbound" label="Return" editor={editor} />
        </div>
        <div className="commute-days" role="group" aria-label="Days this commute runs">
          {editor.days.map((day) => (
            <button
              type="button"
              key={day.day}
              aria-pressed={day.on}
              className={day.on ? 'on' : ''}
              onClick={() => editor.toggleDay(day.day)}
            >
              {day.label}
            </button>
          ))}
        </div>
        {editor.missing && <p className="commute-state">{editor.missing}</p>}
        {editor.lineGroups.length > 0 && (
          <div className="commute-services">
            <div className="commute-services-head">
              <span className="commute-end-label">Lines</span>
              {(editor.config.select.length > 0 || editor.config.exclude.length > 0) && (
                <button type="button" onClick={editor.clearLines}>
                  Any line
                </button>
              )}
            </div>
            {editor.lineGroups.map((group) => (
              <div className="commute-line-group" key={group.mode}>
                <span>{group.label}</span>
                <div className="commute-line-chips">
                  {group.lines.map((line) => (
                    <LineChip line={line} editor={editor} key={line.id} />
                  ))}
                </div>
              </div>
            ))}
            <p className="commute-rule">
              Tick the lines you use, or leave them all untouched for any service. ✓ marks a line
              that runs between your stops; ✕ avoids one.
            </p>
          </div>
        )}
        {editor.linesLoading && <p className="commute-state">Reading the lines at your stops…</p>}
        {editor.linesError && <p className="commute-state">{editor.linesError}</p>}
        <div className="commute-modes" role="group" aria-label="Ride modes">
          {editor.modes.map((mode) => (
            <button
              type="button"
              key={mode.mode}
              aria-pressed={mode.on}
              className={mode.on ? 'on' : ''}
              onClick={() => editor.toggleMode(mode.mode)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="commute-directions" role="tablist" aria-label="Commute direction">
          <button
            type="button"
            role="tab"
            aria-selected={direction === 'outbound'}
            onClick={() => setPinned('outbound')}
          >
            Outbound
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={direction === 'inbound'}
            onClick={() => setPinned('inbound')}
          >
            Return
          </button>
        </div>
        {editor.askable && (
          <div className="commute-route">
            <strong>
              {from} → {to}
            </strong>
            <span>{editor.timeLabel(direction)}</span>
          </div>
        )}
        {commute.loading && <p className="commute-state">Checking upcoming journeys…</p>}
        {commute.error && <p className="commute-state commute-error">{commute.error}</p>}
        {commute.result && trips.length === 0 && (
          <p className="commute-state">
            {emptyDirectionNote(reason === 'filtered' ? 'filtered' : 'upstream')}.
            {reason === 'filtered' && (
              <>
                {' '}
                <button type="button" className="link-button" onClick={editor.clearLines}>
                  Allow any line
                </button>
              </>
            )}
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
            disabled={commute.loading || !editor.askable}
          >
            Refresh
          </button>
        </div>
      </div>
    </aside>
  );
}
