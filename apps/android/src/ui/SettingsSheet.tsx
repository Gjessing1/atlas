import { fmtClock, MAX_NAV_WIDGETS, NAV_WIDGETS, type RegionPackManifest } from '@atlas/core';
import type { AtlasStorage } from '@atlas/storage';
import {
  groupUpstreams,
  UPSTREAM_HEALTH_LABEL,
  upstreamDetail,
  useStatus,
  type MapStyleEditorController,
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
import type { LocalPack } from '../regions/packs';
import { deletePack, downloadPack, fetchAvailableRegions } from '../regions/packs';
import { closeEngine } from '../routing/offlineRouting';
import { defaultServerOrigin, setServerOrigin, useServerOrigin } from '../serverOrigin';
import type { SyncState } from '../sync/useSync';
import { useAppUpdate } from '../update/useAppUpdate';
import { JS_VERSION, useOtaUpdate } from '../update/useOtaUpdate';
import { BottomSheet } from './BottomSheet';
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

  if (sync.available === false) {
    return <Text style={styles.muted}>{STATUS_LABEL.unavailable}.</Text>;
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
  onDrawRegion,
}: {
  packs: LocalPack[];
  onPacksChanged: () => void;
  jobs: RegionPackJobsController;
  onDrawRegion: () => void;
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
      setRegionsError(null);
      try {
        // Updating an installed pack replaces files the routing engine may
        // hold open (mmap) — release it first, same as on delete. A failed
        // close would leave the old files pinned, so it must surface too.
        await closeEngine();
        await downloadPack(manifest, (fraction) =>
          setProgress((p) => ({ ...p, [manifest.id]: fraction })),
        );
      } catch (err) {
        setRegionsError(
          `Download of ${manifest.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
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
      setRegionsError(null);
      try {
        // The routing engine may hold this pack's tile extract open (mmap) —
        // release it before deleting the files under it.
        await closeEngine();
        await deletePack(id);
      } catch (err) {
        setRegionsError(
          `Deleting the pack failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      onPacksChanged();
    },
    [onPacksChanged],
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
        const active = progress[region.id];
        return (
          <View key={region.id} style={styles.regionRow}>
            <View style={styles.regionInfo}>
              <Text style={styles.rowText}>{region.name}</Text>
              <Text style={styles.muted}>
                {mb(totalBytes)}
                {region.custom ? ' · custom' : ''}
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
        A small cloud icon above the scale bar while the map draws from downloaded tiles.
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
    <View style={styles.styleColorRow}>
      <Text style={styles.rowText}>{label}</Text>
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
      <Text style={styles.muted}>
        Enter #RRGGBB colours, or leave a field empty for the Atlas default.
      </Text>
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
  navPrefs,
  regionJobs,
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
  navPrefs: NavPrefsController;
  regionJobs: RegionPackJobsController;
  /** Close Settings and let the user select two corners on the map. */
  onDrawRegion: () => void;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="settings-sheet"
    >
      <ScrollView style={styles.scroll}>
        <Text style={styles.heading}>Appearance</Text>
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
        <Text style={styles.heading}>Account</Text>
        <AccountSection sync={sync} />
        <Text style={styles.heading}>Map tiles</Text>
        <TilesSection tiles={tiles} />
        <Text style={styles.heading}>Offline regions</Text>
        <RegionsSection
          packs={packs}
          onPacksChanged={onPacksChanged}
          jobs={regionJobs}
          onDrawRegion={onDrawRegion}
        />
        <Text style={styles.heading}>Server</Text>
        <ServerSection storage={storage} />
        <Text style={styles.heading}>Server status</Text>
        <StatusSection visible={visible} />
        <Text style={styles.heading}>App</Text>
        <UpdateSection />
        <Text style={styles.heading}>Your data</Text>
        <Text style={styles.muted}>Export everything (places, folders, tracks) as a file.</Text>
        <View style={styles.buttonRow}>
          <Pressable style={styles.button} onPress={onExportAll} testID="export-all">
            <Text style={styles.buttonText}>Export all data</Text>
          </Pressable>
        </View>
      </ScrollView>
      <Pressable
        style={[styles.button, styles.closeButton]}
        onPress={onClose}
        testID="settings-close"
      >
        <Text style={styles.buttonText}>Close</Text>
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
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
  styleColorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 8,
  },
  styleColorInput: { width: 132, marginBottom: 0, fontFamily: 'monospace' },
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
