/**
 * Filtering the collections tree — one matcher for both apps (ROADMAP §6.2).
 *
 * After a season a hunter has a folder of stands, several imported permits and
 * a few dozen pins, and neither client had any way through them but scrolling a
 * tree whose folders start collapsed. Worse, the app writes metadata it could
 * not read back: `spotPlaceDraft()` tags every saved stand `hunt`/`spot`/`stand`
 * and nothing anywhere could answer "show me my stands".
 *
 * So the filter matches what the record actually carries — name, tags, notes,
 * and a place's address — and a leading `#` narrows it to tags alone, which is
 * what a tapped tag chip writes into the box. Keeping the syntax *visible* in
 * the input matters: the chip is a shortcut for something the user can then
 * edit or clear, not a second hidden mode.
 */

/** What a filterable record has to expose; apps pass their records straight in. */
export interface FilterableRecord {
  name: string;
  tags?: readonly string[];
  notes?: string;
  address?: string;
}

/** A folder, for the tree-shaped half of filtering. */
export interface FilterableFolder {
  id: string;
  name: string;
  parentId: string | null;
}

/** An item filed (or not) in a folder. */
export interface FilterableItem extends FilterableRecord {
  collectionId: string | null;
}

/** A query read as either free text or a tag. */
export interface CollectionQuery {
  /** Lower-cased text to match; empty when the query is blank. */
  readonly text: string;
  /** True when the query was written `#tag` — match tags and nothing else. */
  readonly tagOnly: boolean;
}

/** Read the raw input from the filter box. */
export function parseCollectionQuery(query: string): CollectionQuery {
  const raw = query.trim();
  const tagOnly = raw.startsWith('#');
  return { text: (tagOnly ? raw.slice(1) : raw).trim().toLowerCase(), tagOnly };
}

/** The query a tag chip writes when tapped. */
export function tagQuery(tag: string): string {
  return `#${tag}`;
}

const hasTag = (record: FilterableRecord, text: string): boolean =>
  (record.tags ?? []).some((tag) => tag.toLowerCase().includes(text));

/**
 * Whether one record answers the query. Tag mode is deliberately a `includes`
 * over the whole tag rather than an exact match: a chip writes the tag in full,
 * and someone typing `#sta` by hand means the same thing.
 */
export function recordMatchesQuery(record: FilterableRecord, query: CollectionQuery): boolean {
  const { text, tagOnly } = query;
  if (text.length === 0) return true;
  if (tagOnly) return hasTag(record, text);
  return (
    record.name.toLowerCase().includes(text) ||
    hasTag(record, text) ||
    (record.notes ?? '').toLowerCase().includes(text) ||
    (record.address ?? '').toLowerCase().includes(text)
  );
}

export interface CollectionFilterInput<
  C extends FilterableFolder,
  P extends FilterableItem,
  T extends FilterableItem,
> {
  collections: readonly C[];
  places: readonly P[];
  tracks: readonly T[];
}

export interface CollectionFilterResult<
  C extends FilterableFolder,
  P extends FilterableItem,
  T extends FilterableItem,
> {
  collections: C[];
  places: P[];
  tracks: T[];
  /** False when the query is blank — the inputs come back untouched. */
  active: boolean;
  /** Nothing matched. The apps say so rather than drawing an empty tree. */
  empty: boolean;
}

/**
 * The records a query leaves standing, ready to hand to `useCollectionTree`.
 *
 * Three rules, in the order they surprise people:
 *
 * - A folder whose **name** matches keeps its whole subtree. "Show me the
 *   Stands folder" means its contents, not an empty folder row.
 * - A folder is also kept when anything **inside** it survives, and so is every
 *   folder above it — otherwise a match two levels down would render at the
 *   root and lose the one piece of context that says which set it belongs to.
 * - Nothing else is kept. A folder that neither matches nor holds a match is
 *   gone for as long as the query stands.
 */
export function filterCollectionRecords<
  C extends FilterableFolder,
  P extends FilterableItem,
  T extends FilterableItem,
>(input: CollectionFilterInput<C, P, T>, query: string): CollectionFilterResult<C, P, T> {
  const parsed = parseCollectionQuery(query);
  const { collections, places, tracks } = input;
  if (parsed.text.length === 0) {
    return {
      collections: [...collections],
      places: [...places],
      tracks: [...tracks],
      active: false,
      empty: collections.length + places.length + tracks.length === 0,
    };
  }

  const byId = new Map(collections.map((folder) => [folder.id, folder]));
  /** Folder ids from this one up to the root; stops on a missing or cyclic parent. */
  const ancestry = (id: string | null): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current = id;
    while (current !== null && !seen.has(current)) {
      const folder = byId.get(current);
      if (!folder) break;
      seen.add(current);
      chain.push(current);
      current = folder.parentId;
    }
    return chain;
  };

  // A folder name is a name, not a tag: in tag mode no folder matches directly,
  // and folders survive only by what they hold.
  const named = new Set(
    parsed.tagOnly
      ? []
      : collections
          .filter((folder) => folder.name.toLowerCase().includes(parsed.text))
          .map((folder) => folder.id),
  );
  // Everything under a named folder comes with it.
  const whole = new Set<string>();
  for (const folder of collections) {
    if (ancestry(folder.id).some((id) => named.has(id))) whole.add(folder.id);
  }

  const keptItem = (item: FilterableItem): boolean =>
    (item.collectionId !== null && whole.has(item.collectionId)) ||
    recordMatchesQuery(item, parsed);

  const keptPlaces = places.filter(keptItem);
  const keptTracks = tracks.filter(keptItem);

  // The folders to draw: the kept subtrees, plus the path down to every kept item.
  const keptFolders = new Set(whole);
  for (const item of [...keptPlaces, ...keptTracks]) {
    for (const id of ancestry(item.collectionId)) keptFolders.add(id);
  }
  for (const id of [...keptFolders]) {
    for (const ancestor of ancestry(id)) keptFolders.add(ancestor);
  }

  const keptCollections = collections.filter((folder) => keptFolders.has(folder.id));
  return {
    collections: keptCollections,
    places: keptPlaces,
    tracks: keptTracks,
    active: true,
    empty: keptCollections.length + keptPlaces.length + keptTracks.length === 0,
  };
}
