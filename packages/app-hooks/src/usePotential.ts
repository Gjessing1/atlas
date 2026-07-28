/**
 * Preparing the derived potential surfaces for what the user is looking at
 * (ROADMAP § N5 — "preparation is visible and cancellable").
 *
 * A derived layer is unlike every other overlay in one way that the user has to
 * be told about rather than left to discover: **the pixels do not exist until
 * someone asks for them.** Switching it on over new water means fetching a DTM,
 * a lake register, a river network and a land-cover raster, and running a model
 * over a 1088² grid — a couple of seconds per ~10 km cell, longer over a slow
 * link. A map that simply stays blank during that is indistinguishable from a
 * map with nothing to show, which is the exact confusion D5 and the coverage
 * notes exist to prevent.
 *
 * So this hook owns the whole "is there anything here, and is it ready?"
 * question for both clients, and answers it in one sentence they both render:
 *
 * - **Below z11** there is nothing to prepare (a cell *is* a z11 tile), so it
 *   says zoom in rather than queueing work the map cannot draw.
 * - **Outside Norway** it says so without a round trip — every input is a
 *   Norwegian government service, and per the Norway-only precedent that is an
 *   absence, not an error.
 * - **While cells are building** it counts them, and can be paused: this queues
 *   real work against public services, so "make it stop" must be one tap and
 *   must not cost the user the layer.
 * - **When a cell comes back with nothing scored** it says *that* too — blank
 *   is a finding here ("no mapped lakes"), not a failure.
 *
 * The cell arithmetic is the engine's own (`@atlas/potential`), so the client
 * asks for exactly the cells the server would derive: the pill's count is the
 * truth rather than an estimate, and a pan inside the same cells is not a
 * request at all.
 */

import type { LatLng, LngLatBbox } from '@atlas/core';
import {
  CELL_ZOOM,
  cellId,
  cellsForBbox,
  potentialExplainUrl,
  potentialPrepareUrl,
  type PotentialCellState,
  type PotentialExplainResponse,
  type PotentialPrepareResponse,
} from '@atlas/potential';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Which surface the map is drawing, as the layer panel resolved it. */
export interface PotentialTargetSelection {
  readonly layer: string;
  readonly target: string;
}

/** What the map is looking at. Null while the map has no camera yet. */
export interface PotentialView {
  readonly bbox: LngLatBbox;
  readonly zoom: number;
}

export type PotentialPrepStatus =
  'off' | 'zoom-in' | 'outside' | 'preparing' | 'paused' | 'ready' | 'empty' | 'error';

export interface PotentialPrep {
  readonly status: PotentialPrepStatus;
  /**
   * The pill's sentence, or null when there is nothing worth saying — a
   * surface that is simply ready needs no announcement.
   */
  readonly message: string | null;
  readonly ready: number;
  readonly total: number;
  /**
   * A short digest that changes whenever the set of *derived* cells changes.
   *
   * Both clients fold it into the raster source's id, so a cell that finishes
   * building appears instead of waiting behind tiles the map already fetched
   * and considers done. This is the whole reason a landing cell shows up at all
   * without a pan.
   *
   * Digested rather than raw here because that is what its only use requires:
   * cell ids and ETags contain slashes and quotes, which have no business in a
   * MapLibre source id on either platform.
   */
  readonly readyKey: string;
  /** Stop asking, without switching the layer off. */
  readonly pause: () => void;
  readonly resume: () => void;
}

/** How long after the map settles before a new area is requested. */
const DEBOUNCE_MS = 500;

/** How often a viewport with work outstanding is re-checked. */
const POLL_MS = 2500;

/** Cells asked for at once — the server caps this too; see `cellsForBbox`. */
const MAX_CELLS = 12;

const IDLE: PotentialPrep = {
  status: 'off',
  message: null,
  ready: 0,
  total: 0,
  readyKey: '',
  pause: () => {},
  resume: () => {},
};

/** An id-safe digest of the ready cells and their ETags (see `readyKey`). */
function digest(value: string): string {
  if (value === '') return '';
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** "Reading the water · 2 of 4 areas" — the vocabulary follows the surface. */
function preparingMessage(ready: number, total: number, hunt: boolean): string {
  const what = hunt ? 'Reading the ground' : 'Reading the water';
  return total <= 1 ? `${what}…` : `${what} · ${ready} of ${total} areas`;
}

/**
 * What a fully-derived-but-blank area should say.
 *
 * The model's own note is preferred over anything written here: "No mapped
 * lakes in this area." is a statement about NVE's register, and the user is
 * entitled to know that is what they are looking at rather than a guess of ours.
 */
function emptyMessage(cells: readonly PotentialCellState[]): string {
  for (const cell of cells) {
    const note = cell.manifest?.notes?.[0];
    if (note) return note;
  }
  return 'Nothing to score in this area.';
}

export function usePotential(
  origin: string,
  selection: PotentialTargetSelection | null,
  view: PotentialView | null,
  /** Legend vocabulary, so the pill speaks the surface's language. */
  vocabulary: 'fishing' | 'hunt' = 'fishing',
): PotentialPrep {
  const [response, setResponse] = useState<PotentialPrepareResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [paused, setPaused] = useState(false);
  // The last request that actually went out, so a settled viewport with nothing
  // outstanding is not asked about again on every pan of a few metres.
  const doneKey = useRef<string | null>(null);

  const layer = selection?.layer ?? null;
  const target = selection?.target ?? '';
  const zoom = view?.zoom ?? 0;

  // The exact cells the server would derive for this viewport. Recomputed only
  // when the bbox moves, and reduced to a string so every effect below can
  // depend on the *cell set* rather than on a fresh array each render.
  const bbox = view?.bbox;
  const cellKey = useMemo(() => {
    if (!layer || !bbox || zoom < CELL_ZOOM) return '';
    return cellsForBbox(bbox, MAX_CELLS).map(cellId).join(' ');
  }, [layer, bbox?.[0], bbox?.[1], bbox?.[2], bbox?.[3], zoom < CELL_ZOOM]);

  // A new layer, target or area starts a fresh answer rather than leaving the
  // previous one on screen — the counts belong to the request that produced them.
  const requestKey = layer ? `${layer}/${target}/${cellKey}` : '';
  useEffect(() => {
    setResponse(null);
    setFailed(false);
    doneKey.current = null;
  }, [requestKey]);

  // Switching the layer off and on again is the natural "start over", so it
  // clears a pause too.
  useEffect(() => setPaused(false), [layer, target]);

  useEffect(() => {
    if (!layer || !bbox || paused || cellKey === '') return;
    if (doneKey.current === requestKey) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const ask = async () => {
      try {
        const res = await fetch(potentialPrepareUrl(origin), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ layer, target, bbox }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as PotentialPrepareResponse;
        if (cancelled) return;
        setResponse(body);
        setFailed(false);
        // `repairing` counts cells that are already on screen and being derived
        // again because an upstream they missed came back. Polling through that
        // is what lets the better surface arrive without a pan — the tiles keep
        // their URLs, so `readyKey` (the ETags) is the only thing that moves —
        // and the pill deliberately says nothing about it.
        if (body.working > 0 || (body.repairing ?? 0) > 0) {
          timer = setTimeout(() => void ask(), POLL_MS);
        } else {
          // Everything this viewport needs exists; stop asking until it moves.
          doneKey.current = requestKey;
        }
      } catch {
        if (cancelled) return;
        // One failure is not worth a red banner over a map — the surface simply
        // has not arrived. It is retried on the next move.
        setFailed(true);
      }
    };

    timer = setTimeout(() => void ask(), DEBOUNCE_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    origin,
    layer,
    target,
    requestKey,
    cellKey,
    paused,
    bbox?.[0],
    bbox?.[1],
    bbox?.[2],
    bbox?.[3],
  ]);

  const pause = useCallback(() => setPaused(true), []);
  const resume = useCallback(() => {
    setPaused(false);
    doneKey.current = null;
  }, []);

  return useMemo((): PotentialPrep => {
    if (!layer || !view) return IDLE;
    const hunt = vocabulary === 'hunt';
    const base = { pause, resume, readyKey: '', ready: 0, total: 0 };
    if (zoom < CELL_ZOOM) {
      return {
        ...base,
        status: 'zoom-in',
        message: hunt ? 'Zoom in to read the ground' : 'Zoom in to read the water',
      };
    }
    if (cellKey === '') {
      return {
        ...base,
        status: 'outside',
        // Norway-only, stated as an absence: the engine's inputs are Norwegian
        // government services and there is nothing here to be broken.
        message: 'Derived surfaces cover Norway only',
      };
    }
    const cells = response?.cells ?? [];
    const ready = response?.ready ?? 0;
    const total = cells.length || cellKey.split(' ').length;
    const readyKey = digest(
      cells
        .filter((cell) => cell.status === 'ready')
        .map((cell) => `${cell.cell}:${cell.manifest?.etag ?? ''}`)
        .join(','),
    );

    if (paused) {
      return { ...base, status: 'paused', message: 'Preparation paused', ready, total, readyKey };
    }
    // A cell whose derive gave up, or a prepare that never answered. Both are
    // terminal — nothing more is coming without another look — so the pill says
    // so once instead of counting towards an area that will never arrive.
    const gaveUp = response?.failed ?? 0;
    if ((failed && ready === 0) || (gaveUp > 0 && response?.working === 0)) {
      return {
        ...base,
        status: 'error',
        message:
          ready > 0
            ? `${gaveUp || 1} of ${total} areas could not be prepared`
            : 'Could not prepare this area',
        ready,
        total,
        readyKey,
      };
    }
    if (!response || response.working > 0) {
      return {
        ...base,
        status: 'preparing',
        message: preparingMessage(ready, total, hunt),
        ready,
        total,
        readyKey,
      };
    }
    // Everything is derived. A surface with no scored pixel anywhere is a
    // finding, not a failure, and says what the model actually found.
    const scored = cells.some((cell) => (cell.manifest?.coverage ?? 0) > 0);
    if (!scored) {
      return { ...base, status: 'empty', message: emptyMessage(cells), ready, total, readyKey };
    }
    return { ...base, status: 'ready', message: null, ready, total, readyKey };
  }, [layer, view, zoom, cellKey, response, paused, failed, vocabulary, pause, resume]);
}

/**
 * "Why is this water good?" at one tapped point — D4's *nothing scores without
 * saying why*, on both clients' place card.
 *
 * The answer is assembled by the server from the signal planes the derive
 * persisted, so the card cannot drift from the arithmetic that drew the pixels.
 * What this hook adds is the discipline about *when to say nothing*: most map
 * taps are navigation rather than questions, so a point on dry land, in a cell
 * nobody has prepared, or on a surface the contrast gate refused resolves to
 * `none` and the card simply has no potential section. An error does the same —
 * a failed explain must never become something the user has to dismiss.
 */
export interface PotentialExplainState {
  readonly status: 'idle' | 'loading' | 'ready' | 'none';
  readonly data: PotentialExplainResponse | null;
}

const NO_EXPLANATION: PotentialExplainState = { status: 'idle', data: null };

export function usePotentialExplain(
  origin: string,
  selection: PotentialTargetSelection | null,
  at: LatLng | null,
): PotentialExplainState {
  const [state, setState] = useState<PotentialExplainState>(NO_EXPLANATION);
  const layer = selection?.layer ?? null;
  const target = selection?.target ?? '';
  const lat = at?.lat;
  const lng = at?.lng;

  useEffect(() => {
    if (!layer || lat === undefined || lng === undefined) {
      setState(NO_EXPLANATION);
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', data: null });
    void (async () => {
      try {
        const res = await fetch(potentialExplainUrl(origin, layer, target, { lat, lng }));
        if (cancelled) return;
        if (!res.ok) {
          // 404 = this cell is not derived yet. That is the preparation pill's
          // story to tell, not the card's.
          setState({ status: 'none', data: null });
          return;
        }
        const body = (await res.json()) as PotentialExplainResponse;
        if (cancelled) return;
        // `band: null` means the engine never scored this point — dry land, or
        // water it does not read. Saying "nothing is derived here" on every tap
        // would make the card noise; saying nothing is the honest version.
        setState(
          body.band === null ? { status: 'none', data: null } : { status: 'ready', data: body },
        );
      } catch {
        if (!cancelled) setState({ status: 'none', data: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [origin, layer, target, lat, lng]);

  return state;
}
