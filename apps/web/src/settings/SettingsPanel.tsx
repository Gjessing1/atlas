import type { SystemStatus, UpstreamHealth, UpstreamStatus } from '@atlas/core';
import { AccountPanel } from '../sync/AccountPanel.js';
import type { SyncState } from '../sync/useSync.js';
import { useStatus } from './useStatus.js';

interface SettingsPanelProps {
  sync: SyncState;
  onClose: () => void;
}

const HEALTH_LABEL: Record<UpstreamHealth, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Not checked yet',
};

const relTime = (ts: number): string => {
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

/** One upstream row: coloured dot, label, and the most telling timestamp/message. */
function SourceRow({ s }: { s: UpstreamStatus }) {
  const detail =
    s.health === 'ok' || s.health === 'unknown'
      ? (s.detail ?? (s.lastSuccess ? `checked ${relTime(s.lastSuccess)}` : 'awaiting first use'))
      : // failing: lead with what went wrong and when
        `${s.message ?? 'failing'} · ${s.lastFailure ? relTime(s.lastFailure) : ''}`.trim();
  return (
    <li className="status-row">
      <span className={`status-dot status-${s.health}`} aria-hidden="true" />
      <span className="status-name" title={HEALTH_LABEL[s.health]}>
        {s.label}
      </span>
      <span className="status-detail">{detail}</span>
    </li>
  );
}

/** Sources grouped by their `group` field, in first-seen order. */
function groupSources(sources: UpstreamStatus[]): [string, UpstreamStatus[]][] {
  const groups = new Map<string, UpstreamStatus[]>();
  for (const s of sources) {
    const list = groups.get(s.group) ?? [];
    list.push(s);
    groups.set(s.group, list);
  }
  return [...groups.entries()];
}

function StatusSection({ data }: { data: SystemStatus }) {
  return (
    <>
      <div className="status-overall">
        <span className={`status-dot status-${data.overall}`} aria-hidden="true" />
        <span>{HEALTH_LABEL[data.overall]}</span>
        <span className="status-sha" title="Backend build">
          {data.gitSha === 'dev' ? 'dev build' : data.gitSha.slice(0, 8)}
        </span>
      </div>
      {groupSources(data.sources).map(([group, sources]) => (
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
 * panel (moved out of the Saved sidebar footer), and build info. The status
 * answers "why is this overlay blank?" without leaving the app.
 */
export function SettingsPanel({ sync, onClose }: SettingsPanelProps) {
  const status = useStatus(true);

  return (
    <aside className="settings-panel" aria-label="Settings">
      <div className="settings-header">
        <strong>Settings</strong>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
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
