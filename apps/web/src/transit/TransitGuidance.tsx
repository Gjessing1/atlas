import { transitAlightAlarms, transitGuidanceAt, type TransitTrip } from '@atlas/transit';
import { useEffect, useMemo, useState } from 'react';

/** Ask from the Start button's user gesture; browsers reject notification prompts from effects. */
export async function prepareWebTransitAlarms(): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  await Notification.requestPermission();
}

export function TransitGuidance({ trip, onStop }: { trip: TransitTrip; onStop: () => void }) {
  const [nowMs, setNowMs] = useState(Date.now());
  const snapshot = useMemo(() => transitGuidanceAt(trip, nowMs), [trip, nowMs]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timers = transitAlightAlarms(trip, Date.now()).map((alarm) =>
      window.setTimeout(
        () => {
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(alarm.title, { body: alarm.body, tag: `atlas-transit-${alarm.id}` });
          }
          navigator.vibrate?.([300, 150, 300]);
        },
        Math.max(0, alarm.triggerAtMs - Date.now()),
      ),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [trip]);

  return (
    <aside
      className={`transit-guidance ${snapshot.alightSoon ? 'alight' : ''}`}
      aria-label="Transit guidance"
      role={snapshot.alightSoon ? 'alert' : undefined}
    >
      <div className="transit-guidance-head">
        <span>
          Leg {snapshot.legIndex + 1} of {trip.legs.length}
        </span>
        <button type="button" onClick={onStop}>
          End
        </button>
      </div>
      <strong>{snapshot.headline}</strong>
      {snapshot.countdown && <b className="transit-guidance-countdown">{snapshot.countdown}</b>}
      <span>{snapshot.detail}</span>
      <small>
        Timetable snapshot — guidance continues offline; live changes need a new journey lookup.
      </small>
    </aside>
  );
}
