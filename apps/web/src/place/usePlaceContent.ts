import type { LatLng, PlaceContent } from '@atlas/core';
import { useEffect, useState } from 'react';

export type PlaceContentState =
  | { status: 'idle' | 'loading'; content: PlaceContent[] }
  | { status: 'ready'; content: PlaceContent[] };

/** Online-first web summary lookup through Atlas's same-origin proxy. */
export function usePlaceContent(name: string | undefined, at: LatLng): PlaceContentState {
  const [state, setState] = useState<PlaceContentState>({ status: 'idle', content: [] });

  useEffect(() => {
    if (!name?.trim()) {
      setState({ status: 'idle', content: [] });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading', content: [] });
    const params = new URLSearchParams({
      name,
      lat: String(at.lat),
      lon: String(at.lng),
      lang: navigator.language,
    });
    void fetch(`/api/place-content?${params}`, { signal: controller.signal })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { content: PlaceContent[] }).content
          : ([] as PlaceContent[]),
      )
      .then((content) => setState({ status: 'ready', content }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'ready', content: [] });
      });
    return () => controller.abort();
  }, [name, at.lat, at.lng]);

  return state;
}
