import { sunDay, type SunDay } from '@atlas/conditions';
import {
  fmtClock,
  fmtCoords,
  fmtDistanceM,
  placeTargetSubtitle,
  type LatLng,
  type NearbyPlaceArticle,
  type PlaceContent,
  type PlacePhoto,
  type PlaceTarget,
} from '@atlas/core';
import type { PotentialExplainResponse } from '@atlas/potential';
import type { PlaceRecord } from '@atlas/storage';
import { useEffect, useMemo, useState } from 'react';
import { PotentialExplain } from '../potential/PotentialExplain.js';
import { useElevation } from './useElevation.js';
import { useNearbyPhotos, useNearbyPlaces } from './useNearbyPlaces.js';
import { usePlaceContent } from './usePlaceContent.js';

interface PlaceCardProps {
  target: PlaceTarget;
  /**
   * The derived surface's reading of this spot, when one is switched on and
   * has something to say here (ROADMAP § N5, "tap to explain"). Null covers
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
   * Share this spot. Resolves with how it went out: the OS share sheet took it
   * ('shared'), or it went to the clipboard instead ('copied' — the only case
   * the button needs to confirm, since a share sheet is its own feedback).
   */
  onShare: () => Promise<'shared' | 'copied'>;
  /** Open the forecast panel on this spot rather than on the map centre. */
  onWeather: () => void;
  /** Remove the dropped pin (pin targets only). */
  onRemovePin: () => void;
  /** Re-aim the card at a described place picked from the nearby list. */
  onShowNearby: (place: NearbyPlaceArticle) => void;
  onClose: () => void;
}

/**
 * The day's light in one line: sunrise/sunset and how long the day is, or what
 * is happening instead when the sun does not cross the horizon at all.
 *
 * Both polar branches still check `dawn`/`dusk` rather than assuming twilight
 * exists. It does at Tromsø in December — the sun reaches about -3° at noon, so
 * there are usable hours — but not far enough north (Svalbard, deep winter),
 * where the sun stays below -6° all day and there is no twilight to name.
 */
function describeLight(sun: SunDay): string {
  if (sun.polar === 'day') return 'Midnight sun — the sun stays up all day';
  if (sun.polar === 'night') {
    if (!sun.dawn || !sun.dusk) return 'Polar night — no daylight or twilight';
    return `Polar night — twilight ${fmtClock(sun.dawn.valueOf())}–${fmtClock(sun.dusk.valueOf())}`;
  }
  if (!sun.sunrise || !sun.sunset) return '';
  const hours = Math.floor(sun.daylightMs / 3600000);
  const minutes = Math.round((sun.daylightMs % 3600000) / 60000);
  return `↑ ${fmtClock(sun.sunrise.valueOf())} · ↓ ${fmtClock(sun.sunset.valueOf())} · ${hours} h ${minutes} min of daylight`;
}

/**
 * The article's lead photo, linked to the article like the "Read article" line
 * beside it — a photo is how you recognise a place, so the Wikipedia block is
 * not text-only when we are online.
 *
 * It reserves its aspect ratio up front (no reflow when the image lands) and
 * removes itself if the file fails to load: a broken-image glyph in the middle
 * of a card is worse than no photo at all, and Commons files do get renamed.
 */
function ArticleImage({ article }: { article: PlaceContent }) {
  const [failed, setFailed] = useState(false);
  const image = article.image;
  // Reset when the card moves on to a different article.
  useEffect(() => setFailed(false), [image?.url]);
  if (!image || failed) return null;
  return (
    <a
      className="place-card-content-image"
      href={article.url}
      target="_blank"
      rel="noreferrer"
      style={{ aspectRatio: `${image.width} / ${image.height}` }}
    >
      <img
        src={image.url}
        alt={article.title}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </a>
  );
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
function NearbyPhotos({ photos }: { photos: PlacePhoto[] }) {
  if (photos.length === 0) return null;
  return (
    <section className="place-card-photos">
      <div className="place-card-content-head">
        <strong>Photos nearby</strong>
        <a href="https://commons.wikimedia.org" target="_blank" rel="noreferrer">
          Wikimedia Commons
        </a>
      </div>
      <div className="place-card-photo-strip">
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
function NearbyArticles({
  at,
  onShowNearby,
}: {
  at: LatLng;
  onShowNearby: (place: NearbyPlaceArticle) => void;
}) {
  const [open, setOpen] = useState(false);
  const nearby = useNearbyPlaces(at, open);

  return (
    <section className="place-card-nearby">
      <button
        type="button"
        className="place-card-nearby-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <WikiBadge />
        Nearby places
      </button>
      {open && nearby.status === 'loading' && <p className="place-card-sub">Looking around…</p>}
      {open && nearby.status === 'ready' && nearby.places.length === 0 && (
        <p className="place-card-sub">Nothing described within a couple of kilometres.</p>
      )}
      {open && nearby.places.length > 0 && (
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
  onWeather,
  onRemovePin,
  onShowNearby,
  onClose,
}: PlaceCardProps) {
  const [copied, setCopied] = useState<'coords' | 'link' | null>(null);
  // Clear the "Copied" confirmation; a second copy restarts the timer.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const coords = fmtCoords(target.position);
  const subtitle = placeTargetSubtitle(target, userAt);
  // A pin the user saved and named keeps showing its coordinates otherwise: the
  // target is a bare coordinate and knows nothing of the place now standing on
  // it. The card already claims that spot *is* that place — it offers ★ Edit for
  // it — so it should call it by the name the user gave it.
  const title = target.name?.trim() || saved?.name || coords;
  // A bare pin already shows its coordinates as the heading; don't repeat them.
  const showCoords = title !== coords;

  const elevation = useElevation(target.position);
  const placeContent = usePlaceContent(target.name, target.position);
  const hasArticleImage = placeContent.content.some((article) => article.image);
  // Asked as the card opens, and dropped as soon as the article's own lead
  // photo lands — a card shows one photo block, never two.
  const photos = useNearbyPhotos(target.position, !hasArticleImage);
  // Sun times are pure local maths (no network, no coverage limits), so unlike
  // elevation they are always available — recomputed per position, and per day
  // only in the sense that the card is short-lived.
  const sun = useMemo(
    () => sunDay(new Date(), target.position.lat, target.position.lng),
    [target.position.lat, target.position.lng],
  );
  const light = describeLight(sun);

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
            <dt>Light</dt>
            <dd>{light}</dd>
          </div>
        )}
      </dl>
      {/* Why the derived surface scores this spot the way it does. Above the
          encyclopaedia content on purpose: the user tapped the water they were
          looking at, and the answer to *that* comes before a Wikipedia article
          about the lake. */}
      {potential && <PotentialExplain data={potential} targetLabel={potentialTarget} />}
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
          <ArticleImage article={article} />
          <p>{article.extract}</p>
        </section>
      ))}
      {/* Only when the article did not bring its own photo — one photo block
          per card, and the article's own picture is the better one. */}
      {!hasArticleImage && <NearbyPhotos photos={photos.photos} />}
      <NearbyArticles at={target.position} onShowNearby={onShowNearby} />
      <div className="place-card-actions">
        <button type="button" className="primary" onClick={onDirections}>
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
          <button type="button" onClick={() => onEdit(saved)}>
            ★ Edit
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
        <button type="button" onClick={onWeather}>
          Weather
        </button>
        <button
          type="button"
          onClick={() => {
            void onShare().then((how) => {
              if (how === 'copied') setCopied('link');
            });
          }}
        >
          {copied === 'link' ? 'Copied' : 'Share'}
        </button>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(coords);
            setCopied('coords');
          }}
        >
          {copied === 'coords' ? 'Copied' : 'Copy coords'}
        </button>
        {target.source === 'pin' && (
          <button type="button" onClick={onRemovePin}>
            Remove pin
          </button>
        )}
      </div>
    </div>
  );
}
