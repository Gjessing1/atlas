import {
  useNavigationController,
  type NavController,
  type NavOriginFix,
  type NavPlatform,
} from '@atlas/app-hooks';
import { headingRateDegPerSec, type Position } from '@atlas/navigation';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import * as Speech from 'expo-speech';
import { useMemo } from 'react';

import { AudioFocus } from '../../modules/audiofocus';
import { makeRouteProvider, makeTraceTransport } from '../routing/offlineRouting';
import { useServerOrigin } from '../serverOrigin';
import { NAV_LOCATION_TASK, setLocationHandler, toPosition } from './locationTask';

/** How stale a last-known position may be when a live fix never arrives. */
const LAST_KNOWN_MAX_AGE_MS = 120_000;

/**
 * Utterances queued or playing. Audio focus is held while it is non-zero, so
 * one duck spans a whole burst of prompts rather than flapping between them.
 */
let utterances = 0;

function focus(on: boolean): void {
  try {
    if (on) AudioFocus?.requestDuck();
    else AudioFocus?.abandon();
  } catch (err) {
    console.warn('audio focus failed', err);
  }
}

/**
 * Speak a prompt, ducking music/podcasts for its duration — expo-speech never
 * asks for audio focus itself, so prompts used to talk over media.
 */
function speak(text: string): void {
  if (utterances === 0) focus(true);
  utterances++;
  const release = () => {
    utterances = Math.max(0, utterances - 1);
    if (utterances === 0) focus(false);
  };
  try {
    // Instructions are English; without a pinned language a Norwegian device
    // voice garbles them.
    Speech.speak(text, { language: 'en', onDone: release, onStopped: release, onError: release });
  } catch (err) {
    release();
    throw err;
  }
}

async function currentFix(timeoutMs: number): Promise<NavOriginFix> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) throw new Error('Location permission is required to navigate');
  // Background permission is best-effort: navigation still works while the
  // app is foregrounded even if the user declines "allow all the time".
  await Location.requestBackgroundPermissionsAsync().catch(() => undefined);

  // getCurrentPositionAsync has no timeout of its own — indoors it can simply
  // never resolve, wedging the caller forever. Fall back to the last known
  // position: a slightly stale preview origin beats no preview, and guidance
  // reroutes from the first live fix anyway.
  const cur = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  const pos = cur ?? (await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS }));
  if (!pos) throw new Error('Could not get a GPS fix — is location on?');
  return { fix: toPosition(pos), atMs: pos.timestamp };
}

/**
 * Fixes under an Android foreground service, so guidance survives screen-off.
 * The background task cannot touch React state, so it forwards through the
 * module-level handler in `locationTask`.
 */
async function watchFixes(onFix: (fix: Position) => void): Promise<() => void> {
  setLocationHandler(onFix);
  const already = await Location.hasStartedLocationUpdatesAsync(NAV_LOCATION_TASK);
  if (!already) {
    await Location.startLocationUpdatesAsync(NAV_LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      // Time-based, not distance-based: with a distance filter no fixes arrive
      // at a standstill, freezing the ETA at every red light.
      timeInterval: 1000,
      distanceInterval: 0,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: 'Atlas navigation',
        notificationBody: 'Guiding you to your destination',
      },
    });
  }
  return () => {
    setLocationHandler(null);
    void Location.hasStartedLocationUpdatesAsync(NAV_LOCATION_TASK).then((started) => {
      if (started) void Location.stopLocationUpdatesAsync(NAV_LOCATION_TASK);
    });
  };
}

/**
 * Yaw rate from the gyro, integrated into a per-report delta. The magnetometer
 * is useless in a car in a tunnel; the gyro's relative yaw since the last good
 * fix is the reliable signal.
 */
function watchHeadingRate(onDelta: (deltaDeg: number) => void): () => void {
  DeviceMotion.setUpdateInterval(100);
  let lastMs: number | null = null;
  const sub = DeviceMotion.addListener((m) => {
    const rot = m.rotationRate;
    const grav = m.accelerationIncludingGravity;
    if (!rot || !grav) return;
    const now = Date.now();
    const dtSec = lastMs === null ? 0 : Math.min(0.5, (now - lastMs) / 1000);
    lastMs = now;
    if (dtSec <= 0) return;
    // W3C device axes: beta about x, gamma about y, alpha about z (deg/s).
    const rate = headingRateDegPerSec(
      { x: rot.beta ?? 0, y: rot.gamma ?? 0, z: rot.alpha ?? 0 },
      grav,
    );
    if (rate !== null) onDelta(rate * dtSec);
  });
  return () => sub.remove();
}

/**
 * Turn-by-turn navigation on Android: the device half of the shared navigation
 * controller. Fixes come from a foreground-service location task, prompts from
 * expo-speech (with audio ducking), and routes from the offline-first provider
 * — the embedded Valhalla engine when a downloaded pack covers the trip,
 * otherwise the server. The trip logic itself is `useNavigationController`,
 * which the web drives through the same seam.
 *
 * Enrichment (speed limits, tunnels) is offline-first too: the bridge exposes
 * `trace_attributes`, so a drive covered by a downloaded pack reads its limits
 * out of the very tiles the route came from, with the server as the fallback
 * for anything outside one.
 */
export function useNavigation(): NavController {
  const serverOrigin = useServerOrigin();
  const platform = useMemo<NavPlatform>(
    () => ({
      provider: makeRouteProvider(serverOrigin),
      trace: makeTraceTransport(serverOrigin),
      currentFix,
      watchFixes,
      speak,
      stopSpeaking: () => Speech.stop(),
      keepAwake: () => {
        void activateKeepAwakeAsync('atlas-nav').catch(() => undefined);
        return () => {
          void deactivateKeepAwake('atlas-nav').catch(() => undefined);
        };
      },
      watchHeadingRate,
    }),
    [serverOrigin],
  );

  return useNavigationController(platform);
}
