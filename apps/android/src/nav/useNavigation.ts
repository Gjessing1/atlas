import {
  useNavigationController,
  type NavController,
  type NavOriginFix,
  type NavPlatform,
} from '@atlas/app-hooks';
import { headingRateDegPerSec, type Position } from '@atlas/navigation';
import { httpTrafficClosures, httpTrafficDelay } from '@atlas/traffic';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import * as Speech from 'expo-speech';
import { useMemo } from 'react';

import { AudioFocus } from '../../modules/audiofocus';
import { makeNvdbCameraTransport, makeNvdbLimitTransport } from '../routing/offlineNvdb';
import { makeRouteProvider, makeTraceTransport } from '../routing/offlineRouting';
import { useServerOrigin } from '../serverOrigin';
import { logNavigationDiagnostic } from './diagnostics';
import {
  NAV_LOCATION_TASK,
  readPersistedLocationFix,
  setLocationHandler,
  toPosition,
} from './locationTask';
import { LocationWatchCoordinator } from './locationWatch';

/** How stale a last-known position may be when a live fix never arrives. */
const LAST_KNOWN_MAX_AGE_MS = 120_000;

/**
 * Utterances queued or playing. Audio focus is held while it is non-zero, so
 * one duck spans a whole burst of prompts rather than flapping between them.
 */
let utterances = 0;

const locationWatch = new LocationWatchCoordinator(
  NAV_LOCATION_TASK,
  Location,
  setLocationHandler,
  readPersistedLocationFix,
  (transition) => void logNavigationDiagnostic({ event: 'gps-stream', ...transition }),
);

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
  void logNavigationDiagnostic({
    event: 'gps-origin-fix',
    measuredAtMs: pos.timestamp,
    source: cur ? 'current' : 'last-known',
    coords: pos.coords,
  });
  return { fix: toPosition(pos), atMs: pos.timestamp };
}

/**
 * Fixes under an Android foreground service, so guidance survives screen-off.
 * The background task cannot touch React state, so it forwards through the
 * module-level handler in `locationTask`.
 */
async function watchFixes(
  onFix: (fix: Position, measuredAtMs?: number) => void,
  activity: 'guidance' | 'explorer' = 'guidance',
): Promise<() => void> {
  return locationWatch.start((fix, measuredAtMs) => onFix(fix, measuredAtMs), {
    accuracy: Location.Accuracy.BestForNavigation,
    // Time-based, not distance-based: with a distance filter no fixes arrive
    // at a standstill, freezing the ETA at every red light.
    timeInterval: 1000,
    distanceInterval: 0,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: activity === 'explorer' ? 'Atlas Explorer' : 'Atlas navigation',
      notificationBody:
        activity === 'explorer'
          ? 'Following your position without a destination'
          : 'Guiding you to your destination',
    },
  });
}

/**
 * Yaw rate from the gyro, integrated into a per-report delta (with the
 * interval it covers). The magnetometer is useless in a car — steel body,
 * speakers, cradle magnet, and hopeless in a tunnel; the gyro's relative yaw
 * is the reliable signal. Two subscribers: the session while dead reckoning
 * (a turn taken with no fixes), and the follow camera for the whole trip.
 */
export function watchHeadingRate(onDelta: (deltaDeg: number, dtSec: number) => void): () => void {
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
    // expo-sensors names the rotation rates alpha/beta/gamma but documents
    // (and on Android delivers) them as the plain device x/y/z axes — NOT the
    // W3C beta-about-x order. `accelerationIncludingGravity` is the W3C
    // down-pointing vector; both are raw device frame, unrotated by the screen
    // orientation, which is exactly what the gravity projection wants.
    const rate = headingRateDegPerSec(
      { x: rot.alpha ?? 0, y: rot.beta ?? 0, z: rot.gamma ?? 0 },
      grav,
    );
    if (rate !== null) onDelta(rate * dtSec, dtSec);
  });
  return () => sub.remove();
}

/**
 * Sensor calibration grade (0–3) → a usable ± degrees for the uncertainty
 * cone. Android reports compass health in grades, not degrees; these map the
 * grades onto the spreads Google's own beam roughly shows. Grade 0
 * (uncalibrated, needs the figure-8) maps past the blender's cutoff, so the
 * puck degrades to a plain dot rather than pointing a confident arrow
 * somewhere wrong.
 */
const HEADING_ACCURACY_DEG: Record<number, number> = { 3: 15, 2: 30, 1: 45, 0: 90 };

/**
 * Which way the device faces, from the rotation-vector compass
 * (magnetometer fused with the accelerometer/gyro). This is the walking-mode
 * heading source: a pedestrian standing at a junction has no GPS course, and
 * the route tangent points down a path they have not chosen. True heading
 * where declination is known, magnetic as the fallback.
 */
function watchFacing(onFacing: (deg: number, accuracyDeg: number | null) => void): () => void {
  let sub: Location.LocationSubscription | null = null;
  let stopped = false;
  Location.watchHeadingAsync((heading) => {
    const deg = heading.trueHeading >= 0 ? heading.trueHeading : heading.magHeading;
    if (typeof deg !== 'number' || deg < 0) return;
    onFacing(deg, HEADING_ACCURACY_DEG[heading.accuracy] ?? null);
  })
    .then((subscription) => {
      if (stopped) subscription.remove();
      else sub = subscription;
    })
    .catch((err) => console.warn('heading watch failed', err));
  return () => {
    stopped = true;
    sub?.remove();
    sub = null;
  };
}

/**
 * Turn-by-turn navigation on Android: the device half of the shared navigation
 * controller. Fixes come from redundant foreground and background streams, prompts from
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
  const platform = useMemo<NavPlatform>(() => {
    const provider = makeRouteProvider(serverOrigin);
    return {
      provider: {
        route: async (query, signal) => {
          void logNavigationDiagnostic({ event: 'route-request', query });
          try {
            const result = await provider.route(query, signal);
            void logNavigationDiagnostic({ event: 'route-calculated', query, result });
            return result;
          } catch (error) {
            void logNavigationDiagnostic({
              event: 'route-failed',
              query,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
      },
      trafficClosures: httpTrafficClosures(serverOrigin),
      // The same corridor measurements the provider prices a new route with,
      // asked again mid-drive so the trip being followed is re-priced too.
      trafficDelay: httpTrafficDelay(serverOrigin),
      trace: makeTraceTransport(serverOrigin),
      // NVDB speed limits + ATK/OSM cameras, offline-first (ROADMAP §2.1): a
      // downloaded pack that ships nvdb.sqlite answers from its own copy of the
      // dataset with the same conflation the server runs; otherwise these fall
      // back to the server, and an offline drive with no such pack simply keeps
      // the tile limits and gets no camera guidance.
      nvdbLimits: makeNvdbLimitTransport(serverOrigin),
      nvdbCameras: makeNvdbCameraTransport(serverOrigin),
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
      watchFacing,
    };
  }, [serverOrigin]);

  return useNavigationController(platform);
}
