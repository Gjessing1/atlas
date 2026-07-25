import type { LatLng, NearbyPlaceArticle, PlacePhoto } from '@atlas/core';
import { haversineM } from '@atlas/core';
import { useEffect, useState } from 'react';

import type { LocalPack } from '../regions/packs';
import { getServerOrigin } from '../serverOrigin';
import { packSearchDb } from '../search/offlineSearch';

export interface NearbyPlacesState {
  status: 'idle' | 'loading' | 'ready';
  places: NearbyPlaceArticle[];
}

export interface NearbyPhotosState {
  status: 'idle' | 'loading' | 'ready';
  photos: PlacePhoto[];
}

/** How far around the point the nearby list looks, in metres. */
const NEARBY_RADIUS_M = 2_000;

/**
 * Described places from a downloaded pack: the same `place_content` table the
 * single-article lookup uses, asked the other way round — everything within a
 * box around the point rather than one exact name. Keeps the nearby list
 * working with no network, minus the thumbnails packs deliberately omit.
 */
async function offlineNearby(packs: LocalPack[], at: LatLng): Promise<NearbyPlaceArticle[]> {
  // Degrees covering the radius at this latitude (longitude shrinks with cos).
  const latDelta = NEARBY_RADIUS_M / 111_320;
  const lngDelta = latDelta / Math.max(Math.cos((at.lat * Math.PI) / 180), 0.01);
  const found: NearbyPlaceArticle[] = [];
  for (const pack of packs.filter((item) => item.manifest.files.search)) {
    try {
      const db = await packSearchDb(pack);
      const tables = await db.getAllAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='place_content'",
      );
      if (tables.length === 0) continue;
      const rows = await db.getAllAsync<{
        title: string;
        extract: string;
        url: string;
        language: string;
        lat: number;
        lng: number;
      }>(
        `SELECT c.title, c.extract, c.url, c.language, p.lat, p.lng
           FROM place_content c
           JOIN places p ON p.rowid = c.place_rowid
          WHERE c.source = 'wikipedia'
            AND p.lat BETWEEN ? AND ?
            AND p.lng BETWEEN ? AND ?
          LIMIT 60`,
        [at.lat - latDelta, at.lat + latDelta, at.lng - lngDelta, at.lng + lngDelta],
      );
      for (const row of rows) {
        const position = { lat: row.lat, lng: row.lng };
        const distanceM = Math.round(haversineM(at, position));
        if (distanceM > NEARBY_RADIUS_M) continue;
        found.push({
          title: row.title,
          extract: row.extract,
          url: row.url,
          language: row.language,
          position,
          distanceM,
          offline: true,
        });
      }
    } catch {
      // Try the next pack, then the network.
    }
  }
  return found.sort((a, b) => a.distanceM - b.distanceM).slice(0, 12);
}

/**
 * Described places around this point — what the card's own name lookup cannot
 * answer, since most POIs are not themselves the subject of an article.
 *
 * The pack answers first so the list is instant and works offline, and the
 * online answer then *replaces* it: packs carry no thumbnails and a pack is
 * only as fresh as the day it was downloaded, so a connected phone should never
 * be shown the poorer list. Fetched only once the section is opened — it is a
 * second round trip on a card that is usually opened to get directions.
 */
export function useNearbyPlaces(
  packs: LocalPack[],
  at: LatLng,
  active: boolean,
): NearbyPlacesState {
  const [state, setState] = useState<NearbyPlacesState>({ status: 'idle', places: [] });
  const { lat, lng } = at;

  useEffect(() => {
    if (!active) {
      setState({ status: 'idle', places: [] });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', places: [] });
    void (async () => {
      const local = await offlineNearby(packs, { lat, lng });
      if (cancelled) return;
      if (local.length > 0) setState({ status: 'ready', places: local });
      try {
        const params = new URLSearchParams({
          lat: String(lat),
          lon: String(lng),
          radius: String(NEARBY_RADIUS_M),
        });
        const response = await fetch(`${getServerOrigin()}/api/place-content/nearby?${params}`, {
          signal: AbortSignal.timeout(6_000),
        });
        const places = response.ok
          ? ((await response.json()) as { places: NearbyPlaceArticle[] }).places
          : [];
        // Keep the pack list rather than emptying a list that had rows in it.
        if (!cancelled && (places.length > 0 || local.length === 0)) {
          setState({ status: 'ready', places });
        }
      } catch {
        if (!cancelled && local.length === 0) setState({ status: 'ready', places: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [packs, lat, lng, active]);

  return state;
}

/**
 * Geotagged Commons photos near this point, for places with no article of their
 * own. Online only — packs carry article text, never image files.
 */
export function useNearbyPhotos(at: LatLng, active: boolean): NearbyPhotosState {
  const [state, setState] = useState<NearbyPhotosState>({ status: 'idle', photos: [] });
  const { lat, lng } = at;

  useEffect(() => {
    if (!active) {
      setState({ status: 'idle', photos: [] });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', photos: [] });
    void (async () => {
      try {
        const params = new URLSearchParams({ lat: String(lat), lon: String(lng), limit: '8' });
        const response = await fetch(`${getServerOrigin()}/api/place-photos?${params}`, {
          signal: AbortSignal.timeout(6_000),
        });
        const photos = response.ok
          ? ((await response.json()) as { photos: PlacePhoto[] }).photos
          : [];
        if (!cancelled) setState({ status: 'ready', photos });
      } catch {
        // Offline: no photo strip, exactly like no forecast.
        if (!cancelled) setState({ status: 'ready', photos: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lat, lng, active]);

  return state;
}
