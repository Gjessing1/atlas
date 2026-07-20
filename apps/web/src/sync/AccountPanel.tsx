import { useState } from 'react';
import type { SyncState } from './useSync.js';

const timeShort = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Password rotation. Kept collapsed until asked for — it is rare, and the
 * common case (checking sync status) should not be buried under a form.
 */
function ChangePasswordForm({ sync }: { sync: SyncState }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!open) {
    return (
      <button type="button" className="link-button" onClick={() => setOpen(true)}>
        Change password
      </button>
    );
  }

  const submit = () => {
    if (!current || !next || pending) return;
    setPending(true);
    setResult(null);
    void sync.changePassword(current, next).then((err) => {
      setPending(false);
      setResult(err);
      if (!err) {
        setDone(true);
        setCurrent('');
        setNext('');
        setOpen(false);
      }
    });
  };

  return (
    <form
      className="account-subform"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        type="password"
        placeholder="current password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <input
        type="password"
        placeholder="new password (min 8 characters)"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <p className="account-note">Your other devices will be signed out.</p>
      <div className="account-actions">
        <button type="submit" disabled={pending}>
          {pending ? 'Changing…' : 'Change password'}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
      </div>
      {result && <p className="account-error">{result}</p>}
      {done && <p className="account-note">Password changed.</p>}
    </form>
  );
}

/**
 * Account deletion: server-side data only, and typed confirmation plus the
 * password before it fires. Local data survives — the app just returns to
 * anonymous local-only.
 */
function DeleteAccountForm({ sync }: { sync: SyncState }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" className="link-button link-danger" onClick={() => setOpen(true)}>
        Delete account
      </button>
    );
  }

  const submit = () => {
    if (!password || confirm !== 'DELETE' || pending) return;
    setPending(true);
    setError(null);
    void sync.deleteAccount(password).then((err) => {
      setPending(false);
      setError(err);
      if (!err) setOpen(false);
    });
  };

  return (
    <form
      className="account-subform"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="account-note">
        Deletes your account and everything synced to the server. Places and tracks stored in this
        browser stay — export them first if this is your only copy.
      </p>
      <input
        type="password"
        placeholder="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <input
        type="text"
        placeholder="type DELETE to confirm"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        aria-label="Type DELETE to confirm"
      />
      <div className="account-actions">
        <button
          type="submit"
          className="button-danger"
          disabled={pending || confirm !== 'DELETE' || !password}
        >
          {pending ? 'Deleting…' : 'Delete account'}
        </button>
        <button type="button" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </button>
      </div>
      {error && <p className="account-error">{error}</p>}
    </form>
  );
}

/**
 * Account + sync state, shown in the Settings panel. Anonymous local-only is
 * the default — this panel is the only place an account enters the picture.
 */
export function AccountPanel({ sync }: { sync: SyncState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
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
    void sync.signIn(email.trim(), password, mode, invite.trim() || undefined).then((err) => {
      setPending(false);
      setFormError(err);
      if (!err) {
        setPassword('');
        setInvite('');
      }
    });
  };

  if (sync.status === 'signedOut') {
    // The server decides whether new accounts are possible; don't offer a
    // button it will refuse.
    const canRegister = sync.registration !== 'closed';
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
          {sync.registration === 'invite' && (
            <input
              type="text"
              placeholder="invite code (new accounts only)"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              aria-label="Invite code"
            />
          )}
          <div className="account-actions">
            <button type="submit" disabled={pending}>
              Sign in
            </button>
            {canRegister && (
              <button type="button" disabled={pending} onClick={() => submit('register')}>
                Create account
              </button>
            )}
          </div>
        </form>
        {!canRegister && <p className="account-note">This server is not accepting new accounts.</p>}
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
      <div className="account-manage">
        <ChangePasswordForm sync={sync} />
        <DeleteAccountForm sync={sync} />
      </div>
    </div>
  );
}
