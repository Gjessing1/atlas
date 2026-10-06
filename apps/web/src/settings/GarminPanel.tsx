import type { GarminAutoImport, GarminState } from '@atlas/app-hooks';
import { useState } from 'react';

export function GarminPanel({ garmin }: { garmin: GarminState }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  return (
    <div className="settings-section">
      <h3>Garmin Connect</h3>
      <p className="settings-note">
        Connect your Garmin account here. Browse courses, import activities and view saved copies in
        Collections → Garmin.
      </p>
      <p className="settings-note">
        Watch saved locations can be imported from a Garmin Explore GPX file in Collections →
        Garmin.
      </p>
      {garmin.connected ? (
        <>
          <p>Connected to Garmin Connect.</p>
          <h4>Import new activities</h4>
          <label>
            Check Garmin for new activities
            <select
              value={garmin.autoImport}
              onChange={(event) =>
                void garmin.setAutoImport(event.currentTarget.value as GarminAutoImport)
              }
              data-testid="garmin-auto-import"
            >
              <option value="off">Off</option>
              <option value="sixHours">Every 6 hours</option>
              <option value="daily">Daily</option>
            </select>
          </label>
          <p className="settings-note">
            In this browser, while Atlas is open or the next time it opens. Each check also fills in
            older history until all of it is imported. Turn this on for one device only, so two
            don’t import the same activity at once.
          </p>
          <h4>Connection</h4>
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
          {garmin.lastImport.sorted > 0 &&
            ` Filed ${garmin.lastImport.sorted} earlier ${garmin.lastImport.sorted === 1 ? 'import' : 'imports'} into sport folders.`}
          {garmin.nextActivityOffset > 0
            ? ` Next batch starts at activity ${garmin.nextActivityOffset + 1}.`
            : ' All available activity pages checked.'}
        </p>
      )}
    </div>
  );
}
