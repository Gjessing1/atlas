import { buildGpx, computeTrackStats, TrackRecorder, type RecorderSnapshot } from '@atlas/gpx';
import type { NewTrack } from '@atlas/storage';
import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';

import { setTrackHandler, TRACK_LOCATION_TASK } from './trackTask';

export type RecordPhase = 'idle' | 'recording' | 'paused' | 'saving';

export interface TrackRecordingController {
  phase: RecordPhase;
  /** Live stats/snapshot while recording (null when idle). */
  snapshot: RecorderSnapshot | null;
  error: string | null;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  /** Stop, save the track as GPX, return to idle. Returns the saved name (or null if empty). */
  stopAndSave: (name?: string) => Promise<string | null>;
  /** Stop and throw the recording away. */
  discard: () => void;
}

/** A GPX-style default name from the recording's start time, e.g. "Track 2026-07-16 10:32". */
function defaultTrackName(startMs: number | undefined): string {
  const d = new Date(startMs ?? Date.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Track ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * Records the device's track to a GPX file, driven by the same Android
 * foreground-service location plumbing navigation uses (via {@link
 * TRACK_LOCATION_TASK}) so recording survives screen-off and backgrounding.
 * The trip logic lives in @atlas/gpx's platform-neutral {@link TrackRecorder};
 * this hook only wires it to device GPS, React state, and storage.
 */
export function useTrackRecording(
  saveTrack: (input: NewTrack) => Promise<void>,
): TrackRecordingController {
  const [phase, setPhase] = useState<RecordPhase>('idle');
  const [snapshot, setSnapshot] = useState<RecorderSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<TrackRecorder | null>(null);

  const stopUpdates = useCallback(() => {
    setTrackHandler(null);
    void Location.hasStartedLocationUpdatesAsync(TRACK_LOCATION_TASK).then((started) => {
      if (started) void Location.stopLocationUpdatesAsync(TRACK_LOCATION_TASK);
    });
  }, []);

  const onFix = useCallback((fix: Parameters<TrackRecorder['addFix']>[0]) => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    // Runs on every GPS fix incl. the headless background task; an uncaught
    // throw here would take a release build down.
    try {
      recorder.addFix(fix);
      setSnapshot(recorder.snapshot());
    } catch (err) {
      console.warn('track fix failed', err);
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) throw new Error('Location permission is required to record a track');
      await Location.requestBackgroundPermissionsAsync().catch(() => undefined);

      const recorder = new TrackRecorder();
      recorder.start();
      recorderRef.current = recorder;
      setSnapshot(recorder.snapshot());
      setPhase('recording');

      setTrackHandler(onFix);
      const already = await Location.hasStartedLocationUpdatesAsync(TRACK_LOCATION_TASK);
      if (!already) {
        await Location.startLocationUpdatesAsync(TRACK_LOCATION_TASK, {
          accuracy: Location.Accuracy.BestForNavigation,
          distanceInterval: 5,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'Atlas track recording',
            notificationBody: 'Recording your track',
          },
        });
      }
    } catch (err) {
      stopUpdates();
      recorderRef.current = null;
      setSnapshot(null);
      setPhase('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onFix, stopUpdates]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorder.pause();
    setSnapshot(recorder.snapshot());
    setPhase('paused');
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorder.resume();
    setSnapshot(recorder.snapshot());
    setPhase('recording');
  }, []);

  const finish = useCallback(() => {
    stopUpdates();
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setSnapshot(null);
    setPhase('idle');
    return recorder;
  }, [stopUpdates]);

  const stopAndSave = useCallback(
    async (name?: string): Promise<string | null> => {
      const recorder = recorderRef.current;
      if (!recorder) return null;
      recorder.stop();
      setPhase('saving');
      const stats = recorder.stats();
      // Nothing worth keeping (permission granted but no fixes arrived).
      if (stats.points === 0) {
        finish();
        return null;
      }
      const finalName = name?.trim() || defaultTrackName(stats.startTime);
      const data = recorder.toTrackData({ name: finalName });
      const input: NewTrack = {
        name: finalName,
        gpx: buildGpx(data),
        stats: computeTrackStats(data) as unknown as Record<string, number>,
      };
      try {
        await saveTrack(input);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        finish();
      }
      return finalName;
    },
    [finish, saveTrack],
  );

  const discard = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder) recorder.stop();
    finish();
  }, [finish]);

  // Tear down the foreground service if the app unmounts mid-recording.
  useEffect(() => () => stopUpdates(), [stopUpdates]);

  return { phase, snapshot, error, start, pause, resume, stopAndSave, discard };
}
