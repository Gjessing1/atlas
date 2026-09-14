import {
  useNavigationController,
  type NavController,
  type NavOriginFix,
  type NavPlatform,
} from '@atlas/app-hooks';
import type { Position } from '@atlas/navigation';
import {
  enrichPlannedResult,
  httpElevationProfile,
  httpNvdbCameras,
  httpNvdbLanes,
  httpNvdbLimits,
  httpRouteProvider,
  httpTraceTransport,
} from '@atlas/routing';
import {
  httpRoadWeather,
  httpTrafficClosures,
  httpTrafficDelay,
  trafficAwareRouteProvider,
} from '@atlas/traffic';
import { useMemo } from 'react';

/** Promisified single geolocation fix. */
function currentPosition(timeout: number): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser has no geolocation'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (err) => reject(new Error(err.message)), {
      enableHighAccuracy: true,
      timeout,
    });
  });
}

/** The browser's fix shape, narrowed to what the session reads. */
function toPosition(geo: GeolocationPosition): Position {
  const { coords } = geo;
  const fix: Position = { lat: coords.latitude, lng: coords.longitude };
  if (typeof coords.accuracy === 'number' && coords.accuracy >= 0) fix.accuracyM = coords.accuracy;
  if (typeof coords.heading === 'number' && !Number.isNaN(coords.heading)) {
    fix.headingDeg = coords.heading;
  }
  if (typeof coords.speed === 'number' && coords.speed >= 0) fix.speedMps = coords.speed;
  if (typeof coords.altitude === 'number' && Number.isFinite(coords.altitude)) {
    fix.altitudeM = coords.altitude;
  }
  return fix;
}

/**
 * A navigating browser tab is a dashboard: hold a screen wake lock for the
 * trip. Best-effort — Safari < 16.4 has none — and the lock is silently
 * released when the tab is hidden, so reacquire on return.
 */
function keepAwake(): () => void {
  if (!('wakeLock' in navigator)) return () => undefined;
  let lock: WakeLockSentinel | null = null;
  let stopped = false;
  const acquire = () => {
    if (document.visibilityState !== 'visible') return;
    void navigator.wakeLock
      .request('screen')
      .then((sentinel) => {
        if (stopped) void sentinel.release();
        else lock = sentinel;
      })
      .catch(() => undefined);
  };
  acquire();
  document.addEventListener('visibilitychange', acquire);
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', acquire);
    void lock?.release().catch(() => undefined);
  };
}

/**
 * Device orientation as a compass heading, where the browser has one. Chrome
 * on Android delivers `deviceorientationabsolute` (magnetometer-fused, no
 * permission prompt); a desktop browser has no compass and simply never fires,
 * which is the honest outcome — the puck keeps its route-tangent fallback
 * rather than pretending. iOS Safari gates orientation behind a per-site
 * permission that needs a user gesture and publishes `webkitCompassHeading`
 * on the ordinary `deviceorientation` event. Other browsers use the absolute
 * event and expose no accuracy field.
 */
function watchFacing(onFacing: (deg: number, accuracyDeg: number | null) => void): () => void {
  const absoluteHandler = (event: DeviceOrientationEvent) => {
    if (!event.absolute || event.alpha == null) return;
    // alpha is the device's rotation from north (counter-clockwise); the
    // compass heading is its inverse, corrected for a rotated screen.
    const screenDeg = screen.orientation?.angle ?? 0;
    onFacing((360 - event.alpha + screenDeg) % 360, null);
  };
  const safariHandler = (event: DeviceOrientationEvent) => {
    const safari = event as DeviceOrientationEvent & {
      webkitCompassHeading?: number;
      webkitCompassAccuracy?: number;
    };
    if (typeof safari.webkitCompassHeading !== 'number') return;
    const accuracy = safari.webkitCompassAccuracy;
    onFacing(
      safari.webkitCompassHeading,
      typeof accuracy === 'number' && Number.isFinite(accuracy)
        ? accuracy >= 0
          ? accuracy
          : 90
        : null,
    );
  };
  window.addEventListener('deviceorientationabsolute', absoluteHandler as EventListener);
  window.addEventListener('deviceorientation', safariHandler as EventListener);
  return () => {
    window.removeEventListener('deviceorientationabsolute', absoluteHandler as EventListener);
    window.removeEventListener('deviceorientation', safariHandler as EventListener);
  };
}

/**
 * iOS Safari exposes orientation only after this is called directly from a
 * tap. Merely installing the listener is silent, so Start/Resume invokes this
 * seam before doing any asynchronous route work. Other browsers need nothing.
 */
function prepareFacing(): Promise<void> {
  if (!('DeviceOrientationEvent' in window)) return Promise.resolve();
  const ctor = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
    requestPermission?: () => Promise<'granted' | 'denied'>;
  };
  if (typeof ctor.requestPermission !== 'function') return Promise.resolve();
  return ctor.requestPermission.call(ctor).then(() => undefined);
}

/**
 * Turn-by-turn navigation for the web: the browser half of the shared
 * navigation controller. Fixes come from the geolocation watch, prompts from
 * the Web Speech API, and routes from the server — the trip logic itself is
 * `useNavigationController`, which Android drives through the same seam.
 */
export function useWebNavigation(): NavController {
  const platform = useMemo<NavPlatform>(() => {
    const trafficClosures = httpTrafficClosures();
    const trafficDelay = httpTrafficDelay();
    const roadWeather = httpRoadWeather();
    const provider = trafficAwareRouteProvider(
      httpRouteProvider(),
      trafficClosures,
      trafficDelay,
      roadWeather,
    );
    const trace = httpTraceTransport();
    const elevation = httpElevationProfile();
    return {
      provider: {
        route: async (query, signal) => {
          const result = await provider.route(query, signal);
          return query.details
            ? enrichPlannedResult(result, query, trace, elevation, signal)
            : result;
        },
      },
      trafficClosures,
      // The same corridor measurements the provider prices a new route with,
      // asked again mid-drive so the trip being followed is re-priced too.
      trafficDelay,
      roadWeather,
      trace,
      nvdbLimits: httpNvdbLimits(),
      nvdbLanes: httpNvdbLanes(),
      nvdbCameras: httpNvdbCameras(),
      currentFix: async (timeoutMs): Promise<NavOriginFix> => {
        const geo = await currentPosition(timeoutMs);
        return { fix: toPosition(geo), atMs: geo.timestamp };
      },
      watchFixes: (onFix) => {
        const id = navigator.geolocation.watchPosition(
          (geo) => onFix(toPosition(geo), geo.timestamp),
          () => {
            // A transient watch error is not fatal; the next fix resumes.
          },
          { enableHighAccuracy: true },
        );
        return Promise.resolve(() => navigator.geolocation.clearWatch(id));
      },
      speak: (text) => {
        if (!('speechSynthesis' in window)) return;
        const utterance = new SpeechSynthesisUtterance(text);
        // Instructions are English; without a pinned language a Norwegian
        // system voice garbles them.
        utterance.lang = 'en';
        window.speechSynthesis.speak(utterance);
      },
      stopSpeaking: () => {
        if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      },
      keepAwake,
      watchFacing,
      prepareFacing,
    };
  }, []);

  return useNavigationController(platform);
}
