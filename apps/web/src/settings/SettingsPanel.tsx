import {
  groupUpstreams,
  UPSTREAM_HEALTH_LABEL,
  upstreamDetail,
  useStatus,
  type ThemeModeController,
} from '@atlas/app-hooks';
import type { SystemStatus, UpstreamStatus } from '@atlas/core';
import { AccountPanel } from '../sync/AccountPanel.js';
import type { SyncState } from '../sync/useSync.js';

interface SettingsPanelProps {
  sync: SyncState;
  appearance: ThemeModeController;
  onClose: () => void;
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

/**
 * Dedicated Settings home: server/upstream status (§N7), the account/sync
 * panel (moved out of the Collections sidebar footer), and build info. The status
 * answers "why is this overlay blank?" without leaving the app.
 */
export function SettingsPanel({ sync, appearance, onClose }: SettingsPanelProps) {
  // Served by the backend itself, so status lives at a relative path.
  const status = useStatus('', true);

  return (
    <aside className="settings-panel" aria-label="Settings">
      <div className="settings-header">
        <strong>Settings</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </div>

      <div className="settings-section">
        <h3>Appearance</h3>
        <div className="theme-options" role="radiogroup" aria-label="Theme">
          {(['system', 'light', 'dark'] as const).map((mode) => (
            <button
              type="button"
              role="radio"
              aria-checked={appearance.mode === mode}
              className={appearance.mode === mode ? 'theme-option theme-option-on' : 'theme-option'}
              onClick={() => appearance.setMode(mode)}
              key={mode}
            >
              {mode[0]!.toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
        <p className="settings-note">System follows this device’s light or dark setting.</p>
      </div>

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

      <div className="settings-section">
        <h3>Account &amp; sync</h3>
        <AccountPanel sync={sync} />
      </div>
    </aside>
  );
}
