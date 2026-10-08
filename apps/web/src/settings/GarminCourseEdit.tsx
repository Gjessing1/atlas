import { garminResendDevice, type GarminState } from '@atlas/app-hooks';
import type { RoutePath, RoutingProfile } from '@atlas/routing';
import { useEffect, useState } from 'react';

/**
 * Shown in the planner while a Garmin course is being reshaped: the edit replaces the course on
 * Garmin (create the new one, then — after a confirm — delete the old) and goes back to the
 * watch it was last sent to.
 */
export function GarminCourseEditBar({
  garmin,
  path,
  profile,
}: {
  garmin: GarminState;
  path: RoutePath | null;
  profile: RoutingProfile;
}) {
  const edit = garmin.courseEdit;
  const [deviceId, setDeviceId] = useState('');
  const resendTo = edit ? garminResendDevice(garmin.deliveries.get(edit.id), garmin.devices) : '';
  useEffect(() => setDeviceId(resendTo), [resendTo, edit?.id]);
  if (!edit) return null;
  const pending = garmin.pendingCourseId === edit.id;
  return (
    <div className="route-save-track garmin-edit-bar" role="group" aria-label="Garmin course edit">
      <p>
        Editing Garmin course <strong>“{edit.name}”</strong>. Reshape it on the map, then create a
        replacement in Garmin Connect. The old course stays until you choose to delete it.
      </p>
      {garmin.devices.length > 0 && (
        <label>
          Send to
          <select value={deviceId} onChange={(event) => setDeviceId(event.currentTarget.value)}>
            <option value="">Garmin Connect only</option>
            {garmin.devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="garmin-action-row">
        <button
          type="button"
          className="primary"
          disabled={!path || pending || profile === 'car'}
          onClick={() => path && void garmin.replaceCourse(path, profile, deviceId || undefined)}
        >
          {pending ? 'Creating…' : 'Create replacement on Garmin'}
        </button>
        <button type="button" disabled={pending} onClick={garmin.cancelCourseEdit}>
          Stop editing
        </button>
      </div>
      {profile === 'car' && (
        <p className="settings-note">
          Garmin courses need a walking, running, hiking or cycling plan.
        </p>
      )}
      {!pending && garmin.courseError && (
        <p className="settings-note settings-error" role="alert">
          {garmin.courseError}
        </p>
      )}
    </div>
  );
}

/** The second half of a replacement: the old course goes only when the user says so. */
export function GarminReplaceConfirm({ garmin }: { garmin: GarminState }) {
  const done = garmin.replacement;
  // Once this asked, its answer (Delete / Keep both) is reported where the question was.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (done) setAsked(true);
  }, [done]);
  if (!done) {
    return asked && garmin.courseNotice ? (
      <p className="settings-note" role="status">
        {garmin.courseNotice}
      </p>
    ) : null;
  }
  const pending = garmin.pendingCourseId === done.oldId;
  return (
    <div className="garmin-confirm" role="alertdialog" aria-label="Replace Garmin course">
      <p>
        A replacement for “{done.name}” was created in Garmin Connect
        {done.queuedTo ? ` and queued for ${done.queuedTo}` : ''}. Delete the old Connect course? A
        copy already on your watch may stay there after sync. Remove the old course on the watch
        too.
      </p>
      <div className="garmin-action-row">
        <button
          type="button"
          className="garmin-danger"
          disabled={pending}
          onClick={() => void garmin.deleteReplacedCourse()}
        >
          {pending ? 'Deleting…' : 'Delete old version'}
        </button>
        <button type="button" disabled={pending} onClick={garmin.keepReplacedCourse}>
          Keep both
        </button>
      </div>
      {!pending && garmin.courseError && (
        <p className="settings-note settings-error" role="alert">
          {garmin.courseError}
        </p>
      )}
    </div>
  );
}
