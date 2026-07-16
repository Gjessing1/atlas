import type { AtlasStorage } from '@atlas/storage';
import * as Updates from 'expo-updates';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { JS_VERSION } from './useOtaUpdate';

const LAST_RUN_KEY = 'local.app.lastRunVersion';

/**
 * The two moments the user should notice an update, without going to Settings:
 *
 * - An OTA update downloaded in the background (launch-time ON_LOAD check):
 *   green "tap to restart" pill — one tap applies it.
 * - First launch on a new version (OTA or APK): a "what's new" toast naming
 *   the version, auto-dismissing. Tracked in a local-only setting so it shows
 *   once per version per device.
 */
export function UpdateNotices({
  storage,
  topInset,
}: {
  storage: AtlasStorage | null;
  topInset: number;
}) {
  const { isUpdatePending } = Updates.useUpdates();
  const [updatedFrom, setUpdatedFrom] = useState<string | null>(null);

  useEffect(() => {
    if (!storage) return;
    let cancelled = false;
    void (async () => {
      const last = await storage.getSetting(LAST_RUN_KEY);
      if (last === JS_VERSION) return;
      if (last && !cancelled) setUpdatedFrom(last);
      await storage.setSetting(LAST_RUN_KEY, JS_VERSION);
    })();
    return () => {
      cancelled = true;
    };
  }, [storage]);

  useEffect(() => {
    if (!updatedFrom) return;
    const timer = setTimeout(() => setUpdatedFrom(null), 8000);
    return () => clearTimeout(timer);
  }, [updatedFrom]);

  if (isUpdatePending) {
    return (
      <Pressable
        style={[styles.notice, styles.restart, { top: topInset + 60 }]}
        onPress={() => void Updates.reloadAsync()}
        testID="ota-restart"
      >
        <Text style={styles.noticeText}>Update ready — tap to restart</Text>
      </Pressable>
    );
  }
  if (updatedFrom) {
    return (
      <Pressable
        style={[styles.notice, { top: topInset + 60 }]}
        onPress={() => setUpdatedFrom(null)}
        testID="ota-updated"
      >
        <Text style={styles.noticeText}>Atlas updated to v{JS_VERSION}</Text>
      </Pressable>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  notice: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(20, 90, 50, 0.92)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
    elevation: 4,
  },
  restart: {
    backgroundColor: 'rgba(11, 110, 153, 0.95)',
  },
  noticeText: {
    color: '#fff',
    fontWeight: '600',
  },
});
