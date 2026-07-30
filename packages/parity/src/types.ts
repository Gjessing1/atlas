/**
 * The shape of the web ↔ Android parity checklist (ROADMAP §7.6).
 *
 * §7's standing rule is that a difference between the clients is either fixed
 * or recorded as deliberate, and anything else is drift. A prose checklist
 * cannot enforce that: it agrees with the code on the day it is written and
 * rots quietly afterwards, which is precisely how §7.1–§7.5 accumulated in the
 * first place. So the checklist is *data with evidence* — every "both clients
 * have this" claim names a file and a marker in each app, and the test beside
 * it reads them. Delete a capability from one client and the gate goes red
 * until someone either puts it back or writes down why it is now one-sided.
 */

/**
 * The surfaces a user meets, in the order §7.6 names them. Deliberately coarse:
 * this is a checklist to be read at release time, not a component inventory.
 */
export const PARITY_SURFACES = [
  'map',
  'card',
  'collections',
  'search',
  'explore',
  'settings',
  'planner',
  'navigation',
] as const;

export type ParitySurface = (typeof PARITY_SURFACES)[number];

/** Human-readable heading for each surface, for the release-time report. */
export const PARITY_SURFACE_LABELS: Record<ParitySurface, string> = {
  map: 'Map chrome',
  card: 'Place card',
  collections: 'Collections & tracks',
  search: 'Search',
  explore: 'Explore',
  settings: 'Settings',
  planner: 'Route planner',
  navigation: 'Navigation',
};

/**
 * Where a capability can be seen in one client's source.
 *
 * `contains` is a literal substring, not a pattern: a marker that needs a regex
 * to find is too clever to survive a refactor, and the point of the marker is
 * that changing it should be a deliberate act. Prefer the words the user reads
 * ("Photos nearby") or the shared symbol the client calls (`usePlaceFacts`) —
 * both die with the capability, which is what makes them evidence.
 */
export interface ParityEvidence {
  /** Repo-relative path, e.g. `apps/web/src/place/PlaceCard.tsx`. */
  readonly file: string;
  /** A literal substring of that file. */
  readonly contains: string;
}

export interface ParityCapability {
  /** Stable kebab-case id, prefixed with its surface. */
  readonly id: string;
  readonly surface: ParitySurface;
  /** One line, in the user's terms — what they can do, not how it is built. */
  readonly capability: string;
  /** Null when this client does not have it. */
  readonly web: ParityEvidence | null;
  /** Null when this client does not have it. */
  readonly android: ParityEvidence | null;
  /**
   * The `@atlas/app-hooks` export this capability's state lives in, when it has
   * one. §7.6's second rule ("prefer app-hooks for anything with state") is
   * otherwise unobservable — every surface that never drifted is one whose
   * state is already shared, and naming the seam here is what makes a
   * capability with no shared seam visible as the risk it is.
   */
  readonly hook?: string;
  /**
   * Required when only one client has it: why the difference stands. Platform
   * idiom and platform capability both count; "nobody got round to it" does
   * not — that is `open`.
   */
  readonly why?: string;
  /**
   * Set when the one-sided capability is drift we mean to close rather than a
   * deliberate difference. `why` then says what it would take.
   */
  readonly open?: true;
  /**
   * An intentional difference in *how* a capability is reached or delivered on
   * a client that has it (menu vs. map control, clipboard vs. share sheet).
   * Recorded so a reviewer does not "fix" it back into drift.
   */
  readonly note?: string;
  /**
   * A backend route this capability cannot work without.
   *
   * Added because the checklist's first real miss was not a client difference at
   * all: v0.132.0 shipped a commute board and a home-screen widget whose routes
   * had never been deployed, and the row stayed green because it only ever
   * checked that a *sentence* appeared in two files. A client capability that
   * depends on a route it does not own has half its evidence on the server, so
   * that half is named here and resolved by the same gate.
   */
  readonly route?: ParityEvidence;
}

/** Which clients have a capability. */
export function paritySides(
  cap: ParityCapability,
): 'both' | 'web-only' | 'android-only' | 'neither' {
  if (cap.web && cap.android) return 'both';
  if (cap.web) return 'web-only';
  if (cap.android) return 'android-only';
  return 'neither';
}
