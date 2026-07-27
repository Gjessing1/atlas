import {
  groupUpstreams,
  UPSTREAM_HEALTH_LABEL,
  upstreamDetail,
  useStatus,
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
  onClose: () => void;
}

type SettingsTab = 'map' | 'profiles' | 'navigation' | 'account' | 'system';

const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'account', label: 'Account' },
  { id: 'system', label: 'System' },
];

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
      <span className="status-detail">{upstreamDetail(s)}</span>
    </li>
  );
}

function StatusSection({ data }: { data: SystemStatus }) {
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
  onClose,
}: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>('map');
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
            key={item.id}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="settings-tab-body">
        {tab === 'map' && (
          <>
            <div className="settings-section">
              <h3>Appearance</h3>
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
            <div className="settings-section">
              <LayersPanel layers={layers} mapZoom={mapZoom} />
            </div>
          </>
        )}

        {tab === 'profiles' && (
          <div className="settings-section">
            <ProfileSettings preferences={profilePreferences} layers={layers} />
          </div>
        )}

        {tab === 'navigation' && (
          <div className="settings-section">
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
            {status.data && <StatusSection data={status.data} />}
            <p className="settings-note">
              Checks reflect real usage: a source stays “not checked” until the app has used it this
              session.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
