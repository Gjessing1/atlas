/**
 * The device half of the navigation diagnostic log: where records go, how long
 * they are kept, and how they leave the phone.
 *
 * The vocabulary — what a record says, and the trip-start/trip-end brackets
 * this file turns into files — belongs to `@atlas/navigation`; everything here
 * is storage policy, and all of it was written against a real failure:
 *
 *  - **One file per trip.** A single append-only log, rotated only when it
 *    passed 20 MB at a trip boundary and otherwise wiped whole by Settings →
 *    Clear, meant the drive a report was actually about had already been
 *    overwritten by the drive that followed it. Trips are now separate files
 *    kept under a retention budget, so yesterday's drive survives today's.
 *  - **A trip is finished when the traveller says it is.** Pressing End short
 *    of the destination is the ordinary way a *diagnostically interesting*
 *    drive ends, so a partial trip is closed, summarised and (with auto-upload
 *    on) sent exactly like a completed one.
 *  - **Uploading can be automatic, and is still a decision.** The file holds
 *    exact positions, so it leaves the phone only on an explicit press or
 *    while the auto-upload preference — off by default, and synced with the
 *    account like the recording switch — is on. A trip that could not be
 *    uploaded (offline, server down) stays pending and is retried at the next
 *    trip end or app start rather than being lost.
 */

import { booleanSetting } from '@atlas/core';
import type { NavDiagnosticRecord, NavDiagnosticsSink, NavTripOutcome } from '@atlas/navigation';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import appJson from '../../app.json';
import { getServerOrigin } from '../serverOrigin';

/** Synced preference: whether trips are recorded at all. */
export const NAV_DIAGNOSTICS_SETTING = booleanSetting({
  key: 'navigation.diagnostics.enabled',
  scope: 'synced',
  defaultValue: false,
});

/**
 * Synced preference: send each finished trip to Atlas by itself.
 *
 * Off by default and deliberately separate from recording — a log kept for the
 * driver's own Share button is a different decision from one that leaves the
 * phone unattended.
 */
export const NAV_DIAGNOSTICS_AUTO_UPLOAD_SETTING = booleanSetting({
  key: 'navigation.diagnostics.autoUpload',
  scope: 'synced',
  defaultValue: false,
});

const BASE = FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? '';
const DIR = `${BASE}navigation-diagnostics/`;
const INDEX_URI = `${DIR}index.json`;
/** The old single-file log, migrated (as one trip) on first use of this build. */
const LEGACY_LOG_URI = `${BASE}navigation-diagnostics.jsonl`;

/**
 * The backend refuses a body over 20 MB, so a trip stops growing short of it —
 * the margin covers the difference between the characters counted here and the
 * UTF-8 bytes actually posted.
 */
const MAX_TRIP_BYTES = 18 * 1024 * 1024;
/**
 * Below this a trip has nothing to diagnose: a preview the traveller backed
 * out of, or the recording switch flipped while idle. Deliberately a size and
 * not a sample count, because the defensive closes (recording turned off
 * mid-drive, a trip that never wrote `trip-end`) have no summary to consult
 * and must never throw away a real drive.
 */
const MIN_KEEP_BYTES = 8 * 1024;
/** How many finished trips to keep, and the total they may occupy. */
const MAX_TRIPS = 25;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;

const APP_VERSION = appJson.expo.version;
const RUNTIME_VERSION = appJson.expo.runtimeVersion;

/** What Settings lists, and what retention and auto-upload act on. */
export interface NavDiagnosticTrip {
  id: string;
  file: string;
  startedAt: string;
  endedAt: string | null;
  outcome: NavTripOutcome | null;
  activity: string | null;
  profile: string | null;
  destination: [number, number] | null;
  distanceM: number;
  durationMs: number;
  routeChanges: number;
  bytes: number;
  /** Support reference returned by the server, once this trip has been sent. */
  uploaded: string | null;
  /** Why the last upload attempt failed, so a pending trip explains itself. */
  uploadError: string | null;
  /**
   * The server refused this file in a way a resend cannot change (too large,
   * not a log it accepts), so the automatic flush skips it. Upload still works
   * by hand. Absent on index entries written before the field existed.
   */
  rejected?: boolean;
}

let enabled = false;
let autoUpload = false;
/**
 * The automatic flush, single-flighted, and the trips it is currently sending.
 *
 * Closing a trip starts a flush and Settings (or the preference switch) can
 * start another in the same tick; without these two guards the same file was
 * posted twice, because `uploaded` is only stamped once the first POST returns.
 */
let flushInFlight: Promise<number> | null = null;
const uploading = new Set<string>();
let writeQueue: Promise<void> = Promise.resolve();
/** The trip currently being appended to, if any. */
let open: { trip: NavDiagnosticTrip; truncated: boolean } | null = null;
/** The index, once read; `null` until the first access reconciles it with disk. */
let index: NavDiagnosticTrip[] | null = null;

/**
 * Records that arrived before any file was open.
 *
 * The trip's first records (`trip-start`, the origin fix) can be emitted
 * before React has run the effect that opens anything, so a small buffer keeps
 * them rather than dropping the very lines that say what the trip was. Bounded
 * both ways: a fixed count, and an age, so an idle app cannot accumulate a
 * backlog that later lands in an unrelated trip.
 */
const PENDING_LIMIT = 200;
const PENDING_MAX_AGE_MS = 120_000;
let pendingLines: { atMs: number; line: string }[] = [];

function queue(operation: () => Promise<void>): Promise<void> {
  const next = writeQueue.catch(() => undefined).then(operation);
  writeQueue = next.catch(() => undefined);
  return next;
}

/** Everything the write path swallows: a log is never a navigation failure. */
async function quietly<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}

function stamp(record: NavDiagnosticRecord): string {
  return `${JSON.stringify({
    at: new Date().toISOString(),
    appVersion: APP_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    ...record,
  })}\n`;
}

function fileTimestamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function readIndex(): Promise<NavDiagnosticTrip[]> {
  if (index !== null) return index;
  await quietly(() => FileSystem.makeDirectoryAsync(DIR, { intermediates: true }));
  const stored = await quietly(async () => {
    const raw = await FileSystem.readAsStringAsync(INDEX_URI);
    const parsed: unknown = JSON.parse(raw);
    const trips = (parsed as { trips?: unknown } | null)?.trips;
    return Array.isArray(trips) ? (trips as NavDiagnosticTrip[]) : [];
  });
  const names = (await quietly(() => FileSystem.readDirectoryAsync(DIR))) ?? [];
  const present = new Set(names.filter((name) => name.endsWith('.jsonl')));
  const reconciled: NavDiagnosticTrip[] = [];
  const abandoned: NavDiagnosticTrip[] = [];
  for (const trip of stored ?? []) {
    if (!trip || typeof trip.file !== 'string' || !present.has(trip.file)) continue;
    present.delete(trip.file);
    if (trip.endedAt !== null) {
      reconciled.push(trip);
      continue;
    }
    // A trip with no end never got one, because the process died inside it —
    // or because it is the stub that turning recording on opens so that a
    // switch flipped mid-drive still records the rest of that drive. Size
    // separates them, and it matters both ways: a stub left in the list would
    // eat a retention slot per launch and quietly evict the drives this exists
    // to keep, while a real interrupted trip is exactly the log a crash report
    // needs. The size has to come from the file — the index entry was written
    // when the trip opened and the writes that followed never got to update it,
    // which is what "the process died" means.
    const info = await quietly(() => FileSystem.getInfoAsync(`${DIR}${trip.file}`));
    const bytes = info?.exists && typeof info.size === 'number' ? info.size : 0;
    const interrupted = {
      ...trip,
      bytes,
      endedAt: trip.startedAt,
      outcome: 'interrupted' as const,
    };
    (bytes >= MIN_KEEP_BYTES ? reconciled : abandoned).push(interrupted);
  }
  // Files the index has never heard of (an index write lost to a kill) are
  // kept rather than orphaned — the recording is the valuable half.
  for (const file of present) reconciled.push(adoptOrphan(file));
  reconciled.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  index = reconciled;
  for (const trip of abandoned) {
    await quietly(() => FileSystem.deleteAsync(`${DIR}${trip.file}`, { idempotent: true }));
  }
  await migrateLegacyLog();
  return reconciled;
}

function adoptOrphan(file: string): NavDiagnosticTrip {
  const match = /^nav-(\d{8}T\d{6}Z)-([0-9a-z-]+)\.jsonl$/.exec(file);
  const iso = match
    ? `${match[1]!.slice(0, 4)}-${match[1]!.slice(4, 6)}-${match[1]!.slice(6, 11)}:${match[1]!.slice(11, 13)}:${match[1]!.slice(13, 15)}.000Z`
    : new Date(0).toISOString();
  return {
    id: match?.[2] ?? file.replace(/\.jsonl$/, ''),
    file,
    startedAt: iso,
    endedAt: iso,
    outcome: 'interrupted',
    activity: null,
    profile: null,
    destination: null,
    distanceM: 0,
    durationMs: 0,
    routeChanges: 0,
    bytes: 0,
    uploaded: null,
    uploadError: null,
  };
}

/** Carry the pre-v0.203.0 single log across as one interrupted trip. */
async function migrateLegacyLog(): Promise<void> {
  const info = await quietly(() => FileSystem.getInfoAsync(LEGACY_LOG_URI));
  if (!info?.exists) return;
  const startedAt = new Date(
    typeof info.modificationTime === 'number' ? info.modificationTime * 1000 : Date.now(),
  ).toISOString();
  const file = `nav-${fileTimestamp(startedAt)}-legacy.jsonl`;
  const moved = await quietly(() =>
    FileSystem.moveAsync({ from: LEGACY_LOG_URI, to: `${DIR}${file}` }),
  );
  if (moved === null && (await quietly(() => FileSystem.getInfoAsync(LEGACY_LOG_URI)))?.exists) {
    return;
  }
  (index ??= []).push({
    ...adoptOrphan(file),
    startedAt,
    endedAt: startedAt,
    bytes: typeof info.size === 'number' ? info.size : 0,
  });
  await writeIndex();
}

async function writeIndex(): Promise<void> {
  await quietly(() =>
    FileSystem.writeAsStringAsync(INDEX_URI, JSON.stringify({ version: 1, trips: index ?? [] })),
  );
}

async function append(uri: string, line: string): Promise<void> {
  await quietly(() => FileSystem.writeAsStringAsync(uri, line, { append: true }));
}

/** Write one line into the open trip, honouring the per-trip size cap. */
async function appendToOpenTrip(line: string, force = false): Promise<void> {
  const current = open;
  if (!current) {
    const atMs = Date.now();
    pendingLines.push({ atMs, line });
    if (pendingLines.length > PENDING_LIMIT) pendingLines = pendingLines.slice(-PENDING_LIMIT);
    return;
  }
  if (current.truncated && !force) return;
  await append(`${DIR}${current.trip.file}`, line);
  current.trip.bytes += line.length;
  if (!current.truncated && current.trip.bytes >= MAX_TRIP_BYTES) {
    current.truncated = true;
    await append(
      `${DIR}${current.trip.file}`,
      stamp({ event: 'log-truncated', bytes: current.trip.bytes }),
    );
  }
}

/** Open a file for a beginning trip; anything still open is closed first. */
async function openTrip(record: NavDiagnosticRecord): Promise<void> {
  await closeTrip('ended-early');
  const trips = await readIndex();
  const startedAt = typeof record.at === 'string' ? record.at : new Date().toISOString();
  const id =
    typeof record.trip === 'string' && record.trip.length > 0
      ? record.trip
      : `${Date.now().toString(36)}`;
  const destination = Array.isArray(record.destination)
    ? (record.destination as [number, number])
    : null;
  const trip: NavDiagnosticTrip = {
    id,
    file: `nav-${fileTimestamp(startedAt)}-${id}.jsonl`,
    startedAt,
    endedAt: null,
    outcome: null,
    activity: typeof record.activity === 'string' ? record.activity : null,
    profile: typeof record.profile === 'string' ? record.profile : null,
    destination,
    distanceM: 0,
    durationMs: 0,
    routeChanges: 0,
    bytes: 0,
    uploaded: null,
    uploadError: null,
  };
  open = { trip, truncated: false };
  trips.push(trip);
  await appendToOpenTrip(stamp(record));
  // Whatever arrived while nothing was open belongs to this trip: the origin
  // fix and the first route request routinely beat the file into existence.
  const cutoff = Date.now() - PENDING_MAX_AGE_MS;
  const carried = pendingLines.filter((entry) => entry.atMs >= cutoff);
  pendingLines = [];
  for (const entry of carried) await appendToOpenTrip(entry.line);
  await writeIndex();
}

/**
 * Close the open trip: stamp the summary onto its index entry, prune, and —
 * with auto-upload on — send it and every earlier trip still pending.
 */
async function closeTrip(
  outcome: NavTripOutcome,
  record?: NavDiagnosticRecord,
): Promise<NavDiagnosticTrip | null> {
  const current = open;
  if (!current) return null;
  open = null;
  const { trip } = current;
  if (record) await append(`${DIR}${trip.file}`, stamp(record));
  trip.endedAt = new Date().toISOString();
  trip.outcome = outcome;
  const report = (record?.report ?? null) as Record<string, unknown> | null;
  if (report) {
    trip.distanceM = typeof report.distanceM === 'number' ? report.distanceM : 0;
    trip.durationMs = typeof report.durationMs === 'number' ? report.durationMs : 0;
    trip.routeChanges = typeof report.routeChanges === 'number' ? report.routeChanges : 0;
  }
  const info = await quietly(() => FileSystem.getInfoAsync(`${DIR}${trip.file}`));
  if (info?.exists && typeof info.size === 'number') trip.bytes = info.size;

  // A trip too small to hold a drive diagnoses nothing. A *failed* setup is
  // the exception: "it would not start" is exactly the report worth keeping.
  if (trip.bytes < MIN_KEEP_BYTES && outcome !== 'failed') {
    await discard(trip);
    return null;
  }
  await prune();
  await writeIndex();
  if (autoUpload) void flushNavigationDiagnosticUploads();
  return trip;
}

async function discard(trip: NavDiagnosticTrip): Promise<void> {
  await quietly(() => FileSystem.deleteAsync(`${DIR}${trip.file}`, { idempotent: true }));
  index = (index ?? []).filter((entry) => entry !== trip);
}

/** Oldest first, past either cap. The open trip is never a candidate. */
async function prune(): Promise<void> {
  const trips = (index ?? []).slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  let total = trips.reduce((sum, trip) => sum + trip.bytes, 0);
  let count = trips.length;
  for (const trip of trips) {
    if (count <= MAX_TRIPS && total <= MAX_TOTAL_BYTES) break;
    if (open?.trip === trip) continue;
    await discard(trip);
    total -= trip.bytes;
    count--;
  }
}

/** Turn capture on/off immediately; persistence of the choice is the hook's. */
export function configureNavigationDiagnostics(on: boolean, account: string | null): void {
  if (enabled === on) return;
  enabled = on;
  if (!on) {
    // Record the boundary, then close the tap — a half-written trip that is
    // never closed would come back as "interrupted" and mislead a reader.
    void queue(async () => {
      await appendToOpenTrip(stamp({ event: 'diagnostics-disabled', account }), true);
      await closeTrip('ended-early');
    });
    return;
  }
  // Enabling mid-drive opens a file at once rather than waiting for the next
  // trip: the drive being recorded is usually the one that just went wrong.
  void queue(() =>
    openTrip({ event: 'diagnostics-enabled', account, at: new Date().toISOString() }),
  );
}

/** Follow the auto-upload preference; flushing anything already pending. */
export function configureNavigationDiagnosticsAutoUpload(on: boolean): void {
  autoUpload = on;
  if (on) void flushNavigationDiagnosticUploads();
}

/** Append one record. Failures are deliberately isolated from navigation itself. */
export function logNavigationDiagnostic(record: NavDiagnosticRecord): Promise<void> {
  if (!enabled) return Promise.resolve();
  return queue(() => appendToOpenTrip(stamp(record)));
}

/**
 * The sink handed to the navigation controller: the same append for ordinary
 * records, with the trip brackets turned into files.
 */
export const navigationDiagnosticsSink: NavDiagnosticsSink = (record) => {
  if (!enabled) return;
  if (record.event === 'trip-start') {
    void queue(() => openTrip({ ...record, at: new Date().toISOString() }));
    return;
  }
  if (record.event === 'trip-end') {
    const outcome = (record.outcome as NavTripOutcome | undefined) ?? 'ended-early';
    void queue(async () => {
      await closeTrip(outcome, record);
    });
    return;
  }
  void logNavigationDiagnostic(record);
};

/**
 * "Look at this bit." Every report used to start as "somewhere before Bærum
 * sykehus"; a marker turns that into a timestamp the analyser prints by name.
 */
export function markNavigationDiagnostic(note?: string): Promise<void> {
  return logNavigationDiagnostic({ event: 'user-marker', ...(note ? { note } : {}) });
}

/** The trips on this device, newest first. */
export async function listNavigationDiagnosticTrips(): Promise<NavDiagnosticTrip[]> {
  await writeQueue.catch(() => undefined);
  const trips = await readIndex();
  return trips
    .filter(
      // Hide the still-open stub until it holds an actual drive. The file that
      // turning recording on opens is real and useful — it is what catches a
      // switch flipped mid-drive — but until something is recorded into it,
      // listing it would offer the traveller a trip that is not one.
      (trip) => trip.endedAt !== null || trip.bytes >= MIN_KEEP_BYTES,
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function navigationDiagnosticSize(): Promise<number> {
  const trips = await listNavigationDiagnosticTrips();
  return trips.reduce((sum, trip) => sum + trip.bytes, 0);
}

async function tripById(id: string): Promise<NavDiagnosticTrip | null> {
  const trips = await listNavigationDiagnosticTrips();
  return trips.find((trip) => trip.id === id) ?? null;
}

export async function shareNavigationDiagnosticTrip(id: string): Promise<boolean> {
  const trip = await tripById(id);
  if (!trip || !(await Sharing.isAvailableAsync())) return false;
  const uri = `${DIR}${trip.file}`;
  if (!(await quietly(() => FileSystem.getInfoAsync(uri)))?.exists) return false;
  await Sharing.shareAsync(uri, {
    mimeType: 'application/x-ndjson',
    dialogTitle: 'Share Atlas navigation diagnostics',
  });
  return true;
}

/**
 * Send one trip. The reference the server hands back is the whole point: it is
 * what a support conversation quotes, and it is stored on the trip so the same
 * file is never uploaded twice by the automatic flush.
 */
export async function uploadNavigationDiagnosticTrip(id: string): Promise<string> {
  const trip = await tripById(id);
  if (!trip) throw new Error('That trip is no longer on this device.');
  if (trip.uploaded !== null) return trip.uploaded;
  if (uploading.has(id)) throw new Error('That trip is already uploading.');
  uploading.add(id);
  try {
    return await postTrip(trip);
  } finally {
    uploading.delete(id);
  }
}

/**
 * An upload that failed for a reason the next attempt may not have — offline,
 * server down, rate-limited. Only this ends an automatic flush.
 */
class UploadDeferred extends Error {}

async function postTrip(trip: NavDiagnosticTrip): Promise<string> {
  const raw = await FileSystem.readAsStringAsync(`${DIR}${trip.file}`).catch(() => '');
  // A process killed mid-append can leave half a record as the last line, and
  // the server refuses a log with any line it cannot parse — which would cost
  // exactly the trip a crash report is about.
  const body = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
  if (!body.trim()) {
    trip.uploadError = 'That trip recorded nothing to upload.';
    trip.rejected = true;
    await writeIndex();
    throw new Error(trip.uploadError);
  }
  let response: Response;
  try {
    response = await fetch(`${getServerOrigin()}/api/diagnostics/navigation`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-atlas-version': APP_VERSION,
        'x-atlas-runtime': RUNTIME_VERSION,
        'x-atlas-trip': trip.id,
      },
      body,
    });
  } catch (error) {
    trip.uploadError = error instanceof Error ? error.message : 'Upload failed.';
    await writeIndex();
    throw new UploadDeferred(trip.uploadError);
  }
  const result = (await response.json().catch(() => null)) as {
    reference?: string;
    error?: string;
  } | null;
  if (!response.ok || !result?.reference) {
    trip.uploadError = result?.error ?? `Upload failed (${response.status}).`;
    // A 4xx other than timeout or rate limit answers the same bytes the same
    // way however often they are sent.
    const status = response.status;
    trip.rejected = status >= 400 && status < 500 && status !== 408 && status !== 429;
    await writeIndex();
    throw trip.rejected ? new Error(trip.uploadError) : new UploadDeferred(trip.uploadError);
  }
  trip.uploaded = result.reference;
  trip.uploadError = null;
  trip.rejected = false;
  await writeIndex();
  return result.reference;
}

/**
 * Upload every finished trip that has not been sent yet.
 *
 * This is what makes auto-upload survive a drive that ended out of coverage:
 * the trip stays pending and the next trip end — or the next app start — sends
 * it. Never uploads the trip currently being written.
 */
export function flushNavigationDiagnosticUploads(): Promise<number> {
  if (!autoUpload) return Promise.resolve(0);
  // Chained rather than deduplicated: a flush asked for *after* one started
  // may have a trip that one never saw — closing a trip is exactly that case —
  // so it waits its turn instead of being answered by the earlier run.
  const run = (flushInFlight ?? Promise.resolve(0)).catch(() => 0).then(() => runFlush());
  flushInFlight = run;
  void run
    .catch(() => 0)
    .then(() => {
      if (flushInFlight === run) flushInFlight = null;
    });
  return run;
}

async function runFlush(): Promise<number> {
  const trips = await listNavigationDiagnosticTrips();
  let sent = 0;
  for (const trip of trips) {
    if (trip.uploaded !== null || trip.rejected || trip.endedAt === null || open?.trip === trip) {
      continue;
    }
    try {
      await uploadNavigationDiagnosticTrip(trip.id);
      sent++;
    } catch (error) {
      // Offline or the server is down: it stays pending, and the next flush
      // (trip end, app start, toggling the preference) tries again. Any other
      // failure belongs to this trip alone — stopping on it would hold back
      // every trip recorded after it, on every flush, for good.
      if (error instanceof UploadDeferred) break;
    }
  }
  return sent;
}

export async function deleteNavigationDiagnosticTrip(id: string): Promise<void> {
  await writeQueue.catch(() => undefined);
  const trip = await tripById(id);
  if (!trip) return;
  if (open?.trip === trip) open = null;
  await discard(trip);
  await writeIndex();
}

export async function clearNavigationDiagnostics(): Promise<void> {
  await queue(async () => {
    open = null;
    pendingLines = [];
    await quietly(() => FileSystem.deleteAsync(DIR, { idempotent: true }));
    index = [];
    await quietly(() => FileSystem.makeDirectoryAsync(DIR, { intermediates: true }));
    await writeIndex();
  });
}

/** Test/support seam: production callers should use the persisted preference hook. */
export function navigationDiagnosticsEnabled(): boolean {
  return enabled;
}
