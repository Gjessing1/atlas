import type { LatLng, OverlayIdentifyGroup, SearchResult } from '@atlas/core';
import { useCallback, useState } from 'react';

import type { DestinationTarget } from './DestinationCard';

export interface DestinationController {
  /**
   * A picked place awaiting an action (search result, long-press, saved place
   * or favorite). Cleared once the route planner takes it over. The travel mode
   * is not decided here — the RoutePanel is the app's single mode picker.
   */
  destination: DestinationTarget | null;
  /** Show the card for a picked point, and bring that point into view. */
  pick: (target: DestinationTarget) => void;
  /** Show the card for a bare coordinate (a share link's pin, a long-press). */
  pickPoint: (at: LatLng, fly?: boolean) => void;
  /** A search hit the user chose from the results list. */
  pickResult: (result: SearchResult) => void;
  /**
   * Overlay tap-to-identify answered for the tapped point: show it on the card
   * that tap opened, or open one for the bare point when the tap hit no pin or
   * POI (a lake with a surveyed depth is worth a card of its own).
   */
  showIdentify: (at: LatLng, groups: OverlayIdentifyGroup[]) => void;
  /** The red pin was dragged: the destination becomes that adjusted point. */
  onMoved: (at: LatLng) => void;
  clear: () => void;
}

const coordName = (p: LatLng) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;

/**
 * The one picked point the app is currently offering actions for. Every way in
 * — map tap, long-press, search result, favorite, share link — funnels through
 * here, so there is a single answer to "what is selected" and a single card
 * describing it.
 */
export function useDestination(flyTo: (at: LatLng) => void): DestinationController {
  const [destination, setDestination] = useState<DestinationTarget | null>(null);

  const pick = useCallback(
    (target: DestinationTarget) => {
      setDestination(target);
      flyTo({ lat: target.lat, lng: target.lng });
    },
    [flyTo],
  );

  const pickPoint = useCallback(
    (at: LatLng, fly = true) => {
      const target = { lat: at.lat, lng: at.lng, name: coordName(at), canSave: true };
      if (fly) pick(target);
      else setDestination(target);
    },
    [pick],
  );

  const pickResult = useCallback(
    (result: SearchResult) => {
      pick({
        lat: result.position.lat,
        lng: result.position.lng,
        name: result.name || result.label || 'Dropped pin',
        address: result.address,
        detail: result.address ? undefined : result.label || undefined,
        canSave: true,
      });
    },
    [pick],
  );

  const showIdentify = useCallback((at: LatLng, groups: OverlayIdentifyGroup[]) => {
    if (groups.length === 0) return;
    setDestination((d) =>
      d
        ? { ...d, identify: groups }
        : { lat: at.lat, lng: at.lng, name: coordName(at), canSave: true, identify: groups },
    );
  }, []);

  const onMoved = useCallback((at: LatLng) => {
    setDestination((d) =>
      d ? { lat: at.lat, lng: at.lng, name: coordName(at), canSave: true } : d,
    );
  }, []);

  const clear = useCallback(() => setDestination(null), []);

  return { destination, pick, pickPoint, pickResult, showIdentify, onMoved, clear };
}
