import {
  groupUpstreams,
  sweepSummary,
  UPSTREAM_HEALTH_LABEL,
  upstreamDetail,
  useStatus,
  type StatusState,
  type MapProfilePreferencesController,
  type MapStyleEditorController,
  type NavPrefsController,
  type StorageAvailability,
  type ThemeModeController,
} from '@atlas/app-hooks';
import {
  layersForProfile,
  MAP_PROFILES,
  MAX_NAV_WIDGETS,
  NAV_WIDGETS,
  settingsSectionsFor,
  type SettingsSectionId,
  type SystemStatus,
  type UpstreamStatus,
} from '@atlas/core';
import { useState } from 'react';
import { mapProfileIcon } from '../icons.js';
import { LayersPanel } from '../layers/LayersPanel.js';
import type { LayerCatalog } from '../layers/useLayerCatalog.js';
import { AccountPanel } from '../sync/AccountPanel.js';
import type { SyncState } from '../sync/useSync.js';

interface SettingsPanelProps {
  sync: SyncState;
  /** Whether the local database is open — sign-in cannot work without it. */
  storage: StorageAvailability;
  appearance: ThemeModeController;
  mapStyle: MapStyleEditorController;
  navPrefs: NavPrefsController;
  layers: LayerCatalog;
  mapZoom: number;
  profilePreferences: MapProfilePreferencesController;
  /** Export everything (rule 5) — also offered on the Collections header. */
  onExportAll: () => void;
  onClose: () => void;
}

/**
 * The tabs, from the shared section list in `@atlas/core` — the same sections,
 * names and order Android drills into (ROADMAP §7.5). Map tiles and Offline
 * regions are filtered out there as Android-only, so this is the web six.
 */
const TABS = settingsSectionsFor('web');

const STYLE_COLORS = [
  ['landColor', 'Land', '#f5f3ee'],
  ['waterColor', 'Water', '#abc9dc'],
  ['roadColor', 'Roads', '#d49b5f'],
  ['pathColor', 'Paths & tracks', '#a94f4b'],
] as const;

function MapStyleSection({ editor }: { editor: MapStyleEditorController }) {
  return (
    <div className="map-style-editor">
      <div className="style-color-grid">
        {STYLE_COLORS.map(([key, label, fallback]) => {
          const custom = editor.value[key];
          return (
            <label className="style-color" key={key}>
              <span>{label}</span>
              <input
                type="color"
                value={custom ?? fallback}
                onChange={(event) => editor.setColor(key, event.target.value)}
                aria-label={`${label} color`}
              />
              {custom && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => editor.setColor(key, null)}
                >
                  Default
                </button>
              )}
            </label>
          );
        })}
      </div>
      <label className="style-range">
        <span>Label size</span>
        <input
          type="range"
          min={75}
          max={150}
          step={5}
          value={Math.round(editor.value.labelScale * 100)}
          onChange={(event) => editor.setLabelScale(Number(event.target.value) / 100)}
        />
        <output>{Math.round(editor.value.labelScale * 100)}%</output>
      </label>
      <label className="style-range">
        <span>Points of interest</span>
        <input
          type="range"
          min={50}
          max={150}
          step={5}
          value={Math.round(editor.value.poiScale * 100)}
          onChange={(event) => editor.setPoiScale(Number(event.target.value) / 100)}
        />
        <output>{Math.round(editor.value.poiScale * 100)}%</output>
      </label>
      <button type="button" className="link-button" onClick={editor.reset}>
        Reset map style
      </button>
      <p className="settings-note">
        Style edits stay on this device and apply to every activity profile.
      </p>
    </div>
  );
}

function ProfileSettings({
  preferences,
  layers,
}: {
  preferences: MapProfilePreferencesController;
  layers: LayerCatalog;
}) {
  return (
    <>
      <p className="settings-note settings-note-leading">
        Choose which activities appear in the map switcher and the layers each one prefers. Profile
        layouts sync with your account; quick layer changes stay on this device.
      </p>
      <div className="profile-settings-list">
        {MAP_PROFILES.map((profile) => {
          const Icon = mapProfileIcon(profile.id);
          const visible = preferences.value.visible.includes(profile.id);
          const onlyVisible = visible && preferences.value.visible.length === 1;
          const preferred = new Set(preferences.preferredLayers(profile.id));
          const offered = layersForProfile(layers.allCatalog, profile.id);
          return (
            <section className="profile-settings-card" key={profile.id}>
              <div className="profile-settings-head">
                <span className="profile-settings-name">
                  <Icon size={20} />
                  <strong>{profile.label}</strong>
                </span>
                <label className="profile-visible">
                  <input
                    type="checkbox"
                    checked={visible}
                    disabled={onlyVisible}
                    onChange={(event) => preferences.setVisible(profile.id, event.target.checked)}
                  />
                  Quick switcher
                </label>
              </div>
              {offered.length > 0 ? (
                <div className="profile-layer-options">
                  {offered.map((layer) => {
                    const on = preferred.has(layer.id);
                    return (
                      <label key={layer.id}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(event) => {
                            const next = new Set(preferred);
                            if (event.target.checked) next.add(layer.id);
                            else next.delete(layer.id);
                            preferences.setPreferredLayers(profile.id, [...next]);
                            // Match the device-local quick state to the newly
                            // chosen baseline immediately, including inactive profiles.
                            layers.setProfileOn(profile.id, layer.id, event.target.checked);
                          }}
                        />
                        {layer.title}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="settings-note">No overlay layers are available from this server.</p>
              )}
            </section>
          );
        })}
      </div>
      <button
        type="button"
        className="link-button"
        onClick={() => {
          for (const profile of MAP_PROFILES) {
            const defaults = new Set(profile.defaultLayers ?? []);
            for (const layer of layersForProfile(layers.allCatalog, profile.id)) {
              layers.setProfileOn(profile.id, layer.id, defaults.has(layer.id));
            }
          }
          preferences.reset();
        }}
      >
        Reset profile layout
      </button>
    </>
  );
}

/** One upstream row: coloured dot, label, and the most telling timestamp/message. */
function SourceRow({ s }: { s: UpstreamStatus }) {
  return (
    <li className="status-row">
      <span className={`status-dot status-${s.health}`} aria-hidden="true" />
      <span className="status-name" title={UPSTREAM_HEALTH_LABEL[s.health]}>
        {s.label}
      </span>
      <span className={`status-detail${s.warning ? ' status-detail-warning' : ''}`}>
        {upstreamDetail(s)}
      </span>
    </li>
  );
}

function StatusSection({ data, status }: { data: SystemStatus; status: StatusState }) {
  return (
    <>
      <div className="status-overall">
        <span className={`status-dot status-${data.overall}`} aria-hidden="true" />
        <span>{UPSTREAM_HEALTH_LABEL[data.overall]}</span>
        <span className="status-sha" title="Backend build">
          {data.gitSha === 'dev' ? 'dev build' : data.gitSha.slice(0, 8)}
        </span>
      </div>
      {groupUpstreams(data.sources).map(([group, sources]) => (
        <div key={group} className="status-group">
          <div className="status-group-name">{group}</div>
          <ul className="status-list">
            {sources.map((s) => (
              <SourceRow key={s.id} s={s} />
            ))}
          </ul>
        </div>
      ))}
      <p className="settings-note">{sweepSummary(data)}</p>
      {/*
        Re-probing spends requests on national services that owe us nothing, so
        it stays an explicit button — the page itself only ever reads what the
        server already knows.
      */}
      <button
        type="button"
        className="link-button"
        disabled={status.checking}
        onClick={status.check}
      >
        {status.checking ? 'Checking upstreams…' : 'Re-check every upstream now'}
      </button>
    </>
  );
}

/** Settings grouped by task so map, profile, navigation and account controls do not mix. */
export function SettingsPanel({
  sync,
  storage,
  appearance,
  mapStyle,
  navPrefs,
  layers,
  mapZoom,
  profilePreferences,
  onExportAll,
  onClose,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsSectionId>('appearance');
  // Do not wake every upstream status row until the user opens System.
  const status = useStatus('', tab === 'system');

  return (
    <aside className="settings-panel" aria-label="Settings">
      <div className="settings-header">
        <strong>Settings</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>
      <div className="settings-tabs" role="tablist" aria-label="Settings areas">
        {TABS.map((item) => (
          <button
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'settings-tab settings-tab-on' : 'settings-tab'}
            onClick={() => setTab(item.id)}
            title={item.hint}
            key={item.id}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="settings-tab-body">
        {tab === 'appearance' && (
          <>
            <div className="settings-section">
              <h3>Theme</h3>
              <div className="theme-options" role="radiogroup" aria-label="Theme">
                {(['system', 'light', 'dark'] as const).map((mode) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={appearance.mode === mode}
                    className={
                      appearance.mode === mode ? 'theme-option theme-option-on' : 'theme-option'
                    }
                    onClick={() => appearance.setMode(mode)}
                    key={mode}
                  >
                    {mode[0]!.toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>
              <p className="settings-note">System follows this device’s light or dark setting.</p>
              <MapStyleSection editor={mapStyle} />
            </div>
          </>
        )}

        {tab === 'layers' && (
          <div className="settings-section">
            <LayersPanel layers={layers} mapZoom={mapZoom} />
          </div>
        )}

        {tab === 'profiles' && (
          <div className="settings-section">
            <ProfileSettings preferences={profilePreferences} layers={layers} />
          </div>
        )}

        {tab === 'navigation' && (
          <div className="settings-section">
            <h3>Direction arrow</h3>
            <div className="theme-options" role="radiogroup" aria-label="Direction arrow source">
              {(
                [
                  ['auto', 'Auto'],
                  ['compass', 'Compass'],
                  ['gps', 'GPS course'],
                ] as const
              ).map(([source, label]) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={navPrefs.headingSource === source}
                  className={
                    navPrefs.headingSource === source
                      ? 'theme-option theme-option-on'
                      : 'theme-option'
                  }
                  onClick={() => navPrefs.setHeadingSource(source)}
                  key={source}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="settings-note">
              Auto uses the compass while still and the steadier travel course once moving.
            </p>
            <h3>Navigation widgets</h3>
            <div
              className="theme-options nav-widget-options"
              role="group"
              aria-label="Navigation widgets"
            >
              {NAV_WIDGETS.map((widget) => {
                const selected = navPrefs.widgets.includes(widget.id);
                const full = navPrefs.widgets.length >= MAX_NAV_WIDGETS;
                return (
                  <button
                    type="button"
                    aria-pressed={selected}
                    className={selected ? 'theme-option theme-option-on' : 'theme-option'}
                    disabled={!selected && full}
                    onClick={() => navPrefs.toggleWidget(widget.id)}
                    key={widget.id}
                  >
                    {widget.label}
                  </button>
                );
              })}
            </div>
            <p className="settings-note">Choose up to three readouts for active guidance.</p>
          </div>
        )}

        {tab === 'account' && (
          <div className="settings-section">
            <h3>Account &amp; sync</h3>
            <AccountPanel sync={sync} storage={storage} />
            {/* Also on the Collections header. Two homes on purpose: Android
                keeps it here, and a user who learned it there should find it
                here too (rule 5 is about the data, not one route to it). */}
            <h3>Your data</h3>
            <p className="settings-note">
              Export everything — places, folders, tracks and settings — as a file.
            </p>
            <button type="button" onClick={onExportAll} disabled={storage.status !== 'ready'}>
              Export all data
            </button>
          </div>
        )}

        {tab === 'system' && (
          <div className="settings-section">
            <div className="settings-section-head">
              <h3>Server status</h3>
              <button
                type="button"
                className="link-button"
                onClick={status.refresh}
                disabled={status.loading}
              >
                {status.loading ? 'Checking…' : 'Refresh'}
              </button>
            </div>
            {status.error && !status.data && (
              <p className="settings-note settings-error">Status unavailable — {status.error}.</p>
            )}
            {!status.data && !status.error && <p className="settings-note">Loading…</p>}
            {status.data && <StatusSection data={status.data} status={status} />}
            <p className="settings-note">
              The server checks every data source by itself a few times a day, and also learns from
              what the app actually uses. A source stays “not checked” until one of the two has
              reached it.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
