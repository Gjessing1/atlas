/** A folder for organizing places and tracks; collections may nest via parentId. */
export interface CollectionRecord {
  id: string;
  name: string;
  parentId: string | null;
  /** Whether this folder (and its places) is drawn on the map; hides its subtree when off. */
  visible: boolean;
  /** Manual list position (drag-and-drop); lists sort by this, then name. */
  sortIndex: number;
  createdAt: number;
  updatedAt: number;
}

/** A saved place: favorite, named pin, saved search result. */
export interface PlaceRecord {
  id: string;
  name: string;
  lat: number;
  lng: number;
  collectionId: string | null;
  notes: string;
  tags: string[];
  /** Emoji icon shown for the pin (see @atlas/core PLACE_ICONS). */
  icon: string;
  /** Marker colour as a hex string (see @atlas/core PLACE_COLORS). */
  color: string;
  /** Whether the pin is drawn on the map (its folder may still hide it — see @atlas/core placeIsVisible). */
  visible: boolean;
  /** Manual list position (drag-and-drop); lists sort by this, then name. */
  sortIndex: number;
  createdAt: number;
  updatedAt: number;
}

/** A saved track's metadata; the GPX body is fetched separately (it can be large). */
export interface TrackRecord {
  id: string;
  name: string;
  /** Cached summary statistics (structurally @atlas/gpx's TrackStats; storage stays format-agnostic). */
  stats: Record<string, number>;
  collectionId: string | null;
  notes: string;
  tags: string[];
  /** Whether the track is currently drawn on the map. */
  visible: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NewPlace {
  name: string;
  lat: number;
  lng: number;
  collectionId?: string | null;
  notes?: string;
  tags?: string[];
  icon?: string;
  color?: string;
}

export interface NewTrack {
  name: string;
  /** Canonical GPX 1.1 document for the track (rule: everything exportable). */
  gpx: string;
  stats?: Record<string, number>;
  collectionId?: string | null;
  notes?: string;
  tags?: string[];
}

export interface PlacePatch {
  name?: string;
  lat?: number;
  lng?: number;
  collectionId?: string | null;
  notes?: string;
  tags?: string[];
  icon?: string;
  color?: string;
  visible?: boolean;
  sortIndex?: number;
}

/** Editable fields of a folder (name via renameCollection; the rest here). */
export interface CollectionPatch {
  parentId?: string | null;
  visible?: boolean;
  sortIndex?: number;
}

export interface TrackPatch {
  name?: string;
  collectionId?: string | null;
  notes?: string;
  tags?: string[];
  visible?: boolean;
}

/** The record kinds that sync between devices via the server. */
export type SyncEntity = 'collection' | 'place' | 'track' | 'setting';

/**
 * A pending local mutation awaiting push. One entry per record — last-write-wins
 * means only the latest state matters, so newer mutations overwrite older entries.
 */
export interface OutboxEntry {
  entity: SyncEntity;
  /** Record id, or the settings key for entity 'setting'. */
  id: string;
  op: 'upsert' | 'delete';
  updatedAt: number;
}

/**
 * One record state travelling through sync, in either direction.
 * `data` holds the full record payload (minus id/updatedAt); null for deletes.
 */
export interface SyncChange {
  entity: SyncEntity;
  id: string;
  updatedAt: number;
  deleted: boolean;
  data: Record<string, unknown> | null;
}

/**
 * What a delete removed, in the shape needed to put it back (undo). `data` is
 * the same payload `readSyncRecord` produces, so restoring reuses the sync
 * upsert path. Deleting a folder moves its contents up a level rather than
 * deleting them, so a folder's snapshot also lists the children to re-parent.
 */
export interface DeletedRecord {
  entity: SyncEntity;
  id: string;
  data: Record<string, unknown>;
  movedChildren?: { entity: SyncEntity; id: string }[];
}

/** Complete dump of user data, for export-all / backup. */
export interface ExportedData {
  exportedAt: number;
  collections: CollectionRecord[];
  places: PlaceRecord[];
  tracks: (TrackRecord & { gpx: string })[];
  settings: Record<string, string>;
}

/** What an import merged in, per entity (see AtlasStorage.importAll). */
export interface ImportSummary {
  collections: { imported: number; skipped: number };
  places: { imported: number; skipped: number };
  tracks: { imported: number; skipped: number };
  settings: { imported: number; skipped: number };
}

/**
 * Read an untrusted parsed-JSON value as an export dump. Returns null when the
 * file is not an Atlas export at all; individual records that are unusable
 * (missing id, non-finite coordinates) are dropped rather than failing the whole
 * restore — a backup with one bad row should still give the user back the rest.
 *
 * Field-level defaults are deliberately absent here: `importAll` feeds these
 * payloads through the same normalisation the sync-pull path uses, so an export
 * written by an older version reads exactly like an older peer's change.
 */
export function parseExportedData(input: unknown): ExportedData | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;
  // The one required marker: every dump carries these four keys.
  const listOf = (key: string): unknown[] | null =>
    Array.isArray(raw[key]) ? (raw[key] as unknown[]) : null;
  const collections = listOf('collections');
  const places = listOf('places');
  const tracks = listOf('tracks');
  if (!collections || !places || !tracks) return null;

  const withId = (v: unknown): Record<string, unknown> | null => {
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    return typeof r['id'] === 'string' && r['id'] !== '' ? r : null;
  };
  const settings: Record<string, string> = {};
  const rawSettings = raw['settings'];
  if (typeof rawSettings === 'object' && rawSettings !== null) {
    for (const [k, v] of Object.entries(rawSettings as Record<string, unknown>)) {
      if (typeof v === 'string') settings[k] = v;
    }
  }
  return {
    exportedAt: typeof raw['exportedAt'] === 'number' ? raw['exportedAt'] : Date.now(),
    collections: collections.map(withId).filter((r) => r !== null) as unknown as CollectionRecord[],
    // A place with no usable position cannot be put on a map — drop it.
    places: places
      .map(withId)
      .filter(
        (r) => r !== null && Number.isFinite(r['lat']) && Number.isFinite(r['lng']),
      ) as unknown as PlaceRecord[],
    tracks: tracks
      .map(withId)
      .filter((r) => r !== null && typeof r['gpx'] === 'string') as unknown as (TrackRecord & {
      gpx: string;
    })[],
    settings,
  };
}
