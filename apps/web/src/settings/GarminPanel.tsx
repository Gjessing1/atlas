import type { GarminState } from '@atlas/app-hooks';
import type { CollectionRevealTarget } from '@atlas/core';
import { useState } from 'react';
import { GarminCourses } from './GarminCourses.js';

export function GarminPanel({
  garmin,
  onReveal,
}: {
  garmin: GarminState;
  onReveal: (target: CollectionRevealTarget) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');

  return (
    <div className="settings-section">
      <h3>Garmin Connect</h3>
      <p className="settings-note">
        Manage your Garmin Connect courses and send them to your watch, and bring your recorded
        activities into Atlas, filed by sport.
      </p>
      <p className="settings-note">
        Watch saved locations are not imported yet. Atlas saved places are in Collections → Places.
      </p>
      {garmin.connected ? (
        <>
          <p>Connected to Garmin Connect.</p>
          <GarminCourses garmin={garmin} onReveal={onReveal} />
          <h4>Activities</h4>
          <p className="settings-note settings-note-leading">
            Imports GPS activities 30 at a time into Garmin activities, one folder per sport.
          </p>
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
