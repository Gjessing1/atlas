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
import { defineSetting, jsonSetting, readSetting } from '@atlas/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SettingsAccess } from './usePersistedSetting.js';

/**
 * The saved commute library: one synced setting, read by the web board, the
 * Android board and the home-screen widget, so those three cannot disagree.
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

/** A deliberately small library: enough for home, work and recurring journeys without clutter. */
export const MAX_SAVED_COMMUTES = 8;

/**
 * Where the board keeps the journey it is tracking — TRANSIT.md §7's one decision.
 *
 * `local.` is load-bearing, not a naming habit: settings under that prefix
 * never sync (see the storage package's outbox rules), and "the journey I am on
 * right now" is the least portable fact this app holds. Syncing it would put a
 * laptop's board on a bus it is not on, and hand the tablet at home a
 * commitment that expires while nobody is looking at it.
 *
 * The nested value is a {@link TransitWidgetV2Commit} — the *same* shape the
 * home-screen widget stores per instance — plus the commute that owns it. That
 * identity prevents a tracked Work journey from appearing on Cabin merely
 * because the reader switched boards.
 */
interface StoredCommuteCommit {
  commuteId: string;
  commit: TransitWidgetV2Commit;
}

export const COMMUTE_COMMIT_SETTING = jsonSetting<StoredCommuteCommit | null>({
  key: 'local.transit.commit',
  scope: 'local',
  defaultValue: null,
  parse: (value) => {
    if (!isRecord(value)) return null;
    const candidate = isRecord(value.commit) ? value.commit : value;
    const direction = candidate.direction === 'inbound' ? 'inbound' : 'outbound';
    const departureMs = candidate.departureMs;
    const line = candidate.line;
    if (typeof departureMs !== 'number' || !Number.isFinite(departureMs)) return null;
    if (typeof line !== 'string') return null;
    return {
      // A legacy bare commitment is attached to the migrated commute after the
      // library is read. New values always carry the owning commute id.
      commuteId: trimmed(value.commuteId, 100) ?? '',
      commit: {
        direction,
        departureMs,
        line,
        ...(typeof candidate.committedAtMs === 'number'
          ? { committedAtMs: candidate.committedAtMs }
          : {}),
        ...(candidate.origin === 'interchange' ? { origin: 'interchange' as const } : {}),
      },
    };
  },
});

/** The key, for the callers (and the widget) that hold only a string. */
export const COMMUTE_COMMIT_SETTING_KEY = COMMUTE_COMMIT_SETTING.key;

/** Read a stored commitment, ignoring anything that is not one. */
export function parseCommuteCommit(value: string | null): TransitWidgetV2Commit | null {
  return readSetting(COMMUTE_COMMIT_SETTING, value)?.commit ?? null;
}

/** The individual commute shape; the enclosing library owns its own version. */
const CONFIG_VERSION = 2;
const LIBRARY_VERSION = 3;

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

export interface SavedCommute {
  id: string;
  name: string;
  config: CommuteConfig;
}

export interface CommuteLibrary {
  commutes: SavedCommute[];
  /** The board opened in Atlas. */
  activeId: string;
  /** The one commute copied into Android's home-screen widget stores. */
  widgetId: string;
}

export interface StaleCommuteEnd {
  commuteId: string;
  commuteName: string;
  end: 'from' | 'via' | 'to';
  placeId: string;
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

const DEFAULT_COMMUTE_ID = 'commute';

export const EMPTY_COMMUTE_LIBRARY: CommuteLibrary = {
  commutes: [{ id: DEFAULT_COMMUTE_ID, name: 'Commute', config: EMPTY_COMMUTE_CONFIG }],
  activeId: DEFAULT_COMMUTE_ID,
  widgetId: DEFAULT_COMMUTE_ID,
};

/** The shared settings seam (see `usePersistedSetting`). */
export type CommuteSettings = SettingsAccess;

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
  commutes: SavedCommute[];
  activeId: string;
  widgetCommuteId: string;
  widgetQuery: TransitCommuteQuery | null;
  selectCommute: (id: string) => void;
  addCommute: () => void;
  renameCommute: (id: string, name: string) => void;
  deleteCommute: (id: string) => void;
  setWidgetCommute: (id: string) => void;
  canAddCommute: boolean;
  /** Saved-place copies whose source place was deleted. */
  staleEnds: StaleCommuteEnd[];
  /** Commute names using each saved place, for Collections badges. */
  placeCommutes: ReadonlyMap<string, readonly string[]>;
  query: TransitCommuteQuery | null;
  result: TransitCommuteResult | null;
  loading: boolean;
  error: string | null;
  updatedMs: number | null;
  refresh: () => void;
  /** Why a direction is empty, so a board can offer the way out of its own filter. */
  emptyReason: (direction: TransitCommuteDirection) => CommuteEmptyReason;
  /** The journey the board is tracking (TRANSIT.md §7), or null. */
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
  try {
    return parseCommuteValue(JSON.parse(value));
  } catch {
    return null;
  }
}

/** The migration itself, over already-parsed JSON — see {@link parseCommuteConfig}. */
function parseCommuteValue(raw: unknown): CommuteConfig | null {
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

function parseSavedCommute(value: unknown): SavedCommute | null {
  if (!isRecord(value)) return null;
  const id = trimmed(value.id, 100);
  const name = trimmed(value.name, 80);
  const config = parseCommuteValue(value.config);
  if (!id || !name || !config) return null;
  return { id, name, config };
}

/** Read today's named-list shape, or migrate the former single commute into it. */
export function parseCommuteLibrary(value: string | null): CommuteLibrary | null {
  if (!value) return null;
  try {
    const raw: unknown = JSON.parse(value);
    if (!isRecord(raw)) return null;
    if (raw.version === LIBRARY_VERSION && Array.isArray(raw.commutes)) {
      const seen = new Set<string>();
      const commutes = raw.commutes
        .map(parseSavedCommute)
        .filter((item): item is SavedCommute => Boolean(item))
        .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
        .slice(0, MAX_SAVED_COMMUTES);
      if (commutes.length === 0) return null;
      const active = trimmed(raw.activeId, 100);
      const widget = trimmed(raw.widgetId, 100);
      return {
        commutes,
        activeId: commutes.some((item) => item.id === active) ? active! : commutes[0]!.id,
        widgetId: commutes.some((item) => item.id === widget) ? widget! : commutes[0]!.id,
      };
    }
    const config = parseCommuteValue(raw);
    return config
      ? {
          commutes: [{ id: DEFAULT_COMMUTE_ID, name: 'Commute', config }],
          activeId: DEFAULT_COMMUTE_ID,
          widgetId: DEFAULT_COMMUTE_ID,
        }
      : null;
  } catch {
    return null;
  }
}

export function serializeCommuteLibrary(library: CommuteLibrary): string {
  return JSON.stringify({ version: LIBRARY_VERSION, ...library });
}

/** Whether a parsed config still needs writing back in the current shape. */
export function isLegacyCommuteSetting(value: string | null): boolean {
  if (!value) return false;
  try {
    const raw: unknown = JSON.parse(value);
    return isRecord(raw) && raw.version !== LIBRARY_VERSION;
  } catch {
    return false;
  }
}

export function serializeCommuteConfig(config: CommuteConfig): string {
  return JSON.stringify({ version: CONFIG_VERSION, ...config });
}

/**
 * The saved commute library as a definition: **synced**, unlike everything
 * else the board keeps. Commutes are configuration a person owns, and the web
 * board, Android board and explicit home-screen choice all have to see the same
 * list. The scope is stated here rather than inferred from the absence of a
 * prefix, so a renamed key cannot silently make the library device-local.
 *
 * `parse` owns both migrations: old favorite ids → stop-aware config, then the
 * single config → named library. The existing commute deterministically becomes
 * `commute`, selected both in Atlas and for the widget.
 */
export const COMMUTE_SETTING = defineSetting<CommuteLibrary>({
  key: COMMUTE_SETTING_KEY,
  scope: 'synced',
  defaultValue: EMPTY_COMMUTE_LIBRARY,
  decode: (raw) => parseCommuteLibrary(raw) ?? undefined,
  encode: serializeCommuteLibrary,
});

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
  const [library, setLibrary] = useState<CommuteLibrary>(EMPTY_COMMUTE_LIBRARY);
  const [loaded, setLoaded] = useState(false);
  const [result, setResult] = useState<TransitCommuteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedMs, setUpdatedMs] = useState<number | null>(null);
  const [seed, setSeed] = useState(0);
  const [storedCommit, setStoredCommit] = useState<StoredCommuteCommit | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Both settings before `ready`, not each on its own promise. Two reasons, and
  // the second is why it changed: the board's first request would otherwise go
  // out without the commitment and be replaced the moment it arrived — two
  // upstream calls for one opening — and `ready` is the signal Android hands
  // the home-screen widget, which must never be told "nothing is tracked"
  // merely because the app started.
  useEffect(() => {
    if (status !== 'ready' || loaded) return;
    let current = true;
    void Promise.all([
      getSetting(COMMUTE_SETTING.key),
      getSetting(COMMUTE_COMMIT_SETTING.key),
    ]).then(([saved, savedCommit]) => {
      if (!current) return;
      const next = readSetting(COMMUTE_SETTING, saved);
      const nextCommit = readSetting(COMMUTE_COMMIT_SETTING, savedCommit);
      setLibrary(next);
      setStoredCommit(
        nextCommit ? { ...nextCommit, commuteId: nextCommit.commuteId || next.activeId } : null,
      );
      // Write back only to finish a migration. A first run writes nothing: an
      // empty commute is not worth a synced row on every device.
      if (saved && isLegacyCommuteSetting(saved)) {
        void saveSetting(COMMUTE_SETTING.key, COMMUTE_SETTING.encode(next));
      }
      setLoaded(true);
    });
    return () => {
      current = false;
    };
  }, [getSetting, loaded, saveSetting, status]);

  const activeCommute =
    library.commutes.find((item) => item.id === library.activeId) ?? library.commutes[0]!;
  const config = activeCommute.config;
  const commit = storedCommit?.commuteId === activeCommute.id ? storedCommit.commit : null;
  const query = useMemo(() => commuteQueryFrom(config, places), [config, places]);
  const widgetConfig =
    library.commutes.find((item) => item.id === library.widgetId)?.config ??
    library.commutes[0]!.config;
  const widgetQuery = useMemo(() => commuteQueryFrom(widgetConfig, places), [widgetConfig, places]);
  const queryKey = query ? JSON.stringify(query) : '';
  const commitKey = commit ? `${commit.direction}:${commit.departureMs}:${commit.line}` : '';

  useEffect(() => {
    // A second commute is a different board even when its request will take a
    // moment. Never leave the previous corridor's journeys under the new name.
    setResult(null);
    setError(null);
    setUpdatedMs(null);
  }, [activeCommute.id]);

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

  const updateLibrary = useCallback(
    (change: (current: CommuteLibrary) => CommuteLibrary) => {
      setLibrary((current) => {
        const next = change(current);
        void saveSetting(COMMUTE_SETTING.key, COMMUTE_SETTING.encode(next));
        return next;
      });
    },
    [saveSetting],
  );
  const setConfig = useCallback(
    (next: CommuteConfig) =>
      updateLibrary((current) => ({
        ...current,
        commutes: current.commutes.map((item) =>
          item.id === current.activeId ? { ...item, config: next } : item,
        ),
      })),
    [updateLibrary],
  );
  const selectCommute = useCallback(
    (id: string) =>
      updateLibrary((current) =>
        current.commutes.some((item) => item.id === id) ? { ...current, activeId: id } : current,
      ),
    [updateLibrary],
  );
  const addCommute = useCallback(() => {
    updateLibrary((current) => {
      if (current.commutes.length >= MAX_SAVED_COMMUTES) return current;
      const id = crypto.randomUUID();
      let number = current.commutes.length + 1;
      const names = new Set(current.commutes.map((item) => item.name.toLocaleLowerCase()));
      while (names.has(`commute ${number}`)) number += 1;
      return {
        ...current,
        activeId: id,
        commutes: [
          ...current.commutes,
          { id, name: `Commute ${number}`, config: { ...EMPTY_COMMUTE_CONFIG } },
        ],
      };
    });
  }, [updateLibrary]);
  const renameCommute = useCallback(
    (id: string, name: string) => {
      const clean = name.trim().slice(0, 80);
      if (!clean) return;
      updateLibrary((current) => ({
        ...current,
        commutes: current.commutes.map((item) =>
          item.id === id ? { ...item, name: clean } : item,
        ),
      }));
    },
    [updateLibrary],
  );
  const deleteCommute = useCallback(
    (id: string) =>
      updateLibrary((current) => {
        if (current.commutes.length <= 1 || !current.commutes.some((item) => item.id === id)) {
          return current;
        }
        const commutes = current.commutes.filter((item) => item.id !== id);
        const fallback = commutes[0]!.id;
        return {
          commutes,
          activeId: current.activeId === id ? fallback : current.activeId,
          widgetId: current.widgetId === id ? fallback : current.widgetId,
        };
      }),
    [updateLibrary],
  );
  const setWidgetCommute = useCallback(
    (id: string) =>
      updateLibrary((current) =>
        current.commutes.some((item) => item.id === id) ? { ...current, widgetId: id } : current,
      ),
    [updateLibrary],
  );
  const setCommit = useCallback(
    (next: TransitWidgetV2Commit | null) => {
      const stored = next ? { commuteId: activeCommute.id, commit: next } : null;
      setStoredCommit(stored);
      // Written even when clearing, so a board reopened later starts untracked
      // rather than re-reading a commitment the user let go of.
      void saveSetting(
        COMMUTE_COMMIT_SETTING.key,
        stored ? COMMUTE_COMMIT_SETTING.encode(stored) : '',
      );
    },
    [activeCommute.id, saveSetting],
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

  const existingPlaceIds = useMemo(() => new Set(places.map((place) => place.id)), [places]);
  const staleEnds = useMemo<StaleCommuteEnd[]>(() => {
    const out: StaleCommuteEnd[] = [];
    for (const item of library.commutes) {
      for (const end of ['from', 'via', 'to'] as const) {
        const placeId = item.config[end]?.placeId;
        if (placeId && !existingPlaceIds.has(placeId)) {
          out.push({ commuteId: item.id, commuteName: item.name, end, placeId });
        }
      }
    }
    return out;
  }, [existingPlaceIds, library.commutes]);
  const placeCommutes = useMemo<ReadonlyMap<string, readonly string[]>>(() => {
    const out = new Map<string, string[]>();
    for (const item of library.commutes) {
      for (const end of ['from', 'via', 'to'] as const) {
        const placeId = item.config[end]?.placeId;
        if (!placeId) continue;
        const names = out.get(placeId) ?? [];
        if (!names.includes(item.name)) names.push(item.name);
        out.set(placeId, names);
      }
    }
    return out;
  }, [library.commutes]);

  return {
    ready: loaded,
    config,
    setConfig,
    commutes: library.commutes,
    activeId: activeCommute.id,
    widgetCommuteId: library.widgetId,
    widgetQuery,
    selectCommute,
    addCommute,
    renameCommute,
    deleteCommute,
    setWidgetCommute,
    canAddCommute: library.commutes.length < MAX_SAVED_COMMUTES,
    staleEnds,
    placeCommutes,
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
