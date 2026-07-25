import type { LatLng, NearbyPlaceArticle, PlacePhoto } from '@atlas/core';
import { useEffect, useState } from 'react';

export interface NearbyPlacesState {
  status: 'idle' | 'loading' | 'ready';
  places: NearbyPlaceArticle[];
}

export interface NearbyPhotosState {
  status: 'idle' | 'loading' | 'ready';
  photos: PlacePhoto[];
}

/**
 * Described places around this point — the answer the card's own name lookup
 * cannot give, since most POIs are not themselves the subject of an article.
 *
 * Only fetched once the section is opened (`active`): it is a second Wikimedia
 * round trip per card, and most cards are opened to get directions.
 */
export function useNearbyPlaces(at: LatLng, active: boolean): NearbyPlacesState {
  const [state, setState] = useState<NearbyPlacesState>({ status: 'idle', places: [] });

  useEffect(() => {
    if (!active) {
      setState({ status: 'idle', places: [] });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading', places: [] });
    const params = new URLSearchParams({
      lat: String(at.lat),
      lon: String(at.lng),
      lang: navigator.language,
    });
    void fetch(`/api/place-content/nearby?${params}`, { signal: controller.signal })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { places: NearbyPlaceArticle[] }).places
          : ([] as NearbyPlaceArticle[]),
      )
      .then((places) => setState({ status: 'ready', places }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'ready', places: [] });
      });
    return () => controller.abort();
  }, [active, at.lat, at.lng]);

  return state;
}

/**
 * Geotagged Commons photos near this point, for places with no article of their
 * own. Fetched with the card (not on demand): the whole complaint it answers is
 * that a place shows *nothing*, and a photo behind one more tap is still
 * nothing until it is tapped.
 */
export function useNearbyPhotos(at: LatLng, active: boolean): NearbyPhotosState {
  const [state, setState] = useState<NearbyPhotosState>({ status: 'idle', photos: [] });

  useEffect(() => {
    if (!active) {
      setState({ status: 'idle', photos: [] });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading', photos: [] });
    const params = new URLSearchParams({ lat: String(at.lat), lon: String(at.lng) });
    void fetch(`/api/place-photos?${params}`, { signal: controller.signal })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { photos: PlacePhoto[] }).photos
          : ([] as PlacePhoto[]),
      )
      .then((photos) => setState({ status: 'ready', photos }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'ready', photos: [] });
      });
    return () => controller.abort();
  }, [active, at.lat, at.lng]);

  return state;
}
