import type { RegionPackManifest } from '@atlas/core';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { LocalPack } from '../regions/packs';
import { deletePack, downloadPack, fetchAvailableRegions } from '../regions/packs';
import type { SyncState } from '../sync/useSync';
import { useAppUpdate } from '../update/useAppUpdate';

const STATUS_LABEL: Record<SyncState['status'], string> = {
  unavailable: 'Server has no accounts configured',
  signedOut: 'Signed out',
  idle: 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline — will retry',
  authExpired: 'Session expired',
  error: 'Sync error',
};

function AccountSection({ sync }: { sync: SyncState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = useCallback(
    async (mode: 'login' | 'register') => {
      setBusy(true);
      setMessage(null);
      const problem = await sync.signIn(email.trim(), password, mode);
      setBusy(false);
      setMessage(problem);
      if (!problem) setPassword('');
    },
    [sync, email, password],
  );

  if (sync.available === false) {
    return <Text style={styles.muted}>{STATUS_LABEL.unavailable}.</Text>;
  }
  if (sync.email) {
    return (
      <View>
        <Text style={styles.rowText}>{sync.email}</Text>
        <Text style={styles.muted}>
          {STATUS_LABEL[sync.status]}
          {sync.lastSyncAt ? ` · ${new Date(sync.lastSyncAt).toLocaleTimeString()}` : ''}
        </Text>
        {sync.error ? <Text style={styles.error}>{sync.error}</Text> : null}
        <View style={styles.buttonRow}>
          <Pressable style={styles.button} onPress={sync.syncNow} testID="sync-now">
            <Text style={styles.buttonText}>Sync now</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.buttonQuiet]} onPress={sync.signOut}>
            <Text style={styles.buttonQuietText}>Sign out</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  return (
    <View>
      <TextInput
        style={styles.input}
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        testID="account-email"
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        testID="account-password"
      />
      {message ? <Text style={styles.error}>{message}</Text> : null}
      <View style={styles.buttonRow}>
        <Pressable
          style={styles.button}
          disabled={busy}
          onPress={() => void submit('login')}
          testID="account-signin"
        >
          <Text style={styles.buttonText}>Sign in</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.buttonQuiet]}
          disabled={busy}
          onPress={() => void submit('register')}
          testID="account-register"
        >
          <Text style={styles.buttonQuietText}>Register</Text>
        </Pressable>
        {busy ? <ActivityIndicator /> : null}
      </View>
    </View>
  );
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function RegionsSection({
  packs,
  onPacksChanged,
}: {
  packs: LocalPack[];
  onPacksChanged: () => void;
}) {
  const [regions, setRegions] = useState<RegionPackManifest[] | null>(null);
  const [regionsError, setRegionsError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    fetchAvailableRegions()
      .then((r) => {
        if (!cancelled) setRegions(r);
      })
      .catch(() => {
        if (!cancelled) setRegionsError('Server unreachable — downloaded regions still work.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const download = useCallback(
    async (manifest: RegionPackManifest) => {
      setProgress((p) => ({ ...p, [manifest.id]: 0 }));
      try {
        await downloadPack(manifest, (fraction) =>
          setProgress((p) => ({ ...p, [manifest.id]: fraction })),
        );
      } catch (err) {
        setRegionsError(err instanceof Error ? err.message : String(err));
      } finally {
        setProgress((p) => {
          const { [manifest.id]: _done, ...rest } = p;
          return rest;
        });
        onPacksChanged();
      }
    },
    [onPacksChanged],
  );

  const remove = useCallback(
    async (id: string) => {
      await deletePack(id);
      onPacksChanged();
    },
    [onPacksChanged],
  );

  const local = new Map(packs.map((p) => [p.manifest.id, p]));
  const rows: RegionPackManifest[] = regions ?? packs.map((p) => p.manifest);

  return (
    <View>
      {regionsError ? <Text style={styles.muted}>{regionsError}</Text> : null}
      {rows.length === 0 && !regionsError ? (
        <Text style={styles.muted}>{regions === null ? 'Loading…' : 'No regions published.'}</Text>
      ) : null}
      {rows.map((region) => {
        const totalBytes = Object.values(region.files).reduce((s, f) => s + (f?.bytes ?? 0), 0);
        const installed = local.get(region.id);
        const active = progress[region.id];
        return (
          <View key={region.id} style={styles.regionRow}>
            <View style={styles.regionInfo}>
              <Text style={styles.rowText}>{region.name}</Text>
              <Text style={styles.muted}>
                {mb(totalBytes)}
                {installed
                  ? installed.manifest.version < region.version
                    ? ' · update available'
                    : ' · downloaded'
                  : ''}
              </Text>
            </View>
            {active !== undefined ? (
              <Text style={styles.rowText}>{Math.round(active * 100)}%</Text>
            ) : installed && installed.manifest.version >= region.version ? (
              <Pressable
                style={[styles.button, styles.buttonQuiet]}
                onPress={() => void remove(region.id)}
                testID={`region-delete-${region.id}`}
              >
                <Text style={styles.buttonQuietText}>Delete</Text>
              </Pressable>
            ) : (
              <Pressable
                style={styles.button}
                onPress={() => void download(region)}
                testID={`region-download-${region.id}`}
              >
                <Text style={styles.buttonText}>{installed ? 'Update' : 'Download'}</Text>
              </Pressable>
            )}
          </View>
        );
      })}
    </View>
  );
}

function UpdateSection() {
  const { current, update, download } = useAppUpdate();
  return (
    <View>
      <Text style={styles.muted}>Installed: {current}</Text>
      {update ? (
        <View style={styles.buttonRow}>
          <Pressable style={styles.button} onPress={download} testID="app-update-download">
            <Text style={styles.buttonText}>
              Update to {update.versionName} ({mb(update.bytes)})
            </Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.muted}>Up to date.</Text>
      )}
    </View>
  );
}

export function SettingsSheet({
  visible,
  onClose,
  sync,
  packs,
  onPacksChanged,
}: {
  visible: boolean;
  onClose: () => void;
  sync: SyncState;
  packs: LocalPack[];
  onPacksChanged: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView>
            <Text style={styles.heading}>Account</Text>
            <AccountSection sync={sync} />
            <Text style={styles.heading}>Offline regions</Text>
            <RegionsSection packs={packs} onPacksChanged={onPacksChanged} />
            <Text style={styles.heading}>App</Text>
            <UpdateSection />
          </ScrollView>
          <Pressable
            style={[styles.button, styles.closeButton]}
            onPress={onClose}
            testID="settings-close"
          >
            <Text style={styles.buttonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    maxHeight: '85%',
  },
  heading: { fontSize: 13, fontWeight: '700', color: '#667', marginTop: 18, marginBottom: 8 },
  rowText: { fontSize: 16, color: '#111' },
  muted: { fontSize: 13, color: '#778', marginTop: 2 },
  error: { fontSize: 13, color: '#b3261e', marginTop: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#ccd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    marginBottom: 8,
  },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 8, alignItems: 'center' },
  button: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  buttonText: { color: '#fff', fontWeight: '600' },
  buttonQuiet: { backgroundColor: '#eef1f6' },
  buttonQuietText: { color: '#334', fontWeight: '600' },
  regionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  regionInfo: { flexShrink: 1, paddingRight: 10 },
  closeButton: { marginTop: 12, alignSelf: 'stretch', alignItems: 'center' },
});
