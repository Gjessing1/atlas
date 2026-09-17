import { usePlaceFacts } from '@atlas/app-hooks';
import {
  fmtCoords,
  fmtDistanceM,
  identifyCardGroups,
  identifyExpandLabel,
  identifyLinkLabel,
  identifyValueUrl,
  placeTargetSubtitle,
  shareFormats,
  type LatLng,
  type NearbyPlaceArticle,
  type PlaceContent,
  type PlacePhoto,
  type PlaceTarget,
  type ShareFormat,
} from '@atlas/core';
import { transitCoversPoint } from '@atlas/transit';
import type { PotentialExplainResponse } from '@atlas/potential';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useRef, useState } from 'react';
import { CameraIcon, PencilIcon, RouteIcon, ShareIcon, SunIcon, TrainIcon } from '../icons.js';
import { PotentialExplain } from '../potential/PotentialExplain.js';
import { StandBlock } from './StandBlock.js';
import { useNearbyPhotos, useNearbyPlaces } from './useNearbyPlaces.js';
import { usePlaceContent } from './usePlaceContent.js';
import { StopDepartures } from '../transit/StopDepartures.js';

interface PlaceCardProps {
  target: PlaceTarget;
  /**
   * The derived surface's reading of this spot, when one is switched on and
   * has something to say here (FISH-HUNT-ENGINE.md D4, "tap to explain"). Null covers
   * every quiet case at once — no derived layer, an unprepared cell, or ground
   * the model does not read — because all three should leave the card unchanged.
   */
  potential?: PotentialExplainResponse | null;
  /** Display name of the surface's target, e.g. "Ørret". */
  potentialTarget?: string;
  /** The saved place at this position, if the user already has one. */
  saved: PlaceRecord | undefined;
  /** Saving is unavailable until persistent user storage has finished opening. */
  saveEnabled: boolean;
  /** User's own position, for the "… away" line; null when unknown. */
  userAt: LatLng | null;
  /** A route is being planned, so "Add stop" is meaningful. */
  routeActive: boolean;
  /** The Collections sidebar is open and occupies the card's usual corner. */
  shifted: boolean;
  /** Open the route planner with this point as the destination. */
  onDirections: () => void;
  onSave: () => void;
  /** Open this place's editor, focused on it (saved targets only). */
  onEdit: (place: PlaceRecord) => void;
  onAddStop: () => void;
  /**
   * Act on a chosen share format. Resolves with how it went out: the OS share
   * sheet took it ('shared'), or it went to the clipboard instead ('copied' —
   * the only case the chooser needs to confirm, since a share sheet is its own
   * feedback).
   */
  onShare: (format: ShareFormat) => Promise<'shared' | 'copied'>;
  /** An Atlas link to this exact spot, for the chooser's link option. */
  shareUrl: () => string;
  /** Open the forecast panel on this spot rather than on the map centre. */
  onWeather: () => void;
  /** Remove the dropped pin (pin targets only). */
  onRemovePin: () => void;
  /** Re-aim the card at a described place picked from the nearby list. */
  onShowNearby: (place: NearbyPlaceArticle) => void;
  onClose: () => void;
}

/**
 * The Wikipedia "W" — the same mark on the article head and on every nearby row,
 * so "there is something to read here" is one recognisable thing across the card
 * (and, in the nearby list, tells the described places from the rest at a glance).
 */
function WikiBadge() {
  return (
    <span className="wiki-badge" aria-hidden="true">
      W
    </span>
  );
}

/**
 * Photos taken *near* this spot, from Wikimedia Commons.
 *
 * Most places are not the subject of an article and so have no lead image —
 * which is why a town hall could show nothing at all — but somebody has usually
 * photographed the street. The heading says "nearby" and every tile carries its
 * distance, because the nearest photo may well be of the building opposite;
 * clicking through goes to the Commons file page with the full licence.
 */
function NearbyPhotos({ photos, articles }: { photos: PlacePhoto[]; articles: PlaceContent[] }) {
  const picturedArticles = articles.filter((article) => article.image);
  if (photos.length === 0 && picturedArticles.length === 0) return null;
  return (
    <section className="place-card-photos">
      <div className="place-card-content-head">
        <strong>Photos nearby</strong>
        <a href="https://commons.wikimedia.org" target="_blank" rel="noreferrer">
          Wikimedia Commons
        </a>
      </div>
      <div className="place-card-photo-strip">
        {picturedArticles.map((article) => (
          <a
            key={article.url}
            href={article.url}
            target="_blank"
            rel="noreferrer"
            title={article.title}
          >
            <img
              src={article.image!.url}
              alt={article.title}
              loading="lazy"
              referrerPolicy="no-referrer"
            />
            <span>Article</span>
          </a>
        ))}
        {photos.map((photo) => (
          <a
            key={photo.pageUrl}
            href={photo.pageUrl}
            target="_blank"
            rel="noreferrer"
            title={[photo.title, photo.credit].filter(Boolean).join(' — ')}
          >
            <img src={photo.url} alt={photo.title} loading="lazy" referrerPolicy="no-referrer" />
            {photo.distanceM !== null && <span>{fmtDistanceM(photo.distanceM)}</span>}
          </a>
        ))}
      </div>
    </section>
  );
}

/**
 * Described places around this spot, each opening as a card of its own.
 *
 * Collapsed by default and fetched only when opened — one more Wikimedia round
 * trip per card, on a card that is usually opened to get directions.
 */
function NearbyFeatures({
  at,
  articles,
  onWeather,
  onShowNearby,
}: {
  at: LatLng;
  articles: PlaceContent[];
  onWeather: () => void;
  onShowNearby: (place: NearbyPlaceArticle) => void;
}) {
  const [placesOpen, setPlacesOpen] = useState(false);
  const [photosOpen, setPhotosOpen] = useState(false);
  const nearby = useNearbyPlaces(at, placesOpen);
  const photos = useNearbyPhotos(at, photosOpen);
  const hasPhotos = photos.photos.length > 0 || articles.some((article) => article.image);
  useEffect(() => {
    setPlacesOpen(false);
    setPhotosOpen(false);
  }, [at.lat, at.lng]);

  return (
    <section className="place-card-nearby">
      <div className="place-card-nearby-buttons">
        <button
          type="button"
          className="place-card-nearby-toggle"
          aria-expanded={photosOpen}
          aria-label="Photos nearby"
          onClick={() => setPhotosOpen((value) => !value)}
        >
          <CameraIcon size={15} /> Nearby
        </button>
        <button
          type="button"
          className="place-card-nearby-toggle"
          aria-expanded={placesOpen}
          aria-label="Nearby places"
          onClick={() => setPlacesOpen((value) => !value)}
        >
          <WikiBadge />
          Nearby
        </button>
        <button
          type="button"
          className="place-card-nearby-weather"
          onClick={onWeather}
          aria-label="Weather"
          title="Weather"
        >
          <SunIcon size={17} />
        </button>
      </div>
      {photosOpen && photos.status === 'loading' && !hasPhotos && (
        <p className="place-card-sub">Looking for photos…</p>
      )}
      {photosOpen && photos.status === 'ready' && !hasPhotos && (
        <p className="place-card-sub">No nearby photos found.</p>
      )}
      {photosOpen && <NearbyPhotos photos={photos.photos} articles={articles} />}
      {placesOpen && nearby.status === 'loading' && (
        <p className="place-card-sub">Looking around…</p>
      )}
      {placesOpen && nearby.status === 'ready' && nearby.places.length === 0 && (
        <p className="place-card-sub">Nothing described within a couple of kilometres.</p>
      )}
      {placesOpen && nearby.places.length > 0 && (
        <ul>
          {nearby.places.map((place) => (
            <li key={place.url}>
              <button type="button" onClick={() => onShowNearby(place)}>
                {place.image ? (
                  <img
                    src={place.image.url}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="place-card-nearby-thumb"
                  />
                ) : (
                  <span className="place-card-nearby-thumb place-card-nearby-thumb-empty" />
                )}
                <span className="place-card-nearby-text">
                  <strong>
                    <WikiBadge />
                    {place.title}
                  </strong>
                  <span>
                    {fmtDistanceM(place.distanceM)} away · {place.extract}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What the visible overlays say sits here — a lake's surveyed depth, a parcel's
 * number — as a block *inside* the card.
 *
 * It used to be a separate MapLibre popup with its own unstyled markup and its
 * own row caps, so one click on one lake could produce two surfaces describing
 * the same spot in two visual languages. The answers belong to the point the
 * card is already about; the caps are `identifyCardGroups`', shared with
 * Android so both clients cut a chatty upstream at the same place.
 *
 * Scrolls within a fixed height for the same reason Android's does: no upstream
 * gets to push the card's actions out of reach.
 *
 * The first answer of each overlay is the one under the finger; the distance
 * beside a heading is what tells a reader that *this* row is about the well 40 m
 * up the road rather than the one they aimed at.
 */
function IdentifyBlock({ groups }: { groups: PlaceTarget['identify'] }) {
  const shown = identifyCardGroups(groups ?? []);
  // A surveyor's field description runs to paragraphs, and the block is a fixed
  // scroll box — so a long answer was there but looked cut. The reader opens it.
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = box.current;
    // 4 px of slack: a sub-pixel line height must not put a permanent "Show
    // more" under a block that shows everything already.
    setClipped(!!el && el.scrollHeight > el.clientHeight + 4);
    // Keyed on the answers themselves, not on the array `identifyCardGroups`
    // rebuilds every render — a state-setting effect with an unstable dep is
    // the shape that has cost this app a render loop before.
  }, [groups, expanded]);
  if (shown.length === 0) return null;
  return (
    <>
      <div
        className={`place-card-identify${expanded ? ' expanded' : ''}`}
        data-testid="place-card-identify"
        ref={box}
      >
        {shown.map((group, i) => (
          <section key={`${group.title}-${i}`}>
            <strong>
              {group.title}
              {group.distance ? <em>{group.distance}</em> : null}
            </strong>
            {group.rows.map(([key, value]) => {
              const url = identifyValueUrl(value);
              return (
                <div className="place-card-identify-row" key={key}>
                  <span>{key}</span>
                  {url ? (
                    // The register's own record. An anchor rather than text, so
                    // it can be opened, copied and long-pressed like any link.
                    <a
                      className="place-card-identify-link"
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {identifyLinkLabel(url)} ↗
                    </a>
                  ) : (
                    <span>{value}</span>
                  )}
                </div>
              );
            })}
            {group.note ? <p className="place-card-identify-note">{group.note}</p> : null}
          </section>
        ))}
      </div>
      {clipped || expanded ? (
        <button
          type="button"
          className="place-card-identify-more"
          onClick={() => setExpanded((open) => !open)}
        >
          {identifyExpandLabel(expanded)}
        </button>
      ) : null}
    </>
  );
}

/**
 * How to send this spot somewhere — the same chooser, with the same wording and
 * order, as the Android sheet (`shareFormats` in @atlas/core owns the list).
 *
 * Web previously had a Share button and a separate Copy coords one, which is
 * two ways to answer one question and neither of them the Android answer. One
 * button now opens the list, and each option says what the recipient actually
 * gets; the `geo:` hand-off is absent here because a desktop browser has no map
 * app to hand the point to.
 */
function ShareChooser({
  formats,
  onPick,
  onClose,
}: {
  formats: readonly ShareFormat[];
  onPick: (format: ShareFormat) => void;
  onClose: () => void;
}) {
  return (
    <div className="place-card-share" role="menu" data-testid="place-card-share">
      {formats.map((format) => (
        <button
          key={format.key}
          type="button"
          role="menuitem"
          onClick={() => onPick(format)}
          data-testid={`share-${format.key}`}
        >
          <strong>{format.title}</strong>
          <span>{format.subtitle}</span>
        </button>
      ))}
      <button type="button" className="place-card-share-cancel" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

/**
 * One card for every way of pointing at a spot: a dropped pin, a saved place, a
 * POI tapped on the map, a picked search result.
 *
 * It replaces three ad-hoc MapLibre popups that showed different information and
 * offered different actions for the same underlying thing — a POI could not be
 * navigated to, a saved place could only show its name, and only the pin could
 * be shared. The actions are the same set every time; only the ones that cannot
 * apply are left out.
 *
 * Like the Android card, it deliberately does **not** choose a travel mode:
 * "Directions" opens the route planner with this point as the destination, and
 * every mode decision — including public transport, which needs a journey board
 * this card has no room for — lives there, in one place.
 */
export function PlaceCard({
  target,
  potential,
  potentialTarget,
  saved,
  saveEnabled,
  userAt,
  routeActive,
  shifted,
  onDirections,
  onSave,
  onEdit,
  onAddStop,
  onShare,
  shareUrl,
  onWeather,
  onRemovePin,
  onShowNearby,
  onClose,
}: PlaceCardProps) {
  const [copied, setCopied] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [departuresOpen, setDeparturesOpen] = useState(false);
  // Clear the "Copied" confirmation; a second copy restarts the timer.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  // A chooser left open from the previous spot would share the new one under
  // the old one's coordinates.
  useEffect(() => {
    setShareOpen(false);
    setDeparturesOpen(false);
  }, [target.position.lat, target.position.lng]);

  const coords = fmtCoords(target.position);
  const subtitle = placeTargetSubtitle(target, userAt);
  // A pin the user saved and named keeps showing its coordinates otherwise: the
  // target is a bare coordinate and knows nothing of the place now standing on
  // it. The card already claims that spot *is* that place — it offers Edit for
  // it — so it should call it by the name the user gave it.
  const title = target.name?.trim() || saved?.name || coords;
  // A bare pin already shows its coordinates as the heading; don't repeat them.
  const showCoords = title !== coords;

  // Both "what is this spot like" facts from one shared hook, so the two cards
  // cannot end up with different halves of the pair.
  const { elevation, light } = usePlaceFacts('', target.position);
  const placeContent = usePlaceContent(target.name, target.position);

  return (
    <div className={`place-card${shifted ? ' place-card-shifted' : ''}`} role="dialog">
      <div className="place-card-head">
        <div className="place-card-titles">
          <strong>{title}</strong>
          {subtitle && <span className="place-card-sub">{subtitle}</span>}
          {showCoords && <code className="place-card-coords">{coords}</code>}
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {/* What this spot is like, as opposed to what you can do with it. Elevation
          is fetched and Norway-only, so it states its own absence rather than
          silently leaving the row short. */}
      <dl className="place-card-facts">
        <div>
          <dt>Elevation</dt>
          <dd>
            {elevation.status === 'loading' && '…'}
            {elevation.status === 'error' && 'unavailable'}
            {elevation.status === 'ready' &&
              (elevation.elevationM === null
                ? 'no data here'
                : `${Math.round(elevation.elevationM)} m`)}
          </dd>
        </div>
        {light && (
          <div>
            <dt>Daylight</dt>
            <dd>{light}</dd>
          </div>
        )}
      </dl>
      {/* Why the derived surface scores this spot the way it does. Above the
          encyclopaedia content on purpose: the user tapped the water they were
          looking at, and the answer to *that* comes before a Wikipedia article
          about the lake. */}
      {/* And above that again when this pin *is* a stand: the surface explains
          the ground, but the reason the user saved this exact point — which way
          to face, and whether the walk in burns it — is the stand plan, and it
          is the answer they came back for. */}
      {saved?.stand && <StandBlock stand={saved.stand} />}
      {potential && <PotentialExplain data={potential} targetLabel={potentialTarget} />}
      {/* And above the overlays' own answers, for the same reason. */}
      <IdentifyBlock groups={target.identify} />
      {placeContent.status === 'loading' && target.name ? (
        <div className="place-card-content place-card-content-loading">Looking up local guide…</div>
      ) : null}
      {placeContent.content.map((article) => (
        <section className="place-card-content" key={`${article.source}/${article.url}`}>
          <div className="place-card-content-head">
            <strong>
              <WikiBadge />
              {article.source === 'wikipedia' ? 'Wikipedia' : 'Wikivoyage'}
            </strong>
            <a href={article.url} target="_blank" rel="noreferrer">
              Read article
            </a>
          </div>
          <p>{article.extract}</p>
        </section>
      ))}
      {/* Images stay behind their own deliberate action: opening a marker card
          no longer spends bandwidth or lets a photo push its actions away. */}
      <NearbyFeatures
        at={target.position}
        articles={placeContent.content}
        onWeather={onWeather}
        onShowNearby={onShowNearby}
      />
      <div className="place-card-actions">
        <button type="button" className="primary" onClick={onDirections}>
          <RouteIcon size={17} />
          Directions
        </button>
        {routeActive && (
          <button type="button" onClick={onAddStop}>
            Add stop
          </button>
        )}
        {/* Already saved: the useful action is editing *this* place — renaming
            it, filing it, adding a note — not being shown that it exists. */}
        {saved ? (
          <button
            type="button"
            className="icon-only tertiary"
            onClick={() => onEdit(saved)}
            aria-label="Edit"
            title="Edit"
          >
            <PencilIcon size={17} />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSave}
            disabled={!saveEnabled}
            title={saveEnabled ? undefined : 'Opening your collections…'}
          >
            Save
          </button>
        )}
        {transitCoversPoint(target.position) && (
          <button
            type="button"
            aria-expanded={departuresOpen}
            onClick={() => setDeparturesOpen((open) => !open)}
          >
            <TrainIcon size={17} />
            Departures
          </button>
        )}
        <button
          type="button"
          className="icon-only"
          aria-expanded={shareOpen}
          onClick={() => setShareOpen((open) => !open)}
          aria-label={copied ? 'Link copied' : 'Share'}
          title={copied ? 'Copied' : 'Share'}
        >
          <ShareIcon size={17} />
        </button>
        {target.source === 'pin' && (
          <button type="button" onClick={onRemovePin}>
            Remove pin
          </button>
        )}
      </div>
      {departuresOpen && (
        <StopDepartures
          location={{
            ...target.position,
            ...(target.transitStopId ? { stopId: target.transitStopId } : {}),
          }}
        />
      )}
      {shareOpen && (
        <ShareChooser
          // Built when the chooser opens rather than per render: the link
          // carries the camera's zoom, which changes under an open card.
          formats={shareFormats(target.position, target.name, shareUrl())}
          onPick={(format) => {
            setShareOpen(false);
            void onShare(format).then((how) => {
              if (how === 'copied') setCopied(true);
            });
          }}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}
