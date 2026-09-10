/**
 * Reading a navigation diagnostic log.
 *
 * The reports written from these logs were derived with throwaway scripts, one
 * per investigation, so two readings of the same file agreed only by luck and
 * the fifth question of any analysis ("when exactly did it reroute?") cost
 * another script (ROADMAP §1.2). This module is the reading half of
 * `diagnostics.ts`: it knows the same record vocabulary the trip writes, turns
 * a file into trips, and answers the questions every report actually opens
 * with — what happened, in what order, and what the drive amounted to.
 *
 * Two summaries are produced per trip on purpose. `reported` is the one the
 * app wrote at `trip-end`; `measured` is rebuilt here from the records that
 * survived. They normally agree, and where they cannot — a trip the process
 * died in never wrote a `trip-end` at all — the rebuilt one is the only one
 * there is.
 */

import {
  FIX_GAP_MS,
  NavTripStats,
  navTripSampleFromLog,
  type CompactNavState,
  type NavDiagnosticRecord,
  type NavTripOutcome,
  type NavTripReport,
} from './diagnostics.js';

/** One thing worth seeing on a timeline, in the order it happened. */
export interface NavLogIncident {
  /** Epoch ms from the record's `at`, or null when it carried no timestamp. */
  atMs: number | null;
  /** Milliseconds since the trip's first record. */
  offsetMs: number;
  /** Incident family — `reroute`, `fix-gap`, `prompt`, `marker`, … */
  kind: string;
  detail: string;
}

/** A route this trip asked for or adopted, by digest. */
export interface NavLogRoute {
  digest: string;
  distanceM: number;
  timeMs: number;
  maneuvers: number;
  /** How many times a route with this geometry was adopted. */
  adopted: number;
}

export interface NavLogTrip {
  id: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  appVersion: string | null;
  runtimeVersion: string | null;
  profile: string | null;
  activity: string | null;
  destination: [number, number] | null;
  outcome: NavTripOutcome | null;
  records: number;
  bytes: number;
  /** The `trip-end` summary the app wrote, when it got as far as writing one. */
  reported: NavTripReport | null;
  /** The same summary rebuilt from the records — always present. */
  measured: NavTripReport;
  routes: NavLogRoute[];
  incidents: NavLogIncident[];
  /** Duplicate-stream fixes the app collapsed into counters. */
  duplicateFixes: number;
}

export interface NavLogAnalysis {
  trips: NavLogTrip[];
  /** Lines that were not parseable JSON records. */
  unreadableLines: number;
  bytes: number;
}

function timeOf(record: NavDiagnosticRecord): number | null {
  const at = record.at;
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const a = num(value[0]);
  const b = num(value[1]);
  return a === null || b === null ? null : [a, b];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `1.2 km` / `340 m` — the same shape a report writes by hand. */
function distance(metres: number | null): string {
  if (metres === null) return '—';
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

/** `1:02:03` / `27m 41s` / `8.4 s` — readable at every scale a drive spans. */
export function formatLogDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function clock(atMs: number | null): string {
  if (atMs === null) return '--:--:--';
  return new Date(atMs).toISOString().slice(11, 19);
}

function offset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `+${String(m).padStart(3, '0')}:${String(s).padStart(2, '0')}`;
}

/** Accumulates one trip while the records stream past. */
class TripBuilder {
  readonly incidents: NavLogIncident[] = [];
  readonly stats = new NavTripStats();
  readonly routes = new Map<string, NavLogRoute>();
  id: string | null = null;
  startedAtMs: number | null = null;
  endedAtMs: number | null = null;
  appVersion: string | null = null;
  runtimeVersion: string | null = null;
  profile: string | null = null;
  activity: string | null = null;
  destination: [number, number] | null = null;
  outcome: NavTripOutcome | null = null;
  reported: NavTripReport | null = null;
  records = 0;
  bytes = 0;
  duplicateFixes = 0;
  /** Route requests still awaiting their result, by reason. */
  readonly pendingRequests = new Map<string, number>();
  lastStatus: string | null = null;
  lastFix: string | null = null;
  lastStateAtMs: number | null = null;
  lastAdoptedDigest: string | null = null;
  inCorridorBreach = false;

  add(atMs: number | null, kind: string, detail: string): void {
    this.incidents.push({
      atMs,
      offsetMs: atMs !== null && this.startedAtMs !== null ? atMs - this.startedAtMs : 0,
      kind,
      detail,
    });
  }

  noteRoute(fingerprint: Record<string, unknown>, adopted: boolean): NavLogRoute | null {
    const digest = text(fingerprint.digest);
    if (digest === null) return null;
    const existing = this.routes.get(digest);
    const route: NavLogRoute = existing ?? {
      digest,
      distanceM: num(fingerprint.distanceM) ?? 0,
      timeMs: num(fingerprint.timeMs) ?? 0,
      maneuvers: num(fingerprint.maneuvers) ?? 0,
      adopted: 0,
    };
    if (adopted) route.adopted++;
    this.routes.set(digest, route);
    return route;
  }

  build(): NavLogTrip {
    return {
      id: this.id,
      startedAtMs: this.startedAtMs,
      endedAtMs: this.endedAtMs,
      appVersion: this.appVersion,
      runtimeVersion: this.runtimeVersion,
      profile: this.profile,
      activity: this.activity,
      destination: this.destination,
      outcome: this.outcome,
      records: this.records,
      bytes: this.bytes,
      reported: this.reported,
      measured: this.stats.report(),
      routes: [...this.routes.values()],
      // Time order, not file order: a support file may be a concatenation, and
      // a timeline that disagrees with its own timestamps is unreadable.
      incidents: this.incidents
        .slice()
        .sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0) || a.offsetMs - b.offsetMs),
      duplicateFixes: this.duplicateFixes,
    };
  }
}

/** Which `gps-stream` transitions are worth a timeline line rather than a tally. */
const NOTEWORTHY_STREAM_KINDS = new Set([
  'service-failed',
  'foreground-failed',
  'stream-stalled',
  'streams-restarted',
  'service-stopped',
  'service-started',
]);

/**
 * Turn a log file into trips.
 *
 * A file normally holds exactly one trip, because the app writes one file per
 * trip — but a `trip-start` always begins a new one, so a concatenation of
 * several (or one of the old single-file logs) reads correctly too. Records
 * before any `trip-start` land in an unnamed leading trip rather than being
 * dropped: in an interrupted log they are the whole drive.
 */
export function analyzeNavLog(logText: string): NavLogAnalysis {
  const trips: NavLogTrip[] = [];
  let current: TripBuilder | null = null;
  let unreadableLines = 0;
  let bytes = 0;

  const finish = (): void => {
    if (current) trips.push(current.build());
    current = null;
  };

  for (const line of logText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    bytes += line.length + 1;
    let parsed: NavDiagnosticRecord;
    try {
      const value: unknown = JSON.parse(trimmed);
      const asRecord = record(value);
      if (!asRecord || typeof asRecord.event !== 'string') throw new Error('not a record');
      parsed = asRecord as NavDiagnosticRecord;
    } catch {
      unreadableLines++;
      continue;
    }
    const atMs = timeOf(parsed);
    if (parsed.event === 'trip-start' || current === null) {
      if (parsed.event === 'trip-start') finish();
      current = current ?? new TripBuilder();
      if (current.startedAtMs === null) current.startedAtMs = atMs;
    }
    const trip: TripBuilder = current;
    trip.records++;
    trip.bytes += line.length + 1;
    trip.appVersion ??= text(parsed.appVersion);
    trip.runtimeVersion ??= text(parsed.runtimeVersion);
    applyRecord(trip, parsed, atMs);
  }
  finish();
  return { trips, unreadableLines, bytes };
}

function applyRecord(trip: TripBuilder, parsed: NavDiagnosticRecord, atMs: number | null): void {
  switch (parsed.event) {
    case 'trip-start': {
      trip.id = text(parsed.trip);
      trip.profile = text(parsed.profile);
      trip.activity = text(parsed.activity);
      trip.destination = pair(parsed.destination);
      trip.add(
        atMs,
        'trip',
        `start · ${trip.profile ?? trip.activity ?? 'trip'}${
          trip.destination ? ` → ${trip.destination[0]},${trip.destination[1]}` : ''
        }`,
      );
      return;
    }
    case 'trip-arrived': {
      trip.add(atMs, 'trip', 'arrived');
      return;
    }
    case 'trip-end': {
      trip.endedAtMs = atMs;
      const outcome = text(parsed.outcome);
      trip.outcome = (outcome as NavTripOutcome | null) ?? null;
      const reported = record(parsed.report);
      if (reported) trip.reported = reported as unknown as NavTripReport;
      trip.add(atMs, 'trip', `end · ${outcome ?? 'unknown'}`);
      return;
    }
    case 'navigation-phase': {
      trip.add(
        atMs,
        'phase',
        `${text(parsed.from) ?? '?'} → ${text(parsed.to) ?? '?'}${
          text(parsed.error) ? ` · ${text(parsed.error)}` : ''
        }`,
      );
      return;
    }
    case 'route-request': {
      const reason = text(parsed.reason) ?? 'unknown';
      if (atMs !== null) trip.pendingRequests.set(reason, atMs);
      return;
    }
    case 'route-result': {
      const reason = text(parsed.reason) ?? 'unknown';
      const fingerprint = record(parsed.route);
      const route = fingerprint ? trip.noteRoute(fingerprint, false) : null;
      const askedAtMs = trip.pendingRequests.get(reason) ?? null;
      trip.pendingRequests.delete(reason);
      const took =
        askedAtMs !== null && atMs !== null ? ` in ${formatLogDuration(atMs - askedAtMs)}` : '';
      const alternatives = num(parsed.choices);
      trip.add(
        atMs,
        'route',
        `${reason} → ${route ? `${distance(route.distanceM)} / ${formatLogDuration(route.timeMs)} (${route.digest})` : 'no route'}${
          alternatives !== null && alternatives > 1 ? ` · ${alternatives} choices` : ''
        }${took}`,
      );
      return;
    }
    case 'route-failed': {
      trip.stats.routeFailed();
      trip.add(
        atMs,
        'route-failed',
        `${text(parsed.reason) ?? 'unknown'} · ${text(parsed.error) ?? 'no reason given'}`,
      );
      return;
    }
    case 'route-adopted': {
      const fingerprint = record(parsed.route);
      const route = fingerprint ? trip.noteRoute(fingerprint, true) : null;
      const banked = num(parsed.bankedM);
      if (banked !== null) trip.stats.routeAdopted(banked);
      const same = route !== null && route.digest === trip.lastAdoptedDigest;
      if (route) trip.lastAdoptedDigest = route.digest;
      trip.add(
        atMs,
        'route-adopted',
        `${text(parsed.reason) ?? 'unknown'} · ${
          route
            ? `${distance(route.distanceM)} / ${formatLogDuration(route.timeMs)} (${route.digest})`
            : 'unknown route'
        }${same ? ' · identical geometry' : ''}`,
      );
      return;
    }
    case 'route-repriced': {
      const delta = num(parsed.deltaMs);
      trip.add(
        atMs,
        'repriced',
        `schedule ${delta !== null && delta >= 0 ? '+' : ''}${delta === null ? '?' : formatLogDuration(Math.abs(delta))}`,
      );
      return;
    }
    case 'faster-probe': {
      const candidate = record(parsed.route);
      // A candidate that was offered and not taken is exactly what a report
      // wants to see, so it joins the trip's route list as "offered".
      if (candidate) trip.noteRoute(candidate, false);
      const saves = num(parsed.savesMs);
      trip.add(
        atMs,
        'faster-probe',
        `${text(parsed.verdict) ?? 'unknown'} · planned ${formatLogDuration(num(parsed.plannedMs) ?? 0)} vs ${formatLogDuration(
          num(parsed.candidateMs) ?? 0,
        )}${saves === null ? '' : ` · saves ${formatLogDuration(saves)}`}`,
      );
      return;
    }
    case 'voice-prompt': {
      trip.stats.promptEmitted();
      const index = num(parsed.maneuverIndex);
      const threshold = num(parsed.thresholdM);
      trip.add(
        atMs,
        'prompt',
        `${text(parsed.kind) ?? '?'}${index === null ? '' : ` #${index}`}${
          threshold ? ` @${Math.round(threshold)} m` : ''
        }${parsed.spoken === false ? ' (muted)' : ''} · ${text(parsed.text) ?? ''}`,
      );
      return;
    }
    case 'user-marker': {
      trip.stats.markerAdded();
      trip.add(atMs, 'marker', text(parsed.note) ?? 'moment marked');
      return;
    }
    case 'log-truncated': {
      trip.add(atMs, 'truncated', `log hit its size cap (${num(parsed.bytes) ?? 0} bytes)`);
      return;
    }
    case 'gps-duplicates': {
      trip.duplicateFixes += num(parsed.count) ?? 0;
      return;
    }
    case 'gps-stream': {
      const kind = text(parsed.kind);
      if (kind !== null && NOTEWORTHY_STREAM_KINDS.has(kind)) {
        trip.add(atMs, 'stream', `${kind}${text(parsed.error) ? ` · ${text(parsed.error)}` : ''}`);
      }
      return;
    }
    case 'gps-task-error': {
      trip.add(atMs, 'stream', `background task error · ${text(parsed.error) ?? ''}`);
      return;
    }
    case 'navigation-state': {
      applyState(trip, parsed, atMs);
      return;
    }
    default:
      return;
  }
}

function applyState(trip: TripBuilder, parsed: NavDiagnosticRecord, atMs: number | null): void {
  const state = record(parsed.state) as CompactNavState | null;
  if (!state || typeof state.status !== 'string' || typeof state.fix !== 'string') return;
  const match = record(parsed.match);
  const accuracyM = match ? num(match.accM) : null;
  if (atMs !== null) trip.stats.sample(navTripSampleFromLog(state, accuracyM), atMs);

  if (atMs !== null && trip.lastStateAtMs !== null && atMs - trip.lastStateAtMs > FIX_GAP_MS) {
    trip.add(atMs, 'fix-gap', `${formatLogDuration(atMs - trip.lastStateAtMs)} without a state`);
  }
  if (atMs !== null) trip.lastStateAtMs = atMs;

  if (state.status !== trip.lastStatus) {
    if (trip.lastStatus !== null || state.status !== 'navigating') {
      trip.add(
        atMs,
        state.status === 'off-route' ? 'off-route' : 'status',
        `${trip.lastStatus ?? 'start'} → ${state.status}${
          match
            ? ` · cross ${distance(num(match.crossM))}, offRouteCount ${num(match.offRouteCount) ?? 0}/${num(match.grace) ?? 0}, wrongWayCount ${num(match.wrongWayCount) ?? 0}/${num(match.grace) ?? 0}`
            : ''
        }`,
      );
    }
    trip.lastStatus = state.status;
  }
  if (state.fix !== trip.lastFix) {
    if (trip.lastFix !== null || state.fix !== 'live') {
      trip.add(atMs, 'fix', `${trip.lastFix ?? 'start'} → ${state.fix}`);
    }
    trip.lastFix = state.fix;
  }
  if (state.wrongBranch) trip.add(atMs, 'wrong-branch', 'sensors disagree with the assumed line');

  // One line per breach, not one per fix inside it: a corridor excursion is an
  // episode, and the old logs' thousand-line runs are why nobody read them.
  if (match) {
    const crossM = num(match.crossM);
    const corridorM = num(match.corridorM);
    const breaching = crossM !== null && corridorM !== null && crossM > corridorM;
    if (breaching && !trip.inCorridorBreach) {
      trip.add(
        atMs,
        'corridor',
        `left the ${Math.round(corridorM)} m corridor at ${distance(crossM)}${
          match.accurate === false ? ' (fix too coarse to count)' : ''
        }`,
      );
    }
    trip.inCorridorBreach = breaching;
  }
}

export interface NavLogFormatOptions {
  /** Incident kinds to show; omit for everything but `prompt`. */
  include?: readonly string[];
  /** Cap the timeline so one pathological trip cannot bury the summary. */
  maxIncidents?: number;
}

const DEFAULT_HIDDEN = new Set(['prompt']);

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function summaryLines(report: NavTripReport): string[] {
  return [
    `distance ${distance(report.distanceM)} · ${report.samples} states · snapped ${percent(report.snappedShare)} · ` +
      `off-route ${formatLogDuration(report.offRouteMs)} · no live fix ${formatLogDuration(report.noLiveFixMs)} ` +
      `(reckoned ${formatLogDuration(report.reckonedMs)}, lost ${formatLogDuration(report.lostMs)})`,
    `route changes ${report.routeChanges} · route failures ${report.routeFailures} · prompts ${report.prompts} · ` +
      `markers ${report.markers} · fix gaps ${report.fixGaps} (max ${formatLogDuration(report.maxFixGapMs)}) · ` +
      `worst accuracy ${report.worstAccuracyM === null ? '—' : `${report.worstAccuracyM} m`} · ` +
      `max off-route ${distance(report.maxOffRouteM)}`,
  ];
}

/** The whole analysis as the plain-text report a support session actually reads. */
export function formatNavLogReport(
  analysis: NavLogAnalysis,
  options: NavLogFormatOptions = {},
): string {
  const include = options.include ? new Set(options.include) : null;
  const maxIncidents = options.maxIncidents ?? 4000;
  const out: string[] = [];
  const kb = (analysis.bytes / 1024).toFixed(0);
  out.push(
    `Atlas navigation log — ${analysis.trips.length} trip${analysis.trips.length === 1 ? '' : 's'}, ${kb} KB` +
      (analysis.unreadableLines > 0 ? `, ${analysis.unreadableLines} unreadable lines` : ''),
  );

  for (const trip of analysis.trips) {
    const duration =
      trip.startedAtMs !== null && trip.endedAtMs !== null
        ? formatLogDuration(trip.endedAtMs - trip.startedAtMs)
        : formatLogDuration(trip.measured.durationMs);
    out.push('');
    out.push(
      `Trip ${trip.id ?? '(unnamed)'} · ${trip.profile ?? trip.activity ?? 'unknown mode'} · ` +
        `${trip.startedAtMs === null ? 'unknown start' : new Date(trip.startedAtMs).toISOString().replace('T', ' ').slice(0, 19)} · ` +
        `${duration} · ${trip.outcome ?? 'no trip-end recorded'}`,
    );
    out.push(
      `  app ${trip.appVersion ?? '?'} · runtime ${trip.runtimeVersion ?? '?'} · ` +
        `${trip.records} records / ${(trip.bytes / 1024).toFixed(0)} KB` +
        (trip.destination ? ` · destination ${trip.destination[0]},${trip.destination[1]}` : '') +
        (trip.duplicateFixes > 0 ? ` · ${trip.duplicateFixes} duplicate-stream fixes` : ''),
    );
    for (const line of summaryLines(trip.measured)) out.push(`  ${line}`);
    if (trip.reported) {
      // The app's own summary is kept beside the rebuilt one rather than
      // replacing it: where they disagree, the disagreement is the finding.
      const app = trip.reported;
      if (
        app.distanceM !== trip.measured.distanceM ||
        app.routeChanges !== trip.measured.routeChanges
      ) {
        out.push(
          `  app reported: distance ${distance(app.distanceM)} · route changes ${app.routeChanges} · prompts ${app.prompts}`,
        );
      }
    }
    if (trip.routes.length > 0) {
      out.push(
        `  routes: ${trip.routes
          .map(
            (r) =>
              `${r.digest} ${distance(r.distanceM)}/${formatLogDuration(r.timeMs)}${r.adopted > 0 ? ` ×${r.adopted}` : ' (offered)'}`,
          )
          .join(' · ')}`,
      );
    }

    const shown = trip.incidents.filter((incident) =>
      include ? include.has(incident.kind) : !DEFAULT_HIDDEN.has(incident.kind),
    );
    out.push('');
    out.push(`  Timeline (${shown.length} of ${trip.incidents.length} incidents)`);
    for (const incident of shown.slice(0, maxIncidents)) {
      out.push(
        `  ${offset(incident.offsetMs)}  ${clock(incident.atMs)}  ${incident.kind.padEnd(13)} ${incident.detail}`,
      );
    }
    if (shown.length > maxIncidents) out.push(`  … ${shown.length - maxIncidents} more`);
  }
  return out.join('\n');
}
