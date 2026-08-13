import type { NavController } from '@atlas/app-hooks';
import { fmtClock, fmtDistanceM, fmtDuration, fmtKm, type NavWidgetId } from '@atlas/core';
import {
  backToTrack,
  laneGlyphs,
  laneLabel,
  remainingAscentM,
  shortManeuverText,
  tunnelChipLabel,
} from '@atlas/navigation';
import { formatExitSign, ROUTING_PROFILES, type RouteLane } from '@atlas/routing';
import { formatTrafficDelay } from '@atlas/traffic';
import { TurnIcon } from './TurnIcon.js';

/** Ground speed in km/h, or null when stationary/unknown. */
function speedKph(speedMps: number | null): number | null {
  if (speedMps == null || speedMps < 0.5) return null;
  return Math.round(speedMps * 3.6);
}

function widgetValue(widget: NavWidgetId, nav: NavController): { value: string; unit: string } {
  switch (widget) {
    case 'speed':
      return { value: String(speedKph(nav.speedMps) ?? 0), unit: 'km/h' };
    case 'altitude':
      return {
        value: nav.altitudeM === null ? '—' : String(Math.round(nav.altitudeM)),
        unit: 'altitude m',
      };
    case 'ascent': {
      // Climb still ahead — the number that matters on a hike. An honest dash
      // where the route carries no elevation (offline packs have no DEM).
      const ascent = nav.activePath
        ? remainingAscentM(nav.activePath.points, nav.state?.traveledM ?? 0)
        : null;
      return { value: ascent === null ? '—' : String(ascent), unit: 'climb m' };
    }
    case 'next-turn':
      return {
        value: nav.state?.upcoming ? fmtDistanceM(nav.state.upcoming.distanceToM) : '—',
        unit: 'next turn',
      };
    case 'remaining':
      return {
        value: nav.state ? fmtDistanceM(nav.state.distanceRemainingM) : '—',
        unit: 'remaining',
      };
  }
}

function LaneRow({ lanes }: { lanes: RouteLane[] }) {
  return (
    <div className="nav-lanes" aria-label="Lane guidance">
      {lanes.map((lane, index) => (
        <span
          className={`nav-lane nav-lane-${lane.state}`}
          aria-label={`Lane ${index + 1}: ${laneLabel(lane)}`}
          key={index}
        >
          <svg viewBox="0 0 24 32" aria-hidden="true">
            {laneGlyphs(lane).map((glyph) => (
              <path
                d={glyph.path}
                className={glyph.recommended ? 'nav-lane-recommended' : undefined}
                key={glyph.direction}
              />
            ))}
          </svg>
        </span>
      ))}
    </div>
  );
}

function NavActionIcon({ kind }: { kind: 'recenter' | 'overview' | 'follow' | 'sound' | 'mute' }) {
  if (kind === 'recenter') {
    return (
      <svg className="nav-action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="5" />
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </svg>
    );
  }
  if (kind === 'overview') {
    return (
      <svg className="nav-action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m3.5 6 5-2.5 7 3 5-2.5v14l-5 2.5-7-3-5 2.5zM8.5 3.5v14M15.5 6.5v14" />
      </svg>
    );
  }
  if (kind === 'follow') {
    return (
      <svg className="nav-action-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3 7.5 17-7.5-3.4L4.5 20z" />
      </svg>
    );
  }
  return (
    <svg className="nav-action-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 10v4h4l5 4V6L8 10z" />
      {kind === 'mute' ? (
        <path d="m17 9 5 5M22 9l-5 5" />
      ) : (
        <path d="M16.5 9.2a4 4 0 0 1 0 5.6M19 6.8a7.3 7.3 0 0 1 0 10.4" />
      )}
    </svg>
  );
}

/**
 * Turn-by-turn banner for web navigation (Android NavBanner's twin): next
 * maneuver (+ "then" hint), progress, ETA, plus mute / orientation / overview /
 * recenter / End controls, a current-road chip at the bottom of the screen,
 * and a small trip summary on arrival.
 */
export function NavBanner({
  nav,
  followPaused,
  onResumeFollow,
  followMode,
  onToggleFollowMode,
  overview,
  onToggleOverview,
  widgets,
  onToggleAddStop,
  addStopOpen,
}: {
  nav: NavController;
  followPaused: boolean;
  onResumeFollow: () => void;
  followMode: 'course' | 'north';
  onToggleFollowMode: () => void;
  overview: boolean;
  onToggleOverview: () => void;
  widgets: NavWidgetId[];
  /** Open/close the quick add-a-stop panel (gas, charging, food). */
  onToggleAddStop: () => void;
  addStopOpen: boolean;
}) {
  // The preview phase has its own bottom card (RoutePreview) — no banner.
  if (nav.phase === 'idle' || nav.phase === 'preview') return null;
  const { state } = nav;
  const maneuver = state?.upcoming;
  const guiding = nav.phase === 'navigating' || nav.phase === 'rerouting';
  const exploring = nav.phase === 'exploring';
  const moving = guiding || exploring;
  const sustain = guiding ? (state?.sustain ?? null) : null;
  // "then …" hint when the maneuver after the current one follows hot on its
  // heels — or the distant maneuver demoted below a long-road sustain cue.
  const thenManeuver =
    sustain && maneuver
      ? maneuver
      : maneuver && state?.then && state.then.distanceToM - maneuver.distanceToM < 300
        ? state.then
        : null;
  // Inside a mapped tunnel the chip names the tunnel and counts it down — the
  // road underneath is still E6, but "Brynstunnelen · 1.2 km" is what the
  // driver can check against the world outside the windscreen.
  const tunnel = guiding ? (state?.tunnel ?? null) : null;
  const road = tunnel ? tunnelChipLabel(tunnel) : guiding ? (state?.currentRoad ?? null) : null;
  const walking = nav.profile === 'foot' || nav.profile === 'hike';
  // No speed-limit roundel on foot: the 80 km/h sign on the road a footpath
  // parallels is driving furniture, not guidance.
  const speedLimit = guiding && !walking ? (state?.speedLimitKph ?? null) : null;
  // ATK camera guidance (car routes in Norway only — elsewhere the data is
  // simply absent, so no chip: the §2.1 rule). A section in progress outranks
  // the next point camera; the average is what section control is about.
  const sectionControl = guiding && !walking ? (state?.sectionControl ?? null) : null;
  const speedCamera = !sectionControl && guiding && !walking ? (state?.speedCamera ?? null) : null;
  const sectionOver =
    sectionControl?.avgKph != null &&
    sectionControl.limitKph != null &&
    sectionControl.avgKph > sectionControl.limitKph;
  // Walking modes offer the reroute instead of performing it — and for the
  // hiker who lost the trail with no network, the straight line back to it is
  // the half that still works offline.
  const trackBack =
    nav.rerouteOffered && state && nav.activePath
      ? backToTrack(nav.activePath.points, state.raw)
      : null;
  const trackWord = nav.profile === 'hike' ? 'Trail' : 'Route';
  // The manual way out, offered only near the destination — where the automatic
  // rules can fail (a fix that never gets accurate enough in a car park) and
  // where "I've arrived" is the one thing the traveller knows better than we do.
  // Deliberately distinct from End: this completes the trip rather than
  // abandoning it, so it banks the summary.
  const canDeclareArrival = guiding && state != null && state.distanceRemainingM <= 150;
  const canContinuePastStop = guiding && nav.nextIntermediateStop !== null;
  const profileLabel = ROUTING_PROFILES.find((candidate) => candidate.id === nav.profile)?.label;
  const shownWidgets: NavWidgetId[] = exploring ? ['speed', 'altitude'] : widgets;

  return (
    <>
      <div className="nav-banner" role="status">
        <div className="nav-card">
          {exploring ? (
            <div className="nav-state-block">
              <span className="nav-state-eyebrow">Explorer mode</span>
              <span className="nav-maneuver">
                {nav.position
                  ? `${profileLabel ?? 'Travel'} · Following your position`
                  : 'Finding your position…'}
              </span>
              <span className="nav-arrival-summary">No destination or turn-by-turn guidance</span>
            </div>
          ) : nav.phase === 'starting' ? (
            <div className="nav-state-block">
              <span className="nav-state-eyebrow">Navigation</span>
              <span className="nav-maneuver">Finding the best route…</span>
            </div>
          ) : nav.phase === 'error' ? (
            <div className="nav-state-block">
              <span className="nav-state-eyebrow">
                {nav.activity === 'explorer' ? 'Explorer unavailable' : 'Navigation unavailable'}
              </span>
              <span className="nav-error">{nav.error ?? 'Navigation error'}</span>
            </div>
          ) : nav.phase === 'paused' ? (
            <div className="nav-state-block">
              <span className="nav-state-eyebrow">Navigation paused</span>
              <span className="nav-maneuver">Your trip is waiting</span>
              <span className="nav-arrival-summary">
                {state ? `${fmtKm(state.distanceRemainingM)} remaining · ` : ''}
                Position, progress and voice guidance are stopped
              </span>
              {nav.error ? <span className="nav-error">{nav.error}</span> : null}
            </div>
          ) : nav.phase === 'arrived' ? (
            <div className="nav-state-block">
              <span className="nav-state-eyebrow">Trip complete</span>
              <span className="nav-maneuver">You have arrived</span>
              {nav.tripSummary ? (
                <span className="nav-arrival-summary">
                  Estimated {fmtDuration(nav.tripSummary.originalEstimateMs)} · Actual{' '}
                  {fmtDuration(nav.tripSummary.durationMs)} · {fmtKm(nav.tripSummary.distanceM)}
                </span>
              ) : null}
            </div>
          ) : maneuver ? (
            <>
              <div className="nav-guidance-row">
                <div className="nav-turn-panel">
                  <TurnIcon instruction={sustain ? { sign: 0 } : maneuver.instruction} size={44} />
                </div>
                <div className="nav-maneuver-text">
                  <span className="nav-distance-to">
                    {sustain
                      ? `Continue for ${fmtKm(sustain.distanceRemainingM)}`
                      : `In ${fmtKm(maneuver.distanceToM)}`}
                  </span>
                  <span className="nav-maneuver">
                    {sustain ? sustain.road : shortManeuverText(maneuver.instruction)}
                  </span>
                  {!sustain && maneuver.instruction.exitSign ? (
                    <span className="nav-exit-sign">
                      {formatExitSign(maneuver.instruction.exitSign)}
                    </span>
                  ) : null}
                </div>
              </div>
              {state?.laneGuidance ? <LaneRow lanes={state.laneGuidance} /> : null}
              {thenManeuver ? (
                <div className="nav-then-row">
                  <span className="nav-then-label">Then</span>
                  <TurnIcon instruction={thenManeuver.instruction} size={20} />
                  <span className="nav-then-text">
                    {shortManeuverText(thenManeuver.instruction)}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="nav-state-block">
              <span className="nav-state-eyebrow">On route</span>
              <span className="nav-maneuver">Continue straight ahead</span>
            </div>
          )}

          {nav.phase === 'rerouting' ? <span className="nav-reroute">Rerouting…</span> : null}
          {guiding && nav.headingCalibrationNeeded ? (
            <span className="nav-reroute">
              Compass needs calibration — move your phone in a figure 8
            </span>
          ) : null}
          {nav.rerouteOffered ? (
            <div className="nav-offroute-row">
              <span className="nav-offroute-text">
                Off route
                {trackBack
                  ? ` — ${trackWord.toLowerCase()} is ${fmtDistanceM(trackBack.distanceM)} ${trackBack.cardinal}`
                  : ''}
              </span>
              <button type="button" className="nav-offroute-reroute" onClick={nav.rerouteNow}>
                Reroute
              </button>
            </div>
          ) : null}
          {nav.rerouteFailed && nav.phase === 'navigating' ? (
            <span className="nav-reroute">
              {nav.rerouteOffered
                ? // The offline-hike case: no new line is coming, and the offer
                  // row above still points the way back to the track.
                  'Can’t reroute — no connection'
                : 'Can’t reroute — continue on the line'}
            </span>
          ) : null}
          {nav.fasterRoute && nav.phase === 'navigating' ? (
            <div className="nav-faster-row">
              <span className="nav-faster-text">
                Faster route — saves {fmtDuration(nav.fasterRoute.savesMs)}
              </span>
              <button type="button" className="nav-faster-switch" onClick={nav.acceptFasterRoute}>
                Switch
              </button>
              <button
                type="button"
                className="nav-faster-dismiss"
                onClick={nav.dismissFasterRoute}
                aria-label="Keep the current route"
                title="Keep the current route"
              >
                ✕
              </button>
            </div>
          ) : null}
          {state && guiding ? (
            <>
              {/* Time left leads (Android parity): mid-drive "12 min" is the
                  number the driver decides on, and needs no "left" label in a
                  guidance banner. Arrival clock next, distance last. */}
              <div className="nav-trip-row">
                <span className="nav-eta">
                  <strong>{fmtDuration(state.timeRemainingMs)}</strong>
                </span>
                <span className="nav-summary">
                  {fmtClock(state.etaEpochMs)} arrival · {fmtKm(state.distanceRemainingM)}
                </span>
                {/* The measured part of the time above — only ever the traffic
                    still ahead, so it disappears as the queue is driven
                    through, and it explains an ETA that moved without the
                    driver doing anything. */}
                {formatTrafficDelay(state.trafficDelayMs) ? (
                  <span className="nav-traffic-delay">
                    {formatTrafficDelay(state.trafficDelayMs)}
                  </span>
                ) : null}
              </div>
              <div className="nav-progress-track" aria-hidden="true">
                <div
                  className="nav-progress-fill"
                  style={{
                    width: `${Math.round(Math.min(1, Math.max(0, state.routeProgress)) * 100)}%`,
                  }}
                />
              </div>
            </>
          ) : null}
        </div>
        <div className={`nav-actions${canDeclareArrival ? ' nav-actions-arrival' : ''}`}>
          {moving ? (
            <div className="nav-widgets" aria-label="Navigation widgets">
              {shownWidgets.map((widget) => {
                const display = widgetValue(widget, nav);
                return (
                  <span className="nav-widget" key={widget}>
                    <strong>{display.value}</strong>
                    <small>{display.unit}</small>
                  </span>
                );
              })}
              {/* Absent wherever the map data has no limit — an honest gap
                  beats a stale number the driver might trust. */}
              {speedLimit != null ? (
                <span className="nav-speed-limit" title="Speed limit">
                  {speedLimit}
                </span>
              ) : null}
            </div>
          ) : (
            <span />
          )}
          <div className="nav-buttons">
            {moving && followPaused ? (
              <button
                type="button"
                className="nav-action-button"
                onClick={onResumeFollow}
                aria-label="Recenter"
                title="Recenter"
              >
                <NavActionIcon kind="recenter" />
              </button>
            ) : null}
            {guiding ? (
              <button
                type="button"
                className="nav-action-button"
                onClick={onToggleAddStop}
                aria-label="Add a stop"
                aria-pressed={addStopOpen}
                title="Add a stop (gas, charging, food)"
              >
                <svg className="nav-action-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            ) : null}
            {guiding ? (
              <button
                type="button"
                className="nav-action-button"
                onClick={onToggleOverview}
                aria-label={overview ? 'Back to follow view' : 'Show route overview'}
                aria-pressed={overview}
                title={overview ? 'Back to the follow view' : 'Show the whole remaining route'}
              >
                <NavActionIcon kind={overview ? 'follow' : 'overview'} />
              </button>
            ) : null}
            {moving ? (
              <button
                type="button"
                className="nav-action-button nav-orientation-button"
                onClick={onToggleFollowMode}
                aria-label={followMode === 'course' ? 'Switch to north-up' : 'Switch to course-up'}
                title={followMode === 'course' ? 'Switch to north-up' : 'Switch to course-up'}
              >
                {followMode === 'course' ? 'N' : <NavActionIcon kind="follow" />}
              </button>
            ) : null}
            {guiding ? (
              <button
                type="button"
                className="nav-action-button"
                onClick={nav.toggleMute}
                aria-label={nav.muted ? 'Unmute guidance' : 'Mute guidance'}
                aria-pressed={nav.muted}
                title={nav.muted ? 'Unmute guidance' : 'Mute guidance'}
              >
                <NavActionIcon kind={nav.muted ? 'mute' : 'sound'} />
              </button>
            ) : null}
            {guiding ? (
              <button type="button" className="nav-pause" onClick={nav.pause}>
                Pause
              </button>
            ) : nav.phase === 'paused' ? (
              <button type="button" className="nav-arrived" onClick={nav.continueTrip}>
                Resume
              </button>
            ) : null}
            {canContinuePastStop ? (
              <button
                type="button"
                className="nav-arrived"
                onClick={nav.continuePastIntermediateStop}
                title="Mark the current intermediate stop visited and continue"
              >
                Stop visited
              </button>
            ) : null}
            {canDeclareArrival ? (
              <button
                type="button"
                className="nav-arrived"
                onClick={nav.arriveNow}
                title="Finish the trip here"
              >
                I&apos;ve arrived
              </button>
            ) : null}
            <button type="button" className="nav-stop" onClick={nav.stop}>
              {nav.phase === 'arrived' ? 'Done' : 'End'}
            </button>
          </div>
        </div>
      </div>
      {road ? <div className="nav-road-chip">{road}</div> : null}
      {sectionControl ? (
        <div
          className={`nav-camera-chip${sectionOver ? ' nav-camera-over' : ''}`}
          role="status"
          aria-label="Average speed check"
        >
          {sectionControl.avgKph !== null
            ? `Avg ${sectionControl.avgKph}${sectionControl.limitKph !== null ? ` / ${sectionControl.limitKph}` : ''} km/h · `
            : 'Average speed check · '}
          {fmtKm(sectionControl.remainingM)} left
        </div>
      ) : speedCamera ? (
        <div className="nav-camera-chip" role="status" aria-label="Speed camera ahead">
          Speed camera · {fmtDistanceM(speedCamera.distanceM)}
        </div>
      ) : null}
    </>
  );
}
