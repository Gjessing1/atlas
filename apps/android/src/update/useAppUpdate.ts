import type { AppVersionResponse } from '@atlas/core';
import * as Application from 'expo-application';
import { useCallback, useEffect, useState } from 'react';
import { Linking } from 'react-native';

import { useServerOrigin } from '../serverOrigin';

export interface AppUpdateState {
  /** Installed versionName/versionCode, for display. */
  current: string;
  /** Newer build published on the server, if any. */
  update: AppVersionResponse | null;
  /** Open the APK URL — Android downloads it and offers to install. */
  download: () => void;
}

/**
 * Self-update check against the server's /api/app/version (an APK published
 * to `<dataDir>/app/` by infrastructure/packs/publish-apk.sh). Visible only
 * when the server has a build with a higher versionCode than this install.
 */
export function useAppUpdate(): AppUpdateState {
  const serverOrigin = useServerOrigin();
  const [update, setUpdate] = useState<AppVersionResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${serverOrigin}/api/app/version`, { signal: AbortSignal.timeout(5000) })
      .then((res) => (res.ok ? (res.json() as Promise<AppVersionResponse>) : null))
      .then((info) => {
        if (cancelled || !info) return;
        const installed = Number(Application.nativeBuildVersion ?? '0');
        if (info.versionCode > installed) setUpdate(info);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [serverOrigin]);

  const download = useCallback(() => {
    if (update) void Linking.openURL(`${serverOrigin}${update.apkUrl}`);
  }, [update, serverOrigin]);

  return {
    current: `${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`,
    update,
    download,
  };
}
