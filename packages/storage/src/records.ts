/** A folder for organizing places and tracks; collections may nest via parentId. */
export interface CollectionRecord {
  id: string;
  name: string;
  parentId: string | null;
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
}

export interface TrackPatch {
  name?: string;
  collectionId?: string | null;
  notes?: string;
  tags?: string[];
  visible?: boolean;
}

/** Complete dump of user data, for export-all / backup. */
export interface ExportedData {
  exportedAt: number;
  collections: CollectionRecord[];
  places: PlaceRecord[];
  tracks: (TrackRecord & { gpx: string })[];
  settings: Record<string, string>;
}
