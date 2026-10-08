import {
  garminCourseLine,
  garminCourseSports,
  garminDeliveryLine,
  type GarminState,
} from '@atlas/app-hooks';
import type { CollectionRevealTarget } from '@atlas/core';
import {
  GARMIN_COURSE_SPORTS,
  garminSportFolder,
  garminTypeLabel,
  type GarminCourseSport,
} from '@atlas/core';
import { useEffect, useState } from 'react';
import { GarminReplaceConfirm } from './GarminCourseEdit.js';

/**
 * The Garmin Connect course library: browse by sport, and per course save a copy into Atlas,
 * send it to a watch, rename it, change its sport or delete it. One course is open at a time so
 * the list stays scannable; every action reports back on the row it came from.
 */
export function GarminCourses({
  garmin,
  onReveal,
  onEditRoute,
}: {
  garmin: GarminState;
  onReveal: (target: CollectionRevealTarget) => void;
  /** Reshape the course in the planner; it is replaced on Garmin from there. */
  onEditRoute: (id: string) => void;
}) {
  const [sport, setSport] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { courses, loadCourses, loadDevices } = garmin;

  useEffect(() => {
    if (courses === null) void loadCourses();
  }, [courses, loadCourses]);

  const sports = courses ? garminCourseSports(courses) : [];
  const shown = (courses ?? []).filter(
    (course) => sport === null || garminSportFolder(course.type) === sport,
  );

  const open = (id: string) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setName(courses?.find((course) => course.id === id)?.name ?? '');
    setConfirmDelete(false);
    garmin.clearCourseResult();
    if (garmin.devices.length === 0) void loadDevices();
  };
  const device = deviceId || garmin.devices[0]?.id || '';

  return (
    <div className="garmin-courses">
      <div className="garmin-courses-head">
        <h4>Courses{courses ? ` · ${courses.length}` : ''}</h4>
        <button
          type="button"
          className="garmin-quiet"
          disabled={garmin.busy}
          onClick={() => void loadCourses()}
        >
          {garmin.busy && courses === null ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {sports.length > 1 && (
        <div className="garmin-sports" role="radiogroup" aria-label="Filter courses by sport">
          {[{ sport: null, count: courses!.length }, ...sports].map((item) => (
            <button
              key={item.sport ?? 'all'}
              type="button"
              role="radio"
              aria-checked={sport === item.sport}
              className="route-chip"
              onClick={() => setSport(item.sport)}
            >
              {item.sport ?? 'All'} <span className="garmin-count">{item.count}</span>
            </button>
          ))}
        </div>
      )}
      {courses && courses.length === 0 && (
        <p className="settings-note">
          No courses in Garmin Connect yet. Plan a walking, running, hiking or cycling route and
          choose Send to Garmin.
        </p>
      )}
      {garmin.replacement && <GarminReplaceConfirm garmin={garmin} />}
      <ul className="garmin-course-list">
        {shown.map((course) => {
          const expanded = openId === course.id;
          const pending = garmin.pendingCourseId === course.id;
          const savedTrack = garmin.savedCourses.get(course.id);
          const onMap = garmin.coursesOnMap.has(course.id);
          const delivery = garmin.deliveries.get(course.id);
          const sportKnown = (GARMIN_COURSE_SPORTS as readonly string[]).includes(
            course.type ?? '',
          );
          return (
            <li key={course.id} className={expanded ? 'garmin-course open' : 'garmin-course'}>
              <button
                type="button"
                className="garmin-course-row"
                aria-expanded={expanded}
                onClick={() => open(course.id)}
              >
                <span className="garmin-course-name">
                  {course.name}
                  {savedTrack && <span className="garmin-badge">In Atlas</span>}
                  {!savedTrack && <span className="garmin-badge">Garmin only</span>}
                </span>
                <span className="garmin-course-line">{garminCourseLine(course)}</span>
                <span className="garmin-course-line">
                  {delivery
                    ? garminDeliveryLine(course, delivery)
                    : 'No watch send recorded in Atlas'}
                </span>
              </button>
              {expanded && (
                <div className="garmin-course-actions" aria-busy={pending}>
                  <div className="garmin-action-row">
                    {savedTrack ? (
                      <>
                        <button
                          type="button"
                          className="primary"
                          onClick={() => {
                            void garmin.setCourseVisible(course.id, true);
                            onReveal({ kind: 'track', id: savedTrack });
                          }}
                        >
                          Show on map
                        </button>
                        <button
                          type="button"
                          disabled={!onMap}
                          onClick={() => void garmin.setCourseVisible(course.id, false)}
                        >
                          Hide from map
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="primary"
                        disabled={pending}
                        onClick={() =>
                          void garmin.saveCourse(course.id).then((id) => {
                            if (id) onReveal({ kind: 'track', id });
                          })
                        }
                      >
                        Save &amp; show on map
                      </button>
                    )}
                    <button type="button" disabled={pending} onClick={() => onEditRoute(course.id)}>
                      Edit route
                    </button>
                    {garmin.devices.length > 1 && (
                      <select
                        aria-label="Garmin device"
                        value={device}
                        onChange={(event) => setDeviceId(event.currentTarget.value)}
                      >
                        {garmin.devices.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {garmin.devices.length > 0 && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => void garmin.sendCourse(course.id, device)}
                      >
                        {garmin.devices.length === 1
                          ? `Send to ${garmin.devices[0]!.name}`
                          : 'Send to watch'}
                      </button>
                    )}
                  </div>
                  <form
                    className="garmin-action-row"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void garmin.renameCourse(course.id, name);
                    }}
                  >
                    <label className="garmin-field">
                      Name
                      <input
                        value={name}
                        maxLength={100}
                        onChange={(event) => setName(event.currentTarget.value)}
                      />
                    </label>
                    <button
                      type="submit"
                      disabled={pending || !name.trim() || name.trim() === course.name}
                    >
                      Rename
                    </button>
                  </form>
                  <label className="garmin-field">
                    Sport
                    <select
                      aria-label="Course sport"
                      value={course.type ?? ''}
                      disabled={pending}
                      onChange={(event) =>
                        void garmin.setCourseSport(
                          course.id,
                          event.currentTarget.value as GarminCourseSport,
                        )
                      }
                    >
                      {!sportKnown && (
                        <option value={course.type ?? ''} disabled>
                          {course.type ? garminTypeLabel(course.type) : 'Not set'}
                        </option>
                      )}
                      {GARMIN_COURSE_SPORTS.map((key) => (
                        <option key={key} value={key}>
                          {garminTypeLabel(key)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {confirmDelete ? (
                    <div className="garmin-confirm" role="alertdialog" aria-label="Delete course">
                      <p>
                        Delete “{course.name}” from Garmin Connect? This can’t be undone.
                        {savedTrack ? ' Your copy in Atlas stays.' : ''} A copy already on your
                        watch may stay there after sync. Remove it on the watch too.
                      </p>
                      <div className="garmin-action-row">
                        <button
                          type="button"
                          className="garmin-danger"
                          disabled={pending}
                          onClick={() =>
                            void garmin.deleteCourse(course.id).then((deleted) => {
                              if (deleted) {
                                setOpenId(null);
                                setConfirmDelete(false);
                              }
                            })
                          }
                        >
                          {pending ? 'Deleting…' : 'Delete'}
                        </button>
                        <button type="button" onClick={() => setConfirmDelete(false)}>
                          Keep
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="garmin-action-row garmin-action-foot">
                      <a
                        href={`https://connect.garmin.com/modern/course/${course.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Garmin Connect
                      </a>
                      <button
                        type="button"
                        className="garmin-quiet garmin-danger-text"
                        disabled={pending}
                        onClick={() => setConfirmDelete(true)}
                      >
                        Delete…
                      </button>
                    </div>
                  )}
                  {pending && !confirmDelete && (
                    <p className="settings-note" role="status">
                      Working…
                    </p>
                  )}
                  {!pending && garmin.courseNotice && (
                    <p className="settings-note" role="status">
                      {garmin.courseNotice}
                    </p>
                  )}
                  {!pending && garmin.courseError && (
                    <p className="settings-note settings-error" role="alert">
                      {garmin.courseError}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {/* A deleted course takes its row with it, so its confirmation lands here. */}
      {openId === null && garmin.courseNotice && (
        <p className="settings-note" role="status">
          {garmin.courseNotice}
        </p>
      )}
    </div>
  );
}
