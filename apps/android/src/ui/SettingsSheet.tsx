import {
  fmtClock,
  layersForProfile,
  MAP_PROFILES,
  MAX_NAV_WIDGETS,
  NAV_WIDGETS,
  type RegionPackManifest,
} from '@atlas/core';
import type { AtlasStorage } from '@atlas/storage';
import {
  groupUpstreams,
  UPSTREAM_HEALTH_LABEL,
  upstreamDetail,
  useStatus,
  type MapStyleEditorController,
  type MapProfilePreferencesController,
  type NavPrefsController,
  type RegionPackJobsController,
  type ThemeModeController,
} from '@atlas/app-hooks';
import type { UpstreamHealth } from '@atlas/core';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { TileSource } from '../map/useTileSource';
import type { OverlaysController } from '../layers/useOverlays';
import { packJobAction, packJobLabel } from '../regions/downloads';
import type { LocalPack } from '../regions/packs';
import { deletePack, fetchAvailableRegions } from '../regions/packs';
import type { NavPipController } from '../nav/useNavigationPip';
import type { OfflinePrefsController } from '../regions/useOfflinePrefs';
import type { PackDownloadsController } from '../regions/usePackDownloads';
import { closeEngine } from '../routing/offlineRouting';
import { defaultServerOrigin, setServerOrigin, useServerOrigin } from '../serverOrigin';
import type { SyncState } from '../sync/useSync';
import { useAppUpdate } from '../update/useAppUpdate';
import { JS_VERSION, useOtaUpdate } from '../update/useOtaUpdate';
import { BottomSheet } from './BottomSheet';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';
import { LayersContent } from './LayersSheet';
import { MAP_PROFILE_ICON } from './modeIcons';
import { theme } from './theme';

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

  if (sync.availability === 'disabled') {
    return <Text style={styles.muted}>{STATUS_LABEL.unavailable}.</Text>;
  }
  // Unknown is not "unavailable": the probe failed (offline, timeout, server
  // hiccup) and keeps retrying — offer a retry instead of a false verdict.
  // A signed-in session still works normally, so only signed-out shows it.
  if (sync.availability === 'unreachable' && !sync.email) {
    return (
      <View>
        <Text style={styles.muted}>Couldn’t reach the server to check sync availability.</Text>
        <View style={styles.buttonRow}>
          <Pressable style={styles.button} onPress={sync.retryProbe}>
            <Text style={styles.buttonText}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  if (sync.email) {
    return (
      <View>
        <Text style={styles.rowText}>{sync.email}</Text>
        <Text style={styles.muted}>
          {STATUS_LABEL[sync.status]}
          {sync.lastSyncAt ? ` · ${fmtClock(sync.lastSyncAt)}` : ''}
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
          disabled={busy || !sync.ready}
          onPress={() => void submit('login')}
          testID="account-signin"
        >
          <Text style={styles.buttonText}>Sign in</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.buttonQuiet]}
          disabled={busy || !sync.ready}
          onPress={() => void submit('register')}
          testID="account-register"
        >
          <Text style={styles.buttonQuietText}>Register</Text>
        </Pressable>
        {busy ? <ActivityIndicator /> : null}
      </View>
      {!sync.ready ? <Text style={styles.muted}>Opening local storage…</Text> : null}
    </View>
  );
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function RegionsSection({
  packs,
  onPacksChanged,
  jobs,
  downloads,
  offlinePrefs,
  onDrawRegion,
}: {
  packs: LocalPack[];
  onPacksChanged: () => void;
  jobs: RegionPackJobsController;
  downloads: PackDownloadsController;
  offlinePrefs: OfflinePrefsController;
  onDrawRegion: () => void;
}) {
  const [regions, setRegions] = useState<RegionPackManifest[] | null>(null);
  const [regionsError, setRegionsError] = useState<string | null>(null);

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

  const remove = useCallback(
    async (id: string) => {
      setRegionsError(null);
      try {
        // A download still running for this pack would keep writing into the
        // staging directory we are about to remove.
        downloads.cancel(id);
        // The routing engine may hold this pack's tile extract open (mmap) —
        // release it before deleting the files under it.
        await closeEngine();
        await deletePack(id);
        downloads.dismiss(id);
      } catch (err) {
        setRegionsError(
          `Deleting the pack failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      onPacksChanged();
    },
    [onPacksChanged, downloads],
  );

  const local = new Map(packs.map((p) => [p.manifest.id, p]));
  const rowsById = new Map<string, RegionPackManifest>();
  for (const region of regions ?? []) rowsById.set(region.id, region);
  for (const job of jobs.jobs) {
    if (job.manifest) rowsById.set(job.manifest.id, job.manifest);
  }
  // Keep installed custom packs manageable after their temporary server
  // artifact and job history expire.
  for (const pack of packs) {
    if (!rowsById.has(pack.manifest.id)) rowsById.set(pack.manifest.id, pack.manifest);
  }
  const rows = [...rowsById.values()];
  const pendingJobs = jobs.jobs.filter((job) => !job.manifest);
  const activeDownloads = new Map(downloads.jobs.map((job) => [job.id, job]));

  return (
    <View>
      <Text style={styles.muted}>
        Draw any rectangle on the map. Atlas extracts its map tiles in the background and adds
        routing and search from the smallest published region that fully contains it.
      </Text>
      <View style={styles.buttonRow}>
        <Pressable style={styles.button} onPress={onDrawRegion} testID="region-draw">
          <Text style={styles.buttonText}>Draw custom region</Text>
        </Pressable>
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.rowText}>Auto-update on Wi-Fi</Text>
        <Switch
          value={offlinePrefs.autoUpdate}
          onValueChange={offlinePrefs.setAutoUpdate}
          testID="region-auto-update"
        />
      </View>
      <Text style={styles.muted}>
        Downloads keep running when you leave Atlas, and continue where they stopped if the
        connection drops. Rebuilt regions are fetched again automatically over Wi-Fi.
      </Text>
      {regionsError ? <Text style={styles.muted}>{regionsError}</Text> : null}
      {jobs.error ? <Text style={styles.error}>{jobs.error}</Text> : null}
      {pendingJobs.map((job) => (
        <View key={job.id} style={styles.regionRow}>
          <View style={styles.regionInfo}>
            <Text style={styles.rowText}>{job.name}</Text>
            <Text style={job.status === 'failed' ? styles.error : styles.muted}>
              {job.status === 'failed' ? job.error || job.detail : job.detail}
            </Text>
          </View>
          {job.status === 'failed' ? (
            <Text style={styles.error}>Failed</Text>
          ) : (
            <Text style={styles.rowText}>{Math.round(job.progress * 100)}%</Text>
          )}
        </View>
      ))}
      {rows.length === 0 && pendingJobs.length === 0 && !regionsError ? (
        <Text style={styles.muted}>{regions === null ? 'Loading…' : 'No regions published.'}</Text>
      ) : null}
      {rows.map((region) => {
        const totalBytes = Object.values(region.files).reduce((s, f) => s + (f?.bytes ?? 0), 0);
        const installed = local.get(region.id);
        const active = activeDownloads.get(region.id);
        const action = active ? packJobAction(active) : null;
        return (
          <View key={region.id} style={styles.regionRow}>
            <View style={styles.regionInfo}>
              <Text style={styles.rowText}>{region.name}</Text>
              <Text style={active?.phase === 'failed' ? styles.error : styles.muted}>
                {active
                  ? packJobLabel(active)
                  : `${mb(totalBytes)}${region.custom ? ' · custom' : ''}${
                      installed
                        ? installed.manifest.version < region.version
                          ? ' · update available'
                          : ' · downloaded'
                        : ''
                    }`}
              </Text>
            </View>
            {active ? (
              action === null ? (
                <ActivityIndicator />
              ) : (
                <Pressable
                  style={[styles.button, action === 'cancel' && styles.buttonQuiet]}
                  onPress={() =>
                    action === 'cancel' ? downloads.cancel(region.id) : downloads.start(region)
                  }
                  testID={`region-${action}-${region.id}`}
                >
                  <Text style={action === 'cancel' ? styles.buttonQuietText : styles.buttonText}>
                    {action === 'cancel' ? 'Cancel' : action === 'resume' ? 'Resume' : 'Retry'}
                  </Text>
                </Pressable>
              )
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
                onPress={() => downloads.start(region)}
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

function ServerSection({ storage }: { storage: AtlasStorage | null }) {
  const origin = useServerOrigin();
  const [draft, setDraft] = useState(origin);
  const [message, setMessage] = useState<string | null>(null);

  // Keep the field in step with the live origin when it isn't being edited
  // (e.g. after hydration, or a reset).
  useEffect(() => {
    setDraft(origin);
  }, [origin]);

  const save = useCallback(async () => {
    if (!storage) return;
    const problem = await setServerOrigin(storage, draft);
    setMessage(problem ?? 'Saved — reconnecting to the new server.');
  }, [storage, draft]);

  const reset = useCallback(async () => {
    if (!storage) return;
    await setServerOrigin(storage, '');
    setMessage('Reset to the default server.');
  }, [storage]);

  const dirty = draft.trim().replace(/\/+$/, '') !== origin;
  const isDefault = origin === defaultServerOrigin();

  return (
    <View>
      <TextInput
        style={styles.input}
        placeholder={defaultServerOrigin()}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        value={draft}
        onChangeText={(t) => {
          setDraft(t);
          setMessage(null);
        }}
        testID="server-origin"
      />
      {message ? <Text style={styles.muted}>{message}</Text> : null}
      <View style={styles.buttonRow}>
        <Pressable
          style={[styles.button, !storage || !dirty ? styles.buttonDisabled : null]}
          disabled={!storage || !dirty}
          onPress={() => void save()}
          testID="server-save"
        >
          <Text style={styles.buttonText}>Save</Text>
        </Pressable>
        {!isDefault ? (
          <Pressable
            style={[styles.button, styles.buttonQuiet]}
            disabled={!storage}
            onPress={() => void reset()}
            testID="server-reset"
          >
            <Text style={styles.buttonQuietText}>Reset to default</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** The dot's colour per health level — same five words the web panel uses. */
const HEALTH_COLOR: Record<UpstreamHealth, string> = {
  ok: '#3faa63',
  degraded: theme.warning,
  down: theme.danger,
  unknown: theme.icon,
};

/**
 * Server & upstream health (web parity, §5 N7). The phone talks to the same
 * upstreams as the browser and fails just as silently, so it gets the same
 * answer to "is it me, the server, or Kartverket?" — fetched only while the
 * sheet is open.
 */
function StatusSection({ visible }: { visible: boolean }) {
  const origin = useServerOrigin();
  const status = useStatus(origin, visible);

  return (
    <View>
      <View style={styles.buttonRow}>
        <Pressable
          style={[styles.button, styles.buttonQuiet, status.loading && styles.buttonDisabled]}
          disabled={status.loading}
          onPress={status.refresh}
          testID="status-refresh"
        >
          <Text style={styles.buttonQuietText}>{status.loading ? 'Checking…' : 'Refresh'}</Text>
        </Pressable>
        {status.data ? (
          <View style={styles.statusOverall}>
            <View
              style={[styles.statusDot, { backgroundColor: HEALTH_COLOR[status.data.overall] }]}
            />
            <Text style={styles.rowText}>{UPSTREAM_HEALTH_LABEL[status.data.overall]}</Text>
          </View>
        ) : null}
      </View>
      {status.error && !status.data ? (
        <Text style={styles.error}>Status unavailable — {status.error}.</Text>
      ) : null}
      {!status.data && !status.error ? <Text style={styles.muted}>Loading…</Text> : null}
      {status.data
        ? groupUpstreams(status.data.sources).map(([group, sources]) => (
            <View key={group} style={styles.statusGroup}>
              <Text style={styles.statusGroupName}>{group}</Text>
              {sources.map((source) => (
                <View key={source.id} style={styles.statusRow} testID={`status-${source.id}`}>
                  <View
                    style={[styles.statusDot, { backgroundColor: HEALTH_COLOR[source.health] }]}
                  />
                  <Text style={styles.statusName} numberOfLines={1}>
                    {source.label}
                  </Text>
                  <Text style={styles.statusDetail} numberOfLines={2}>
                    {upstreamDetail(source)}
                  </Text>
                </View>
              ))}
            </View>
          ))
        : null}
      {status.data ? (
        <Text style={styles.muted}>
          Backend build {status.data.gitSha === 'dev' ? 'dev' : status.data.gitSha.slice(0, 8)}.
          Checks reflect real usage: a source stays “not checked” until the app has used it.
        </Text>
      ) : null}
    </View>
  );
}

function UpdateSection() {
  const { current, update, download } = useAppUpdate();
  const ota = useOtaUpdate();
  return (
    <View>
      <Text style={styles.muted}>
        Version {JS_VERSION} · app binary {current}
      </Text>
      {update ? (
        // Full APK (native change on the server side — higher versionCode).
        <View style={styles.buttonRow}>
          <Pressable style={styles.button} onPress={download} testID="app-update-download">
            <Text style={styles.buttonText}>
              Update to {update.versionName} ({mb(update.bytes)})
            </Text>
          </Pressable>
        </View>
      ) : null}
      {ota.enabled ? (
        ota.status === 'ready' ? (
          <View style={styles.buttonRow}>
            <Pressable style={styles.button} onPress={ota.restart} testID="ota-restart-settings">
              <Text style={styles.buttonText}>Restart to finish update</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.buttonRow}>
            <Pressable
              style={[styles.button, styles.buttonQuiet]}
              disabled={ota.status === 'checking' || ota.status === 'downloading'}
              onPress={ota.check}
              testID="ota-check"
            >
              <Text style={styles.buttonQuietText}>
                {ota.status === 'checking'
                  ? 'Checking…'
                  : ota.status === 'downloading'
                    ? 'Downloading…'
                    : 'Check for updates'}
              </Text>
            </Pressable>
            {ota.status === 'uptodate' ? <Text style={styles.muted}>Up to date.</Text> : null}
            {ota.status === 'error' ? <Text style={styles.muted}>Check failed.</Text> : null}
          </View>
        )
      ) : !update ? (
        <Text style={styles.muted}>Up to date.</Text>
      ) : null}
    </View>
  );
}

/**
 * The tile source, stated plainly and with the one lever that changes it.
 * Downloaded tiles are the default wherever a pack reaches, so the switch is
 * the exception — for a pack the user knows has gone stale — not the everyday
 * control it used to be as a map-view toggle.
 */
function TilesSection({ tiles }: { tiles: TileSource }) {
  return (
    <View>
      <View style={styles.switchRow}>
        <Text style={styles.rowText}>Always stream map tiles</Text>
        <Switch
          value={tiles.preferOnline}
          onValueChange={tiles.setPreferOnline}
          testID="prefer-online-tiles"
        />
      </View>
      <Text style={styles.muted}>
        {tiles.preferOnline
          ? 'Tiles come from the server; downloaded regions are used only when it is unreachable.'
          : tiles.coveringPack
            ? `Drawing downloaded tiles from ${tiles.coveringPack.manifest.name}.`
            : 'Downloaded regions are used automatically wherever they cover the map.'}
      </Text>
      <View style={styles.switchRow}>
        <Text style={styles.rowText}>Show offline map badge</Text>
        <Switch
          value={tiles.showOfflineBadge}
          onValueChange={tiles.setShowOfflineBadge}
          testID="offline-badge-toggle"
        />
      </View>
      <Text style={styles.muted}>
        A small cloud icon beside map contributions while downloaded tiles are in use.
      </Text>
    </View>
  );
}

const STYLE_COLORS = [
  ['landColor', 'Land'],
  ['waterColor', 'Water'],
  ['roadColor', 'Roads'],
  ['pathColor', 'Paths & tracks'],
] as const;

const MAP_COLOR_SWATCHES = [
  '#f5f3ee',
  '#d8d2c4',
  '#abc9dc',
  '#65a9d0',
  '#d49b5f',
  '#a94f4b',
  '#e11d48',
  '#f97316',
  '#f59e0b',
  '#16a34a',
  '#0d9488',
  '#2563eb',
  '#7c3aed',
  '#475569',
  '#262b31',
  '#eef2f5',
] as const;

function StyleColorInput({
  editor,
  colorKey,
  label,
}: {
  editor: MapStyleEditorController;
  colorKey: (typeof STYLE_COLORS)[number][0];
  label: string;
}) {
  const current = editor.value[colorKey] ?? '';
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const commit = () => {
    const normalized = draft.trim().toLowerCase();
    if (normalized === '') editor.setColor(colorKey, null);
    else if (/^#[0-9a-f]{6}$/.test(normalized)) editor.setColor(colorKey, normalized);
    else setDraft(current);
  };
  return (
    <View style={styles.styleColorBlock}>
      <View style={styles.styleColorRow}>
        <Text style={styles.rowText}>{label}</Text>
        <View style={styles.styleColorValue}>
          <View
            style={[
              styles.styleColorPreview,
              { backgroundColor: current || MAP_COLOR_SWATCHES[0] },
            ]}
          />
          <TextInput
            style={[styles.input, styles.styleColorInput]}
            value={draft}
            onChangeText={setDraft}
            onEndEditing={commit}
            onSubmitEditing={commit}
            placeholder="Atlas default"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={7}
            testID={`style-${colorKey}`}
          />
        </View>
      </View>
      <View style={styles.mapColorPalette}>
        {MAP_COLOR_SWATCHES.map((candidate) => (
          <Pressable
            key={candidate}
            style={[
              styles.mapColorSwatch,
              { backgroundColor: candidate },
              current === candidate && styles.mapColorSwatchOn,
            ]}
            accessibilityRole="radio"
            accessibilityState={{ checked: current === candidate }}
            accessibilityLabel={`${label} ${candidate}`}
            onPress={() => editor.setColor(colorKey, candidate)}
            testID={`style-${colorKey}-${candidate}`}
          />
        ))}
        <Pressable
          style={[styles.mapColorDefault, !current && styles.mapColorDefaultOn]}
          onPress={() => editor.setColor(colorKey, null)}
          testID={`style-${colorKey}-default`}
        >
          <Text style={styles.mapColorDefaultText}>Default</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ScaleChoices({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: number;
  choices: number[];
  onChange: (value: number) => void;
}) {
  return (
    <View style={styles.styleScale}>
      <Text style={styles.rowText}>{label}</Text>
      <View style={styles.themeRow}>
        {choices.map((choice) => (
          <Pressable
            key={choice}
            style={[styles.styleScaleOption, value === choice && styles.themeOptionOn]}
            onPress={() => onChange(choice)}
          >
            <Text style={[styles.themeOptionText, value === choice && styles.themeOptionTextOn]}>
              {Math.round(choice * 100)}%
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function MapStyleSection({ editor }: { editor: MapStyleEditorController }) {
  return (
    <View>
      <Text style={styles.muted}>Pick a swatch or enter any #RRGGBB colour.</Text>
      {STYLE_COLORS.map(([key, label]) => (
        <StyleColorInput key={key} editor={editor} colorKey={key} label={label} />
      ))}
      <ScaleChoices
        label="Label size"
        value={editor.value.labelScale}
        choices={[0.75, 1, 1.25, 1.5]}
        onChange={editor.setLabelScale}
      />
      <ScaleChoices
        label="Points of interest"
        value={editor.value.poiScale}
        choices={[0.5, 1, 1.25, 1.5]}
        onChange={editor.setPoiScale}
      />
      <View style={styles.buttonRow}>
        <Pressable style={[styles.button, styles.buttonQuiet]} onPress={editor.reset}>
          <Text style={styles.buttonQuietText}>Reset map style</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ProfileSection({
  preferences,
  overlays,
}: {
  preferences: MapProfilePreferencesController;
  overlays: OverlaysController;
}) {
  return (
    <View>
      <Text style={styles.muted}>
        Choose the activities in the map switcher and the layers each one prefers. These choices
        sync with your account; quick layer changes stay on this device.
      </Text>
      {MAP_PROFILES.map((profile) => {
        const Icon = MAP_PROFILE_ICON[profile.id]!;
        const visible = preferences.value.visible.includes(profile.id);
        const onlyVisible = visible && preferences.value.visible.length === 1;
        const preferred = new Set(preferences.preferredLayers(profile.id));
        const offered = layersForProfile(overlays.allCatalog, profile.id);
        return (
          <View style={styles.profileCard} key={profile.id}>
            <View style={styles.profileHead}>
              <View style={styles.profileName}>
                <Icon color={theme.icon} size={21} />
                <Text style={styles.rowText}>{profile.label}</Text>
              </View>
              <View style={styles.profileVisible}>
                <Text style={styles.muted}>Quick switcher</Text>
                <Switch
                  value={visible}
                  disabled={onlyVisible}
                  onValueChange={(on) => preferences.setVisible(profile.id, on)}
                  testID={`profile-visible-${profile.id}`}
                />
              </View>
            </View>
            <View style={styles.profileLayers}>
              {offered.map((layer) => {
                const on = preferred.has(layer.id);
                return (
                  <Pressable
                    key={layer.id}
                    style={[styles.profileLayer, on && styles.profileLayerOn]}
                    onPress={() => {
                      const next = new Set(preferred);
                      if (on) next.delete(layer.id);
                      else next.add(layer.id);
                      preferences.setPreferredLayers(profile.id, [...next]);
                      overlays.setProfileOn(profile.id, layer.id, !on);
                    }}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    testID={`profile-layer-${profile.id}-${layer.id}`}
                  >
                    <Text style={[styles.themeOptionText, on && styles.themeOptionTextOn]}>
                      {on ? '✓ ' : ''}
                      {layer.title}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}
      <View style={styles.buttonRow}>
        <Pressable
          style={[styles.button, styles.buttonQuiet]}
          onPress={() => {
            for (const profile of MAP_PROFILES) {
              const defaults = new Set(profile.defaultLayers ?? []);
              for (const layer of layersForProfile(overlays.allCatalog, profile.id)) {
                overlays.setProfileOn(profile.id, layer.id, defaults.has(layer.id));
              }
            }
            preferences.reset();
          }}
        >
          <Text style={styles.buttonQuietText}>Reset profile layout</Text>
        </Pressable>
      </View>
    </View>
  );
}

type SettingsSection =
  'appearance' | 'layers' | 'tiles' | 'profiles' | 'navigation' | 'offline' | 'account' | 'system';

const SETTINGS_SECTIONS: readonly {
  id: SettingsSection;
  label: string;
  hint: string;
}[] = [
  { id: 'appearance', label: 'Appearance', hint: 'Theme, map colours and label sizes' },
  { id: 'layers', label: 'Map layers', hint: 'Overlays drawn on top of the map' },
  { id: 'tiles', label: 'Map tiles', hint: 'Streaming vs. downloaded basemap' },
  { id: 'profiles', label: 'Activity profiles', hint: 'Switcher activities and their layers' },
  { id: 'navigation', label: 'Navigation', hint: 'Readouts shown during guidance' },
  { id: 'offline', label: 'Offline regions', hint: 'Download maps for offline use' },
  { id: 'account', label: 'Account & data', hint: 'Sign in, sync and export' },
  { id: 'system', label: 'System', hint: 'Server, status and app updates' },
];

export function SettingsSheet({
  visible,
  onClose,
  sync,
  packs,
  onPacksChanged,
  storage,
  tiles,
  onExportAll,
  appearance,
  mapStyleEditor,
  overlays,
  profilePreferences,
  navPrefs,
  pip,
  regionJobs,
  downloads,
  offlinePrefs,
  onDrawRegion,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  sync: SyncState;
  packs: LocalPack[];
  onPacksChanged: () => void;
  storage: AtlasStorage | null;
  /** Which basemap tiles are being drawn, and the switch that forces streaming. */
  tiles: TileSource;
  /** Share the full user-data dump as a JSON file (rule 5: everything exportable). */
  onExportAll: () => void;
  appearance: ThemeModeController;
  mapStyleEditor: MapStyleEditorController;
  overlays: OverlaysController;
  profilePreferences: MapProfilePreferencesController;
  navPrefs: NavPrefsController;
  /** Whether guidance continues in a floating mini window when Atlas is left. */
  pip: NavPipController;
  regionJobs: RegionPackJobsController;
  /** Background pack downloads: progress, resume and cancel. */
  downloads: PackDownloadsController;
  offlinePrefs: OfflinePrefsController;
  /** Close Settings and let the user select two corners on the map. */
  onDrawRegion: () => void;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  const [section, setSection] = useState<SettingsSection | null>(null);
  const active = SETTINGS_SECTIONS.find((s) => s.id === section);
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="settings-sheet"
    >
      {active ? (
        <Pressable
          style={styles.sectionHeader}
          onPress={() => setSection(null)}
          accessibilityRole="button"
          accessibilityLabel="Back to settings menu"
          testID="settings-back"
        >
          <ChevronLeftIcon color={theme.accent} />
          <Text style={[styles.title, styles.headerTitle]}>{active.label}</Text>
        </Pressable>
      ) : (
        <Text style={styles.title}>Settings</Text>
      )}
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
        {section === null
          ? SETTINGS_SECTIONS.map((item) => (
              <Pressable
                key={item.id}
                style={styles.menuRow}
                onPress={() => setSection(item.id)}
                accessibilityRole="button"
                testID={`settings-open-${item.id}`}
              >
                <View style={styles.menuText}>
                  <Text style={styles.menuLabel}>{item.label}</Text>
                  <Text style={styles.menuHint}>{item.hint}</Text>
                </View>
                <ChevronRightIcon />
              </Pressable>
            ))
          : null}
        {section === 'appearance' ? (
          <>
            <Text style={styles.heading}>Theme</Text>
            <View style={styles.themeRow} accessibilityRole="radiogroup">
              {(['system', 'light', 'dark'] as const).map((mode) => (
                <Pressable
                  key={mode}
                  style={[styles.themeOption, appearance.mode === mode && styles.themeOptionOn]}
                  onPress={() => appearance.setMode(mode)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: appearance.mode === mode }}
                  testID={`theme-${mode}`}
                >
                  <Text
                    style={[
                      styles.themeOptionText,
                      appearance.mode === mode && styles.themeOptionTextOn,
                    ]}
                  >
                    {mode[0].toUpperCase() + mode.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.muted}>System follows this device’s light or dark setting.</Text>
            <Text style={styles.heading}>Map style</Text>
            <MapStyleSection editor={mapStyleEditor} />
          </>
        ) : null}
        {section === 'layers' ? <LayersContent overlays={overlays} /> : null}
        {section === 'tiles' ? <TilesSection tiles={tiles} /> : null}
        {section === 'profiles' ? (
          <ProfileSection preferences={profilePreferences} overlays={overlays} />
        ) : null}
        {section === 'navigation' ? (
          <>
            <Text style={styles.heading}>Navigation widgets</Text>
            <View style={styles.widgetOptions}>
              {NAV_WIDGETS.map((widget) => {
                const selected = navPrefs.widgets.includes(widget.id);
                return (
                  <Pressable
                    key={widget.id}
                    style={[styles.themeOption, selected && styles.themeOptionOn]}
                    disabled={!selected && navPrefs.widgets.length >= MAX_NAV_WIDGETS}
                    onPress={() => navPrefs.toggleWidget(widget.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{
                      checked: selected,
                      disabled: !selected && navPrefs.widgets.length >= MAX_NAV_WIDGETS,
                    }}
                    testID={`nav-widget-${widget.id}`}
                  >
                    <Text style={[styles.themeOptionText, selected && styles.themeOptionTextOn]}>
                      {widget.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.muted}>Choose up to three readouts for active guidance.</Text>
            <Text style={styles.heading}>Mini window</Text>
            <View style={styles.switchRow}>
              <Text style={styles.rowText}>Keep guiding when you leave Atlas</Text>
              <Switch
                value={pip.enabled && pip.available}
                onValueChange={pip.setEnabled}
                disabled={!pip.available}
                testID="nav-pip"
              />
            </View>
            <Text style={styles.muted}>
              {pip.blockedByUser
                ? 'Turned off for Atlas in Android settings — Apps → Atlas → Picture-in-picture.'
                : !pip.available
                  ? 'This device does not support picture-in-picture.'
                  : 'Pressing Home mid-trip shrinks Atlas into a floating window showing the next turn. Tap it to come back.'}
            </Text>
          </>
        ) : null}
        {section === 'offline' ? (
          <RegionsSection
            packs={packs}
            onPacksChanged={onPacksChanged}
            jobs={regionJobs}
            downloads={downloads}
            offlinePrefs={offlinePrefs}
            onDrawRegion={onDrawRegion}
          />
        ) : null}
        {section === 'account' ? (
          <>
            <Text style={styles.heading}>Account &amp; sync</Text>
            <AccountSection sync={sync} />
            <Text style={styles.heading}>Your data</Text>
            <Text style={styles.muted}>Export everything (places, folders, tracks) as a file.</Text>
            <View style={styles.buttonRow}>
              <Pressable style={styles.button} onPress={onExportAll} testID="export-all">
                <Text style={styles.buttonText}>Export all data</Text>
              </Pressable>
            </View>
          </>
        ) : null}
        {section === 'system' ? (
          <>
            <Text style={styles.heading}>Server</Text>
            <ServerSection storage={storage} />
            <Text style={styles.heading}>Server status</Text>
            <StatusSection visible={visible && section === 'system'} />
            <Text style={styles.heading}>App</Text>
            <UpdateSection />
          </>
        ) : null}
      </ScrollView>
      <Pressable
        style={[styles.button, styles.closeButton]}
        onPress={active ? () => setSection(null) : onClose}
        testID="settings-close"
      >
        <Text style={styles.buttonText}>{active ? 'Back' : 'Close'}</Text>
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  title: { fontSize: 18, fontWeight: '800', color: theme.text, marginBottom: 8 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: -6,
    marginBottom: 8,
  },
  headerTitle: { marginBottom: 0 },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  menuText: { flex: 1 },
  menuLabel: { fontSize: 16, fontWeight: '600', color: theme.text },
  menuHint: { fontSize: 13, color: theme.textMuted, marginTop: 2 },
  heading: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.textMuted,
    marginTop: 18,
    marginBottom: 8,
  },
  rowText: { fontSize: 16, color: theme.text },
  muted: { fontSize: 13, color: theme.textMuted, marginTop: 2 },
  error: { fontSize: 13, color: theme.danger, marginTop: 6 },
  input: {
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
    marginBottom: 8,
  },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 8, alignItems: 'center' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  button: {
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  buttonText: { color: theme.onAccent, fontWeight: '600' },
  buttonDisabled: { opacity: 0.5 },
  buttonQuiet: { backgroundColor: theme.surfaceMuted },
  buttonQuietText: { color: theme.text, fontWeight: '600' },
  themeRow: { flexDirection: 'row', gap: 6 },
  widgetOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  themeOption: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
  },
  themeOptionOn: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  themeOptionText: { color: theme.text, fontSize: 13, fontWeight: '600' },
  themeOptionTextOn: { color: theme.accent },
  styleColorBlock: { marginTop: 12, gap: 7 },
  styleColorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  styleColorValue: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  styleColorPreview: {
    width: 30,
    height: 30,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
  },
  styleColorInput: { width: 124, marginBottom: 0, fontFamily: 'monospace' },
  mapColorPalette: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  mapColorSwatch: {
    width: 30,
    height: 30,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.border,
  },
  mapColorSwatchOn: { borderWidth: 3, borderColor: theme.accent },
  mapColorDefault: {
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 9,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
  },
  mapColorDefaultOn: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  mapColorDefaultText: { fontSize: 12, fontWeight: '700', color: theme.text },
  styleScale: { gap: 6, marginTop: 12 },
  styleScaleOption: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
  },
  profileCard: {
    marginTop: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
  },
  profileHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  profileName: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  profileVisible: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  profileLayers: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  profileLayer: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
  },
  profileLayerOn: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  regionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  regionInfo: { flexShrink: 1, paddingRight: 10 },
  statusOverall: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusGroup: { marginTop: 12 },
  statusGroupName: { fontSize: 12, fontWeight: '700', color: theme.textMuted, marginBottom: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  statusName: { fontSize: 14, color: theme.text, fontWeight: '600' },
  statusDetail: { flex: 1, fontSize: 12, color: theme.textMuted, textAlign: 'right' },
  closeButton: { marginTop: 12, alignSelf: 'stretch', alignItems: 'center' },
});
