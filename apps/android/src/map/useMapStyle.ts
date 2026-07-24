import type { AtlasStorage } from '@atlas/storage';
import type { MapAppearance } from '@atlas/core';
import { useEffect, useMemo, useState } from 'react';

import {
  buildOfflineStyle,
  buildOnlineStyle,
  FALLBACK_STYLE_URL,
  loadStyleTemplate,
} from '../mapStyle';
import type { LocalPack } from '../regions/packs';
import { hydrateServerOrigin, useServerOrigin } from '../serverOrigin';

/**
 * Resolves the style the map should render, offline first: the downloaded pack
 * whenever one covers the view, otherwise the server-hosted style, with the
 * public fallback style keeping the map usable bare. `preferOnline` (a Settings
 * switch, for a pack the user knows is stale) flips that round — but a pack
 * still takes over when the server can't be reached. `mapStyle` stays null (and
 * `originReady` false) until the persisted server override has been loaded, so
 * the first health check / style fetch already targets the configured server.
 */
export function useMapStyle(
  storage: AtlasStorage | null,
  offlinePack: LocalPack | undefined,
  preferOnline: boolean,
  appearance: MapAppearance,
  /** Called once the server origin is ready and on origin changes (pack refresh). */
  onOriginLive: () => void,
) {
  const serverOrigin = useServerOrigin();
  const [originReady, setOriginReady] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const [serverUp, setServerUp] = useState<boolean | null>(null);

  useEffect(() => {
    if (!storage) return;
    void hydrateServerOrigin(storage).finally(() => setOriginReady(true));
  }, [storage]);

  useEffect(() => {
    if (!originReady) return;
    setServerUp(null);
    void loadStyleTemplate().then(setTemplate);
    fetch(`${serverOrigin}/api/health`, { signal: AbortSignal.timeout(4000) })
      .then((res) => setServerUp(res.ok))
      .catch(() => setServerUp(false));
    onOriginLive();
  }, [originReady, serverOrigin, onOriginLive]);

  const useOffline = Boolean((!preferOnline || serverUp === false) && offlinePack && template);
  const mapStyle = useMemo(() => {
    if (useOffline && offlinePack && template)
      return buildOfflineStyle(
        template,
        offlinePack.dir,
        appearance,
        Boolean(offlinePack.manifest.files.outdoor),
      );
    if (template) return buildOnlineStyle(template, appearance);
    return serverUp === null ? null : FALLBACK_STYLE_URL;
  }, [useOffline, offlinePack, template, serverUp, appearance]);

  return { mapStyle, originReady, useOffline };
}
