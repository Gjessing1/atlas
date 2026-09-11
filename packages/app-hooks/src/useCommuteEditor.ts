import {
  TRANSIT_MODE_LABEL,
  RIDE_MODES,
  commuteInterchange,
  minutesOfDayLabel,
  filterModeOf,
} from '@atlas/transit';
import type {
  TransitCommuteDirection,
  TransitCommutePlace,
  TransitLineRef,
  TransitMode,
  TransitStopLines,
  TransitTrip,
  TransitWeekday,
} from '@atlas/transit';
import type { PlaceRecord } from '@atlas/storage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { haversineM, type SearchResult, type StopHit } from '@atlas/core';

import { useStopSearch, type StopGeocodeFn } from './useStopSearch.js';
import type { CommuteConfig, CommuteController, CommuteEnd } from './useCommute.js';

/**
 * One editor for the commute, so web and Android differ only in markup.
 *
 * They did not before: `CommutePanel.tsx` and `CommuteSheet.tsx` were two
 * hand-written forms over the same setting, already wording the same rules
 * differently ("Only bus lines" / "Train must skip" appeared in both, but the
 * hints around them did not match), and both offered a text box where the wire
 * needed an identity. Everything a form has to *decide* lives here — which
 * field is being picked, what the line chips are and what state each is in, what
 * is missing before the board can answer, and what the escape from an
 * over-narrow filter is. The apps keep their own inputs, chips and sheets.
 */

/** Which end of the commute a picker is filling. */
export type CommuteEndKey = 'from' | 'via' | 'to';

/** A line offered as a chip, with everything the chip has to show. */
export interface CommuteLineOption extends TransitLineRef {
  /** Ticked to require, ticked to avoid, or untouched. */
  state: 'off' | 'select' | 'exclude';
  /**
   * This line actually appeared in a journey between the chosen ends — the
   * shortlist that makes the picker a choice between real services rather than
   * a guess at which of a stop's lines goes anywhere useful.
   */
  seen: boolean;
}

export interface CommuteLineGroup {
  mode: TransitMode;
  /** "Bus", "Train" — the same words the planner's own mode chips use. */
  label: string;
  lines: CommuteLineOption[];
}

/** Fetch every line calling at a stop — the platform seam for the picker. */
export type StopLinesFn = (stopId: string, signal: AbortSignal) => Promise<TransitStopLines>;

export interface CommuteEditor {
  config: CommuteConfig;
  ready: boolean;

  // ---- endpoints -------------------------------------------------------
  /** The field whose search box is open, or null. */
  editing: CommuteEndKey | null;
  edit: (field: CommuteEndKey | null) => void;
  /** Stop-aware search for the open field; `transit: true`, so stops rank first. */
  search: ReturnType<typeof useStopSearch>;
  /** Set an end from a search hit, keeping its NSR id when it had one. */
  pickHit: (field: CommuteEndKey, hit: StopHit) => void;
  /** Set an end from a saved place — the shortcut, no longer the only path. */
  pickPlace: (field: CommuteEndKey, place: PlaceRecord) => void;
  clear: (field: CommuteEndKey) => void;
  /** What the field currently reads as, for a button label. */
  endLabel: (field: CommuteEndKey) => string;
  /** True when this end names an actual stop rather than a coordinate. */
  isStop: (field: CommuteEndKey) => boolean;

  /**
   * The interchange the answered journeys all change at, when none is saved —
   * TRANSIT.md §13's middle ground, offered rather than waited for.
   *
   * A commute saved end to end has no `via`, and without one there are no
   * per-leg boards and no "start from" choice: the board can only ever answer
   * the door-to-door question, and nothing on it explains why. This is the
   * corridor telling the app what its own change is, so the app can offer to
   * save it. Null once one is saved, and null whenever the journeys disagree.
   */
  suggestedVia: TransitCommutePlace | null;
  /** Save {@link suggestedVia} as the Via stop, resolving its NSR id first. */
  addSuggestedVia: () => void;
  /** That lookup is in flight. */
  addingVia: boolean;
  /** It could not be resolved to a stop, said where the offer was. */
  suggestedViaError: string | null;

  // ---- services --------------------------------------------------------
  lineGroups: CommuteLineGroup[];
  linesLoading: boolean;
  linesError: string | null;
  /** Require this line (tap again to clear). */
  toggleSelect: (line: TransitLineRef) => void;
  /** Avoid this line (tap again to clear) — "not the local train that stops everywhere". */
  toggleExclude: (line: TransitLineRef) => void;
  /** Drop every line rule: the one-tap way out of an over-narrow board. */
  clearLines: () => void;
  modes: { mode: TransitMode; label: string; on: boolean }[];
  toggleMode: (mode: TransitMode) => void;

  // ---- when ------------------------------------------------------------
  setTime: (direction: TransitCommuteDirection, minutesOfDay: number | null) => void;
  setArriveBy: (direction: TransitCommuteDirection, arriveBy: boolean) => void;
  timeLabel: (direction: TransitCommuteDirection) => string;
  days: { day: TransitWeekday; label: string; on: boolean }[];
  toggleDay: (day: TransitWeekday) => void;

  // ---- state -----------------------------------------------------------
  /** What is still missing before the board can answer, or null when nothing is. */
  missing: string | null;
  /** True once both ends are set — the board is asking. */
  askable: boolean;
}

const WEEKDAY_LABEL: Record<TransitWeekday, string> = {
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
  7: 'Sun',
};

const FIELD_LABEL: Record<CommuteEndKey, string> = { from: 'From', via: 'Via', to: 'To' };

/** Every distinct line ridden in these journeys, with the direction it ran. */
function tripLineRefs(trips: readonly TransitTrip[]): TransitLineRef[] {
  const byId = new Map<string, TransitLineRef>();
  for (const trip of trips) {
    for (const leg of trip.legs) {
      const line = leg.line;
      if (!line?.id || byId.has(line.id)) continue;
      byId.set(line.id, {
        id: line.id,
        publicCode: line.publicCode,
        mode: leg.mode,
        ...(line.name ? { name: line.name } : {}),
        ...(line.operator ? { operator: line.operator } : {}),
        ...(line.headsign ? { towards: line.headsign } : {}),
      });
    }
  }
  return [...byId.values()];
}

/**
 * The searched stop that is really the one the journeys named: same name, and
 * near enough that a national geocoder's other "Asker stasjon" cannot win.
 *
 * Name-first rather than distance-first because a trip answer and the stop
 * search are both Entur naming the same NSR stop place, so an exact match is
 * the strong signal; distance is the tie-break and the sanity check. Hits with
 * no NSR id are not candidates at all — resolving the id is the whole errand.
 */
const SUGGESTED_VIA_RADIUS_M = 800;

function nearestStopHit(hits: SearchResult[], place: TransitCommutePlace): SearchResult | null {
  const near = (hit: SearchResult) => haversineM(hit.position, place) <= SUGGESTED_VIA_RADIUS_M;
  const stops = hits.filter((hit) => hit.transitStopId && near(hit));
  const named = stops.filter(
    (hit) => hit.name.localeCompare(place.name, 'nb-NO', { sensitivity: 'base' }) === 0,
  );
  const pool = named.length > 0 ? named : stops;
  return (
    pool.slice().sort((a, b) => haversineM(a.position, place) - haversineM(b.position, place))[0] ??
    null
  );
}

export function useCommuteEditor({
  commute,
  places,
  geocode,
  fetchStopLines,
}: {
  commute: CommuteController;
  places: readonly PlaceRecord[];
  geocode: StopGeocodeFn;
  fetchStopLines: StopLinesFn;
}): CommuteEditor {
  const { config, setConfig } = commute;
  const [editing, setEditing] = useState<CommuteEndKey | null>(null);
  const [stopLines, setStopLines] = useState<TransitLineRef[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [linesError, setLinesError] = useState<string | null>(null);
  const search = useStopSearch({
    geocode,
    places: places.map((place) => ({ name: place.name, lat: place.lat, lng: place.lng })),
    transit: true,
    limit: 8,
  });
  // Read through a ref: a seam rebuilt on every render would restart the fetch
  // forever if it entered the effect's deps.
  const fetchRef = useRef(fetchStopLines);
  fetchRef.current = fetchStopLines;
  const searchRef = useRef(search);
  searchRef.current = search;

  const patch = useCallback(
    (next: Partial<CommuteConfig>) => setConfig({ ...config, ...next }),
    [config, setConfig],
  );

  // ---- endpoints -------------------------------------------------------
  const edit = useCallback((field: CommuteEndKey | null) => {
    setEditing(field);
    searchRef.current.reset();
  }, []);

  const setEnd = useCallback(
    (field: CommuteEndKey, end: CommuteEnd | null) => {
      patch({ [field]: end } as Partial<CommuteConfig>);
      setEditing(null);
      searchRef.current.reset();
    },
    [patch],
  );

  const pickHit = useCallback(
    (field: CommuteEndKey, hit: StopHit) => {
      setEnd(field, {
        name: hit.name,
        position: { lat: hit.position.lat, lng: hit.position.lng },
        ...(hit.transitStopId ? { stopId: hit.transitStopId } : {}),
      });
    },
    [setEnd],
  );

  const pickPlace = useCallback(
    (field: CommuteEndKey, place: PlaceRecord) => {
      setEnd(field, {
        name: place.name,
        position: { lat: place.lat, lng: place.lng },
        placeId: place.id,
      });
    },
    [setEnd],
  );

  const clear = useCallback((field: CommuteEndKey) => setEnd(field, null), [setEnd]);

  const endLabel = useCallback(
    (field: CommuteEndKey) => {
      const end = config[field];
      if (!end) return field === 'via' ? 'No interchange' : `Choose a ${FIELD_LABEL[field]} stop…`;
      const place = end.placeId ? places.find((item) => item.id === end.placeId) : undefined;
      return place?.name ?? end.name ?? 'Stop';
    },
    [config, places],
  );

  const isStop = useCallback((field: CommuteEndKey) => Boolean(config[field]?.stopId), [config]);

  // ---- the interchange the journeys already agree on -------------------
  //
  // TRANSIT.md §13. Everything the middle ground and the per-leg boards do hangs off
  // a saved `via`, and a commute is saved door to door — so the corridor that
  // changes at Asker twelve times out of twelve was offering no way to be read
  // from Asker. The answer already on screen knows the stop; this is the offer
  // to save it.
  const suggestedVia = useMemo(
    () => (config.via ? null : commuteInterchange(commute.result)),
    [config.via, commute.result],
  );
  const suggestedViaRef = useRef(suggestedVia);
  suggestedViaRef.current = suggestedVia;
  const geocodeRef = useRef(geocode);
  geocodeRef.current = geocode;
  const [addingVia, setAddingVia] = useState(false);
  const [suggestedViaError, setSuggestedViaError] = useState<string | null>(null);

  const addSuggestedVia = useCallback(() => {
    const hint = suggestedViaRef.current;
    if (!hint) return;
    setAddingVia(true);
    setSuggestedViaError(null);
    void (async () => {
      const controller = new AbortController();
      try {
        const found = await geocodeRef.current({
          text: hint.name,
          transit: true,
          limit: 8,
          signal: controller.signal,
        });
        const hit = nearestStopHit(found.results, hint);
        // A coordinate would answer the journey question and silently break the
        // other two: the line picker can only ask a *stop* for its lines, and a
        // via the planner reaches by walking to a point is not the interchange
        // anyone stands at. Better to say so and let the picker do it.
        if (!hit) {
          setSuggestedViaError(`Could not find ${hint.name} in the stop search. Set Via by hand.`);
          return;
        }
        setEnd('via', {
          name: hit.name,
          position: { lat: hit.position.lat, lng: hit.position.lng },
          stopId: hit.transitStopId!,
        });
      } catch {
        setSuggestedViaError('Could not look that stop up just now.');
      } finally {
        setAddingVia(false);
      }
    })();
  }, [setEnd]);

  // ---- services --------------------------------------------------------
  // The stops whose lines the picker offers. Only ends that named a stop can
  // answer: a coordinate has no line list, which is precisely why the ends had
  // to become stops first.
  const stopIds = useMemo(
    () =>
      [config.from?.stopId, config.via?.stopId, config.to?.stopId].filter((id): id is string =>
        Boolean(id),
      ),
    [config.from?.stopId, config.via?.stopId, config.to?.stopId],
  );
  const stopKey = stopIds.join('|');

  useEffect(() => {
    if (stopIds.length === 0) {
      setStopLines([]);
      setLinesError(null);
      return;
    }
    const controller = new AbortController();
    setLinesLoading(true);
    setLinesError(null);
    void (async () => {
      try {
        const answers = await Promise.all(
          stopIds.map((id) => fetchRef.current(id, controller.signal)),
        );
        if (controller.signal.aborted) return;
        const byId = new Map<string, TransitLineRef>();
        for (const answer of answers) {
          for (const line of answer.lines) if (!byId.has(line.id)) byId.set(line.id, line);
        }
        setStopLines([...byId.values()]);
      } catch {
        if (!controller.signal.aborted) {
          setStopLines([]);
          setLinesError('Could not read the lines at these stops.');
        }
      } finally {
        if (!controller.signal.aborted) setLinesLoading(false);
      }
    })();
    return () => controller.abort();
    // stopIds enters through its stable joined key.
  }, [stopKey]);

  /**
   * The lines a real journey between these ends used. Free: it is read off the
   * board's own answer, so an unfiltered commute doubles as the reachability
   * check while editing instead of costing another upstream call.
   */
  const seenLines = useMemo(() => {
    const trips = [
      ...(commute.result?.outbound.trips ?? []),
      ...(commute.result?.inbound.trips ?? []),
    ];
    return tripLineRefs(trips);
  }, [commute.result]);

  const lineGroups = useMemo<CommuteLineGroup[]>(() => {
    const byId = new Map<string, TransitLineRef>();
    // A journey's own lines come first: they are known to go somewhere useful,
    // and they cover interchange lines no chosen stop publishes.
    for (const line of [...seenLines, ...stopLines, ...config.select, ...config.exclude]) {
      if (!byId.has(line.id)) byId.set(line.id, line);
    }
    const seenIds = new Set(seenLines.map((line) => line.id));
    const selectIds = new Set(config.select.map((line) => line.id));
    const excludeIds = new Set(config.exclude.map((line) => line.id));
    const groups = new Map<TransitMode, CommuteLineOption[]>();
    for (const line of byId.values()) {
      const option: CommuteLineOption = {
        ...line,
        state: selectIds.has(line.id) ? 'select' : excludeIds.has(line.id) ? 'exclude' : 'off',
        seen: seenIds.has(line.id),
      };
      const chip = filterModeOf(line.mode);
      const list = groups.get(chip);
      if (list) list.push(option);
      else groups.set(chip, [option]);
    }
    const order = (mode: TransitMode) => {
      const index = RIDE_MODES.indexOf(mode);
      return index === -1 ? RIDE_MODES.length : index;
    };
    return [...groups.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([mode, lines]) => ({
        mode,
        label: TRANSIT_MODE_LABEL[mode],
        lines: lines.sort((a, b) => {
          if (a.seen !== b.seen) return a.seen ? -1 : 1;
          const numeric = (code: string) => {
            const digits = /^\d+/.exec(code);
            return digits ? Number(digits[0]) : Number.POSITIVE_INFINITY;
          };
          if (numeric(a.publicCode) !== numeric(b.publicCode)) {
            return numeric(a.publicCode) - numeric(b.publicCode);
          }
          return a.publicCode.localeCompare(b.publicCode, 'nb-NO');
        }),
      }));
  }, [config.exclude, config.select, seenLines, stopLines]);

  const toggleSelect = useCallback(
    (line: TransitLineRef) => {
      const on = config.select.some((item) => item.id === line.id);
      patch({
        select: on ? config.select.filter((item) => item.id !== line.id) : [...config.select, line],
        // A line cannot be both required and avoided.
        exclude: config.exclude.filter((item) => item.id !== line.id),
      });
    },
    [config.exclude, config.select, patch],
  );

  const toggleExclude = useCallback(
    (line: TransitLineRef) => {
      const on = config.exclude.some((item) => item.id === line.id);
      patch({
        exclude: on
          ? config.exclude.filter((item) => item.id !== line.id)
          : [...config.exclude, line],
        select: config.select.filter((item) => item.id !== line.id),
      });
    },
    [config.exclude, config.select, patch],
  );

  const clearLines = useCallback(() => patch({ select: [], exclude: [] }), [patch]);

  const modes = useMemo(
    () =>
      RIDE_MODES.map((mode) => ({
        mode,
        label: TRANSIT_MODE_LABEL[mode],
        // An empty selection means every mode, so every chip reads as on.
        on: config.modes.length === 0 || config.modes.includes(mode),
      })),
    [config.modes],
  );

  const toggleMode = useCallback(
    (mode: TransitMode) => {
      const current = config.modes.length === 0 ? [...RIDE_MODES] : config.modes;
      const next = current.includes(mode)
        ? current.filter((item) => item !== mode)
        : [...current, mode];
      // Unticking the last mode would ask for "no transport at all"; treat a full
      // or empty selection alike as "all of them".
      patch({ modes: next.length === 0 || next.length === RIDE_MODES.length ? [] : next });
    },
    [config.modes, patch],
  );

  // ---- when ------------------------------------------------------------
  const setTime = useCallback(
    (direction: TransitCommuteDirection, minutesOfDay: number | null) => {
      const key = direction === 'outbound' ? 'outboundTime' : 'inboundTime';
      patch({ [key]: { ...config[key], minutesOfDay } } as Partial<CommuteConfig>);
    },
    [config, patch],
  );

  const setArriveBy = useCallback(
    (direction: TransitCommuteDirection, arriveBy: boolean) => {
      const key = direction === 'outbound' ? 'outboundTime' : 'inboundTime';
      patch({ [key]: { ...config[key], arriveBy } } as Partial<CommuteConfig>);
    },
    [config, patch],
  );

  const timeLabel = useCallback(
    (direction: TransitCommuteDirection) => {
      const time = direction === 'outbound' ? config.outboundTime : config.inboundTime;
      if (time.minutesOfDay === null) return 'Leave now';
      const clock = minutesOfDayLabel(time.minutesOfDay);
      return time.arriveBy ? `Arrive by ${clock}` : `Leave at ${clock}`;
    },
    [config.inboundTime, config.outboundTime],
  );

  const days = useMemo(
    () =>
      ([1, 2, 3, 4, 5, 6, 7] as TransitWeekday[]).map((day) => ({
        day,
        label: WEEKDAY_LABEL[day],
        on: config.days.length === 0 || config.days.includes(day),
      })),
    [config.days],
  );

  const toggleDay = useCallback(
    (day: TransitWeekday) => {
      const current =
        config.days.length === 0 ? ([1, 2, 3, 4, 5, 6, 7] as TransitWeekday[]) : config.days;
      const next = current.includes(day)
        ? current.filter((item) => item !== day)
        : [...current, day];
      patch({
        days: (next.length === 0 || next.length === 7 ? [] : next).sort((a, b) => a - b),
      });
    },
    [config.days, patch],
  );

  // ---- state -----------------------------------------------------------
  const missing = !config.from
    ? 'Choose where the commute starts.'
    : !config.to
      ? 'Choose where it ends.'
      : null;

  return {
    config,
    ready: commute.ready,
    editing,
    edit,
    search,
    pickHit,
    pickPlace,
    clear,
    endLabel,
    isStop,
    suggestedVia,
    addSuggestedVia,
    addingVia,
    suggestedViaError,
    lineGroups,
    linesLoading,
    linesError,
    toggleSelect,
    toggleExclude,
    clearLines,
    modes,
    toggleMode,
    setTime,
    setArriveBy,
    timeLabel,
    days,
    toggleDay,
    missing,
    askable: commute.query !== null,
  };
}
