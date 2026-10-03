import type { GarminState } from '@atlas/app-hooks';
import { useState } from 'react';

export function GarminPanel({ garmin }: { garmin: GarminState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  return (
    <div className="settings-section">
      <h3>Garmin Connect</h3>
      <p className="settings-note">
        Send planned courses to Garmin Connect and queue them for a selected device. Import GPS
        activity history into the Garmin activities folder in batches of 30.
      </p>
      {garmin.connected ? (
        <>
          <p>Connected to Garmin Connect.</p>
          <button
            type="button"
            disabled={garmin.busy}
            onClick={() => void garmin.importActivities()}
          >
            {garmin.busy
              ? 'Working…'
              : garmin.nextActivityOffset > 0
                ? 'Import older activities'
                : 'Import recent activities'}
          </button>
          {garmin.nextActivityOffset > 0 && (
            <button
              type="button"
              disabled={garmin.busy}
              onClick={() => void garmin.restartActivityImport()}
            >
              Check newest again
            </button>
          )}
          <button type="button" disabled={garmin.busy} onClick={() => void garmin.disconnect()}>
            Disconnect Garmin
          </button>
          <p className="settings-note">
            Disconnect removes Atlas’s stored sign-in. Revoke access from your Garmin account if
            needed.
          </p>
        </>
      ) : garmin.mfaRequired ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void garmin.completeMfa(code);
            setCode('');
          }}
        >
          <label>
            Garmin verification code
            <input
              value={code}
              onChange={(event) => setCode(event.currentTarget.value)}
              autoComplete="one-time-code"
            />
          </label>
          <button type="submit" disabled={garmin.busy || !code.trim()}>
            Verify
          </button>
        </form>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void garmin.connect(email.trim(), password);
            setPassword('');
          }}
        >
          <label>
            Garmin email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
              autoComplete="username"
            />
          </label>
          <label>
            Garmin password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              autoComplete="current-password"
            />
          </label>
          <button type="submit" disabled={garmin.busy || !email.trim() || !password}>
            Connect Garmin
          </button>
        </form>
      )}
      {garmin.error && (
        <p className="settings-note settings-error" role="alert">
          {garmin.error}
        </p>
      )}
      {garmin.lastImport && (
        <p className="settings-note" role="status">
          Imported {garmin.lastImport.imported}; skipped {garmin.lastImport.skipped};{' '}
          {garmin.lastImport.errors} failed.
          {garmin.nextActivityOffset > 0
            ? ` Next batch starts at activity ${garmin.nextActivityOffset + 1}.`
            : ' All available activity pages checked.'}
        </p>
      )}
    </div>
  );
}
