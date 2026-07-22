import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Native bridge to the embedded Valhalla routing engine (libvalhalla compiled
 * for Android, driven over JNI). One engine instance at a time: `open` points
 * it at a region pack's tile extract, `route` speaks Valhalla's /route JSON —
 * the exact wire format @atlas/routing's buildValhallaRequest/
 * parseValhallaResponse already use for the server, which is what makes
 * offline and online routing interchangeable.
 */
export interface ValhallaNativeModule {
  /** (Re)create the engine from a full Valhalla config JSON. */
  open(configJson: string): Promise<void>;
  /** Run a route request (Valhalla /route JSON in, response JSON out). */
  route(requestJson: string): Promise<string>;
  /**
   * Run a `/trace_attributes` request (JSON in, response JSON out) — per-edge
   * road attributes (speed limits, tunnels) for navigation enrichment. The
   * data is in the same tiles a route came from, so an offline drive gets the
   * same enrichment an online one does.
   */
  traceAttributes(requestJson: string): Promise<string>;
  /** Tear the engine down and release the tile extract. */
  close(): Promise<void>;
}

/** Null in app builds that predate the native module — callers fall back to online routing. */
export const Valhalla = requireOptionalNativeModule<ValhallaNativeModule>('Valhalla');
