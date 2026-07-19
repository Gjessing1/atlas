import { useState } from 'react';
import type { SyncState } from './useSync.js';

const timeShort = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Account + sync state, shown in the Settings panel. Anonymous local-only is
 * the default — this panel is the only place an account enters the picture.
 */
export function AccountPanel({ sync }: { sync: SyncState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (sync.available === null) return null;
  if (sync.available === false) {
    return (
      <div className="account-panel">
        <p className="account-note">Sync is not configured on this server — data stays local.</p>
      </div>
    );
  }

  const submit = (mode: 'login' | 'register') => {
    if (!email.trim() || !password || pending) return;
    setPending(true);
    setFormError(null);
    void sync.signIn(email.trim(), password, mode).then((err) => {
      setPending(false);
      setFormError(err);
      if (!err) setPassword('');
    });
  };

  if (sync.status === 'signedOut') {
    return (
      <div className="account-panel">
        <strong>Sync</strong>
        <p className="account-note">
          Optional: sign in to back up and sync between devices. Without an account everything stays
          in this browser.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit('login');
          }}
        >
          <input
            type="email"
            placeholder="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            placeholder="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="account-actions">
            <button type="submit" disabled={pending}>
              Sign in
            </button>
            <button type="button" disabled={pending} onClick={() => submit('register')}>
              Create account
            </button>
          </div>
        </form>
        {formError && <p className="account-error">{formError}</p>}
      </div>
    );
  }

  const statusLine =
    sync.status === 'syncing'
      ? 'Syncing…'
      : sync.status === 'offline'
        ? 'Offline — changes queued'
        : sync.status === 'authExpired' || sync.status === 'error'
          ? (sync.error ?? 'Sync failed')
          : sync.lastSyncAt
            ? `Synced ${timeShort(sync.lastSyncAt)}`
            : 'Signed in';

  return (
    <div className="account-panel">
      <div className="account-line">
        <strong>{sync.email}</strong>
      </div>
      <div className="account-line">
        <span
          className={
            sync.status === 'authExpired' || sync.status === 'error'
              ? 'account-error'
              : 'account-note'
          }
        >
          {statusLine}
        </span>
      </div>
      <div className="account-actions">
        <button type="button" onClick={sync.syncNow} disabled={sync.status === 'syncing'}>
          Sync now
        </button>
        <button type="button" onClick={sync.signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
