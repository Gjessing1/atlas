import { useTransitDepartures, type TransitDeparturesFn } from '@atlas/app-hooks';
import { fmtDistanceM } from '@atlas/core';
import {
  departureBoardLiveLabel,
  fetchTransitDepartures,
  legTimeParts,
  TRANSIT_MODE_LABEL,
  type TransitLocation,
} from '@atlas/transit';

const loadDepartures: TransitDeparturesFn = (query, signal) =>
  fetchTransitDepartures(query, { signal });

/** The destination-free, next-hour board embedded in a web place card. */
export function StopDepartures({ location }: { location: TransitLocation }) {
  const state = useTransitDepartures(loadDepartures, location, true);
  const result = state.result;
  const stop = result?.stop;

  return (
    <section className="stop-departures" data-testid="stop-departures">
      <div className="stop-departures-head">
        <div>
          <strong>{stop?.name ?? 'Departures nearby'}</strong>
          {stop?.distanceM !== undefined && (
            <span>{fmtDistanceM(stop.distanceM)} from this point · next hour</span>
          )}
          {stop && stop.distanceM === undefined && <span>Next hour</span>}
        </div>
        <button type="button" onClick={state.refresh} disabled={state.loading}>
          Refresh
        </button>
      </div>

      {state.loading && <p className="stop-departures-state">Looking up departures…</p>}
      {state.error && <p className="stop-departures-state stop-departures-error">{state.error}</p>}
      {result && !stop && (
        <p className="stop-departures-state">No public transport stop within 1.5 km.</p>
      )}
      {stop && result.departures.length === 0 && (
        <p className="stop-departures-state">Nothing leaves this stop in the next hour.</p>
      )}
      {stop && result.departures.length > 0 && (
        <ol className="stop-departures-list">
          {result.departures.map((departure) => {
            const time = legTimeParts({
              aimedMs: departure.aimedDepartureMs,
              expectedMs: departure.expectedDepartureMs,
              realtime: departure.realtime,
              predictionInaccurate: departure.predictionInaccurate,
            });
            return (
              <li
                key={departure.id}
                className={departure.cancelled ? 'stop-departure-cancelled' : undefined}
              >
                <div className={`stop-departure-time ${time.tone}`}>
                  {time.delay && <del>{time.aimed}</del>}
                  <strong>{time.expected}</strong>
                  {time.delay && <span>{time.delay}</span>}
                </div>
                <div className="stop-departure-service">
                  <span
                    className="stop-departure-line"
                    style={{
                      backgroundColor: departure.line.colour,
                      color: departure.line.textColour,
                    }}
                  >
                    {departure.line.publicCode}
                  </span>
                  <span className="stop-departure-destination">
                    {departure.cancelled ? 'Cancelled' : departure.destination}
                  </span>
                  <span className="stop-departure-meta">
                    {TRANSIT_MODE_LABEL[departure.mode]}
                    {departure.quay.publicCode ? ` · plat. ${departure.quay.publicCode}` : ''}
                    {departure.line.operator ? ` · ${departure.line.operator}` : ''}
                    {` · ${time.confidenceLabel}`}
                  </span>
                  {departure.situations[0] && (
                    <span className="stop-departure-notice">{departure.situations[0].summary}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className="stop-departures-live">
        Entur · {departureBoardLiveLabel(state.updatedMs, state.loading, state.error !== null)}
      </p>
    </section>
  );
}
