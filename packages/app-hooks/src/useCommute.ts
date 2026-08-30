import { TransitError } from '@atlas/transit';
import type {
  CommuteEmptyReason,
  TransitWidgetV2Commit,
  TransitCommuteDirection,
  TransitCommutePlace,
  TransitCommuteQuery,
  TransitCommuteResult,
  TransitCommuteTime,
  TransitLineRef,
  TransitMode,
  TransitWeekday,
} from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The saved commute: one synced setting, read by the web board, the Android
 * board and the home-screen widget, so those three cannot disagree.
 *
 * What changed in the rework, and why it had to:
 *  - **Ends are stops, not favorites.** The previous config held three
 *    `PlaceRecord` ids, so every commute was planned by walking from a house
 *    coordinate — on the one transit surface in Atlas that could not name a
 *    stop, added in the release straight after stop search shipped.
 *  - **Lines are picked, not typed.** `allowedBusLines: ['280','71']` matched
 *    `publicCode`, which is ambiguous nationally (three lines answer to "280"),
 *    unvalidatable and silently wrong. Lines now carry their Entur ids.
 *  - **No defaults belong to a person.** The old `EMPTY_CONFIG` shipped one
 *    developer's bus lines and excluded stop in a shared package, and
 *    `defaultCommuteConfig` grepped every user's favorites for "engelsrud".
 *    A first-run commute is empty, and its first screen is the picker.
 */

export const COMMUTE_SETTING_KEY = 'transit.commute';

/**
 * Where the board keeps the journey it is tracking — §6.4 §7's one decision.
 *
 * `local.` is load-bearing, not a naming habit: settings under that prefix
 * never sync (see the storage package's outbox rules), and "the journey I am on
 * right now" is the least portable fact this app holds. Syncing it would put a
 * laptop's board on a bus it is not on, and hand the tablet at home a
 * commitment that expires while nobody is looking at it.
 *
 * The value is a {@link TransitWidgetV2Commit} — the *same* shape the
 * home-screen widget stores per instance, so a tap in the app and a tap on the
 * widget mean one thing. Two stores with no shared shape between them is how
 * "the journey I'm on" grows a second definition.
 */
export const COMMUTE_COMMIT_SETTING_KEY = 'local.transit.commit';

/** Read a stored commitment, ignoring anything that is not one. */
export function parseCommuteCommit(value: string | null): TransitWidgetV2Commit | null {
  if (!value) return null;
  try {
    const raw: unknown = JSON.parse(value);
    if (!isRecord(raw)) return null;
    const direction = raw.direction === 'inbound' ? 'inbound' : 'outbound';
    const departureMs = raw.departureMs;
    const line = raw.line;
    if (typeof departureMs !== 'number' || !Number.isFinite(departureMs)) return null;
    if (typeof line !== 'string') return null;
    return {
      direction,
      departureMs,
      line,
      ...(typeof raw.committedAtMs === 'number' ? { committedAtMs: raw.committedAtMs } : {}),
    };
  } catch {
    return null;
  }
}

/** The shape written today. Bumped when a migration has to tell versions apart. */
const CONFIG_VERSION = 2;

/**
 * One end of the commute. Coordinates and a stop id are stored *and* a favorite
 * reference is kept when the user picked one, so a renamed or moved favorite
 * follows the board while a stop picked from search needs no favorite at all.
 */
export interface CommuteEnd {
  name: string;
  position?: { lat: number; lng: number };
  /** NSR StopPlace id — present whenever the user actually picked a stop. */
  stopId?: string;
  /** Saved place this end came from; its current name and position win. */
  placeId?: string;
}

export interface CommuteConfig {
  from: CommuteEnd | null;
  via: CommuteEnd | null;
  to: CommuteEnd | null;
  /** Lines the journey must use; empty means any line. */
  select: TransitLineRef[];
  /** Lines it must not use. */
  exclude: TransitLineRef[];
  /** Ride modes accepted; empty means all of them. */
  modes: TransitMode[];
  outboundTime: TransitCommuteTime;
  inboundTime: TransitCommuteTime;
  days: TransitWeekday[];
}

export const EMPTY_COMMUTE_CONFIG: CommuteConfig = {
  from: null,
  via: null,
  to: null,
  select: [],
  exclude: [],
  modes: [],
  outboundTime: { minutesOfDay: null, arriveBy: false },
  inboundTime: { minutesOfDay: null, arriveBy: false },
  days: [],
};

export interface CommuteSettings {
  status: 'loading' | 'ready' | 'error';
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export type CommuteFn = (
  query: TransitCommuteQuery,
  signal: AbortSignal,
  /** The journey being tracked, so the answer carries it once it has left. */
  commit: TransitWidgetV2Commit | null,
) => Promise<TransitCommuteResult>;

export interface CommuteController {
  /** Saved configuration has finished loading and controls may safely write. */
  ready: boolean;
  config: CommuteConfig;
  setConfig: (config: CommuteConfig) => void;
  query: TransitCommuteQuery | null;
  result: TransitCommuteResult | null;
  loading: boolean;
  error: string | null;
  updatedMs: number | null;
  refresh: () => void;
  /** Why a direction is empty, so a board can offer the way out of its own filter. */
  emptyReason: (direction: TransitCommuteDirection) => CommuteEmptyReason;
  /** The journey the board is tracking (§6.4 §7), or null. */
  commit: TransitWidgetV2Commit | null;
  /**
   * Start or stop tracking a journey. Writing it re-asks the board, which is
   * the point: the tracked journey has to come back even once it has left.
   */
  setCommit: (commit: TransitWidgetV2Commit | null) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object';

const trimmed = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() && value.trim().length <= max
    ? value.trim()
    : undefined;

function parseEnd(value: unknown): CommuteEnd | null {
  if (!isRecord(value)) return null;
  const name = trimmed(value.name, 100);
  const position = isRecord(value.position) ? value.position : null;
  const lat = position?.lat;
  const lng = position?.lng;
  const hasPosition = typeof lat === 'number' && typeof lng === 'number';
  const placeId = trimmed(value.placeId, 100);
  // An end with neither coordinates nor a favorite to resolve is not an end.
  if (!hasPosition && !placeId) return null;
  return {
    name: name ?? '',
    ...(hasPosition ? { position: { lat, lng } } : {}),
    ...(trimmed(value.stopId, 128) ? { stopId: trimmed(value.stopId, 128)! } : {}),
    ...(placeId ? { placeId } : {}),
  };
}

function parseLineRefs(value: unknown): TransitLineRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = trimmed(item.id, 128);
    if (!id) return [];
    return [
      {
        id,
        publicCode: trimmed(item.publicCode, 24) ?? id,
        mode: (trimmed(item.mode, 20) ?? 'unknown') as TransitMode,
        ...(trimmed(item.name, 120) ? { name: trimmed(item.name, 120)! } : {}),
        ...(trimmed(item.operator, 60) ? { operator: trimmed(item.operator, 60)! } : {}),
        ...(trimmed(item.towards, 60) ? { towards: trimmed(item.towards, 60)! } : {}),
      },
    ];
  });
}

function parseTime(value: unknown): TransitCommuteTime {
  const raw = isRecord(value) ? value : {};
  const minutes = raw.minutesOfDay;
  const valid =
    typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0 && minutes < 24 * 60;
  return { minutesOfDay: valid ? Math.trunc(minutes) : null, arriveBy: raw.arriveBy === true };
}

/**
 * Read the saved setting, migrating the pre-rework shape on the way through.
 *
 * The migration is deliberately lossy in one place: `allowedBusLines` held
 * public codes, and a code cannot be turned into a line id without asking Entur
 * which of the three lines answering to "280" was meant. So the ends survive
 * (as favorite references, exactly what they were) and the line rules do not —
 * the board opens on its picker with the corridor already filled in, which is
 * one tap of honest work instead of a filter nobody can audit.
 *
 * Idempotent by construction: a v2 payload is parsed, never re-migrated, and
 * writing v2 back drops the old fields rather than carrying them along. An older
 * client reading the new value sees an unconfigured commute — honest, and it is
 * about to be updated anyway — rather than someone else's bus lines.
 */
export function parseCommuteConfig(value: string | null): CommuteConfig | null {
  if (!value) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.version === CONFIG_VERSION || raw.from !== undefined || raw.to !== undefined) {
    return {
      from: parseEnd(raw.from),
      via: parseEnd(raw.via),
      to: parseEnd(raw.to),
      select: parseLineRefs(raw.select),
      exclude: parseLineRefs(raw.exclude),
      modes: Array.isArray(raw.modes)
        ? raw.modes.filter((mode): mode is TransitMode => typeof mode === 'string')
        : [],
      outboundTime: parseTime(raw.outboundTime),
      inboundTime: parseTime(raw.inboundTime),
      days: Array.isArray(raw.days)
        ? [
            ...new Set(
              raw.days.filter(
                (day): day is TransitWeekday =>
                  typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 7,
              ),
            ),
          ].sort((a, b) => a - b)
        : [],
    };
  }
  // v1: three favorite ids plus two lists of hand-typed text.
  const favorite = (id: unknown): CommuteEnd | null => {
    const placeId = trimmed(id, 100);
    return placeId ? { name: '', placeId } : null;
  };
  return {
    ...EMPTY_COMMUTE_CONFIG,
    from: favorite(raw.fromId),
    via: favorite(raw.viaId),
    to: favorite(raw.toId),
  };
}

/** Whether a parsed config still needs writing back in the current shape. */
export function isLegacyCommuteSetting(value: string | null): boolean {
  if (!value) return false;
  try {
    const raw: unknown = JSON.parse(value);
    return isRecord(raw) && raw.version !== CONFIG_VERSION;
  } catch {
    return false;
  }
}

export function serializeCommuteConfig(config: CommuteConfig): string {
  return JSON.stringify({ version: CONFIG_VERSION, ...config });
}

/** Resolve one end against the current favorites, preferring live place data. */
function resolveEnd(
  end: CommuteEnd | null,
  byId: Map<string, PlaceRecord>,
): TransitCommutePlace | null {
  if (!end) return null;
  const place = end.placeId ? byId.get(end.placeId) : undefined;
  const position = place ? { lat: place.lat, lng: place.lng } : end.position;
  if (!position) return null;
  const name = place?.name ?? end.name;
  return {
    name: name || 'Stop',
    lat: position.lat,
    lng: position.lng,
    ...(end.stopId ? { stopId: end.stopId } : {}),
  };
}

/**
 * The query a configuration means, or null when it is not askable yet.
 *
 * Note what is *not* required any more: the old build refused to ask unless at
 * least one bus line had been typed, which is why a fresh install saw nothing
 * but a hint. An unfiltered commute is a perfectly good question — it is also
 * the one whose answer becomes the line picker's shortlist.
 */
export function commuteQueryFrom(
  config: CommuteConfig,
  places: readonly PlaceRecord[],
): TransitCommuteQuery | null {
  const byId = new Map(places.map((place) => [place.id, place]));
  const from = resolveEnd(config.from, byId);
  const to = resolveEnd(config.to, byId);
  const via = resolveEnd(config.via, byId);
  if (!from || !to) return null;
  const samePlace = (a: TransitCommutePlace, b: TransitCommutePlace) =>
    (a.stopId && b.stopId && a.stopId === b.stopId) || (a.lat === b.lat && a.lng === b.lng);
  if (samePlace(from, to)) return null;
  return {
    from,
    via: via && !samePlace(via, from) && !samePlace(via, to) ? [via] : [],
    to,
    filter: { select: config.select, exclude: config.exclude, modes: config.modes },
    outboundTime: config.outboundTime,
    inboundTime: config.inboundTime,
    days: config.days,
    limit: 6,
  };
}

/** Saved commute state shared by the web board, Android board and widget bridge. */
export function useCommute(
  settings: CommuteSettings,
  places: readonly PlaceRecord[],
  fetchCommute: CommuteFn,
  active: boolean,
): CommuteController {
  const { status, getSetting, setSetting: saveSetting } = settings;
  const [config, setConfigState] = useState<CommuteConfig>(EMPTY_COMMUTE_CONFIG);
  const [loaded, setLoaded] = useState(false);
  const [result, setResult] = useState<TransitCommuteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedMs, setUpdatedMs] = useState<number | null>(null);
  const [seed, setSeed] = useState(0);
  const [commit, setCommitState] = useState<TransitWidgetV2Commit | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (status !== 'ready' || loaded) return;
    let current = true;
    void getSetting(COMMUTE_SETTING_KEY).then((saved) => {
      if (!current) return;
      const next = parseCommuteConfig(saved) ?? EMPTY_COMMUTE_CONFIG;
      setConfigState(next);
      // Write back only to finish a migration. A first run writes nothing: an
      // empty commute is not worth a synced row on every device.
      if (saved && isLegacyCommuteSetting(saved)) {
        saveSetting(COMMUTE_SETTING_KEY, serializeCommuteConfig(next));
      }
      setLoaded(true);
    });
    void getSetting(COMMUTE_COMMIT_SETTING_KEY).then((saved) => {
      if (current) setCommitState(parseCommuteCommit(saved));
    });
    return () => {
      current = false;
    };
  }, [getSetting, loaded, saveSetting, status]);

  const query = useMemo(() => commuteQueryFrom(config, places), [config, places]);
  const queryKey = query ? JSON.stringify(query) : '';
  const commitKey = commit ? `${commit.direction}:${commit.departureMs}:${commit.line}` : '';

  useEffect(() => {
    abortRef.current?.abort();
    if (!active || !loaded || !query) {
      setResult(null);
      setLoading(false);
      setError(null);
      setUpdatedMs(null);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const next = await fetchCommute(query, controller.signal, commit);
        if (controller.signal.aborted) return;
        setResult(next);
        setError(null);
        setUpdatedMs(Date.now());
      } catch (err) {
        if (controller.signal.aborted) return;
        setResult(null);
        setUpdatedMs(null);
        setError(
          err instanceof TransitError
            ? err.message
            : 'Commute board unavailable — check your connection.',
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // query enters through its stable serialized value; callers rebuild it.
    // `commitKey` rather than `commit`: a re-read of the same commitment must
    // not re-ask the board, or every answer would trigger the next request.
  }, [active, commitKey, fetchCommute, loaded, queryKey, seed]);

  const setConfig = useCallback(
    (next: CommuteConfig) => {
      setConfigState(next);
      saveSetting(COMMUTE_SETTING_KEY, serializeCommuteConfig(next));
    },
    [saveSetting],
  );
  const setCommit = useCallback(
    (next: TransitWidgetV2Commit | null) => {
      setCommitState(next);
      // Written even when clearing, so a board reopened later starts untracked
      // rather than re-reading a commitment the user let go of.
      saveSetting(COMMUTE_COMMIT_SETTING_KEY, next ? JSON.stringify(next) : '');
    },
    [saveSetting],
  );
  const refresh = useCallback(() => setSeed((value) => value + 1), []);
  const emptyReason = useCallback(
    (direction: TransitCommuteDirection): CommuteEmptyReason => {
      if (!result) return 'none';
      if (result[direction].trips.length > 0) return 'none';
      return result.emptyReason?.[direction] ?? 'upstream';
    },
    [result],
  );

  return {
    ready: loaded,
    config,
    setConfig,
    query,
    result,
    loading,
    error,
    updatedMs,
    refresh,
    emptyReason,
    commit,
    setCommit,
  };
}
