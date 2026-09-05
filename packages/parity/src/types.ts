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
 * The user-facing surface a client component *is* — by the name a user would
 * give it (the menu entry that opens it, the heading it wears), never by its
 * file name.
 *
 * This exists because of the checklist's second real miss (ROADMAP §6.1): four
 * `collections` rows resolved web's `Sidebar.tsx` against Android's separate
 * `TracksSheet.tsx` and stayed green for months, while the two clients
 * disagreed about how many saved-data surfaces there even were. A row asks
 * *whether* a client can do a thing and never *where*, so a capability that has
 * drifted onto a differently-named surface is invisible to it — which is drift
 * of exactly the kind §7 exists to catch.
 *
 * Only surface *roots* are listed. Everything else (hooks, rows, cards, shared
 * helpers) has no home of its own and is skipped: it lives wherever the surface
 * that renders it lives.
 */
export const PARITY_SURFACE_HOMES: Readonly<Record<string, string>> = {
  'apps/web/src/Sidebar.tsx': 'Collections',
  'apps/android/src/ui/FavoritesSheet.tsx': 'Collections',
  'apps/web/src/explore/ExplorePanel.tsx': 'Explore',
  'apps/android/src/ui/ExploreSheet.tsx': 'Explore',
  'apps/web/src/transit/CommutePanel.tsx': 'Commute',
  'apps/android/src/ui/CommuteSheet.tsx': 'Commute',
  'apps/web/src/settings/SettingsPanel.tsx': 'Settings',
  // Rendered *inside* the Settings panel's Account & data tab, which is the
  // surface the user is on — Android answers the same rows from its own
  // Settings sheet, and that is not a difference.
  'apps/web/src/sync/AccountPanel.tsx': 'Settings',
  'apps/android/src/ui/SettingsSheet.tsx': 'Settings',
  'apps/web/src/routing/RoutePanel.tsx': 'Route planner',
  'apps/android/src/ui/RoutePanel.tsx': 'Route planner',
  'apps/web/src/potential/StandBoardPanel.tsx': 'Stand board',
  'apps/android/src/ui/StandBoardSheet.tsx': 'Stand board',
  'apps/web/src/satellites/SatellitePassCard.tsx': 'Satellite pass predictor',
  'apps/android/src/ui/SatellitePassSheet.tsx': 'Satellite pass predictor',
  'apps/android/src/ui/TrackProfileSheet.tsx': 'Track profile',
  'apps/android/src/ui/ShareSheet.tsx': 'Share',
  'apps/android/src/nav/AddStopSheet.tsx': 'Add a stop',
};

/**
 * Whether a file is a surface root, and therefore has to declare its home
 * above. Structural on purpose — both apps name these components for what they
 * are (`…Sheet` on Android, `…Panel` on web, plus web's one older `Sidebar`) —
 * so a new surface used as evidence reddens the build until someone says which
 * surface it is, instead of quietly widening the blind spot this closes.
 */
export function isSurfaceComponent(file: string): boolean {
  return /\/(?:\w+(?:Sheet|Panel)|Sidebar)\.tsx$/.test(file);
}

/** The surface a file belongs to, or null when it is not a surface root. */
export function surfaceHome(file: string): string | null {
  return PARITY_SURFACE_HOMES[file] ?? null;
}

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
   * Required when the two clients answer this capability from surfaces the
   * user knows by different names (see {@link PARITY_SURFACE_HOMES}): why that
   * stands. Usually it should not — the same capability on two differently
   * named surfaces is how a user ends up not knowing where their data is.
   */
  readonly crossSurface?: string;
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
