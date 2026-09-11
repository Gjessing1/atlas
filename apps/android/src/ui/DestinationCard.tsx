import { usePlaceFacts } from '@atlas/app-hooks';
import {
  fmtDistanceM,
  identifyCardGroups,
  identifyCardLines,
  identifyExpandLabel,
  identifyLinkLabel,
  identifyValueUrl,
  WIKIMEDIA_USER_AGENT,
  type NearbyPlaceArticle,
  type OverlayIdentifyGroup,
  type PlaceStand,
} from '@atlas/core';
import { transitCoversPoint } from '@atlas/transit';
import type { PotentialExplainResponse } from '@atlas/potential';
import { useEffect, useRef, useState } from 'react';
import { Image, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useNearbyPhotos, useNearbyPlaces } from '../place/useNearbyPlaces';
import { usePlaceContent } from '../place/usePlaceContent';
import type { LocalPack } from '../regions/packs';
import { useServerOrigin } from '../serverOrigin';
import { BottomSheet, type BottomSheetHandle } from './BottomSheet';
import { copyToClipboard } from './clipboard';
import { PotentialExplainCard } from './PotentialExplainCard';
import { StandBlock } from './StandBlock';
import { StopDepartures } from './StopDepartures';
import { WeatherIcon } from './icons';
import { theme } from './theme';

/**
 * A Wikimedia image, asked for the way Wikimedia requires.
 *
 * `upload.wikimedia.org` rejects the image loader's stock `okhttp/…` user
 * agent with 403, which is why every Wikipedia thumbnail on Android rendered
 * as a black rectangle. The array form of `source` is deliberate: React
 * Native only forwards `headers` to the native loader for source *lists*.
 */
function wikimediaSource(uri: string) {
  return [{ uri, headers: { 'User-Agent': WIKIMEDIA_USER_AGENT } }];
}

export interface DestinationTarget {
  lat: number;
  lng: number;
  /** Label to show (search result name, place name, or coordinates). */
  name: string;
  /** Secondary line, e.g. a tapped POI's category ("cafe · restaurant"). */
  detail?: string;
  /** Postal/street address for search hits and saved places. */
  address?: string;
  /** Search results / long-press points can be saved as a pin; saved places can't. */
  canSave?: boolean;
  /**
   * The user never named this spot — `name` is its coordinates, filled in so the
   * card has a heading. Saving it produces a pin called "59.9139, 10.7522", so
   * the editor opens on it straight afterwards to be named.
   */
  unnamed?: boolean;
  /** Set when the target is a saved place — enables the Edit action. */
  placeId?: string;
  /** Exact National Stop Register identity, when picked from Entur stop search. */
  transitStopId?: string;
  /**
   * What the visible overlays say sits here (tap-to-identify: a lake's surveyed
   * depth, a parcel's number). Arrives after the card opens — the network round
   * trip must not delay the actions.
   */
  identify?: OverlayIdentifyGroup[];
}

/**
 * The Wikipedia "W" — the same mark on the article head and on every nearby
 * row, so "there is something to read here" reads as one thing across the card.
 */
function WikiBadge() {
  return (
    <View style={styles.wikiBadge}>
      <Text style={styles.wikiBadgeText}>W</Text>
    </View>
  );
}

/**
 * The two "what is this spot like" facts, above everything about what can be
 * *done* with the spot. Elevation is fetched and Norway-only, so it states its
 * own absence rather than silently leaving the row short; light is local maths
 * and is simply omitted on the rare day it has nothing to say.
 */
function PlaceFacts({ elevation, light }: ReturnType<typeof usePlaceFacts>) {
  return (
    <View style={styles.facts} testID="destination-facts">
      <View style={styles.factRow}>
        <Text style={styles.factLabel}>Elevation</Text>
        <Text style={styles.factValue}>
          {elevation.status === 'loading'
            ? '…'
            : elevation.status === 'error'
              ? 'unavailable'
              : elevation.status === 'ready'
                ? elevation.elevationM === null
                  ? 'no data here'
                  : `${Math.round(elevation.elevationM)} m`
                : ''}
        </Text>
      </View>
      {light ? (
        <View style={styles.factRow}>
          <Text style={styles.factLabel}>Light</Text>
          <Text style={styles.factValue}>{light}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Bottom card shown after a *place* is picked (search result, long-press, saved
 * place or favorite): what is here, and what can be done with it.
 *
 * It deliberately does **not** choose a travel mode. It used to, which meant
 * the app had two mode pickers with different visual languages — tiles here,
 * chips in the RoutePanel — and which one you got depended on whether you had
 * arrived from a map pin or from the menu button. Worse, the transit hand-off
 * threw the place's name away and the planner opened showing bare coordinates.
 * Now "Directions" opens the RoutePanel with this point already set as the
 * destination, and every mode decision lives there, in one place.
 */
export function DestinationCard({
  target,
  packs,
  potential,
  potentialTarget,
  stand,
  onDirections,
  onSave,
  onEdit,
  onShare,
  onWeather,
  onPickNearby,
  onCancel,
  bottomInset = 0,
}: {
  target: DestinationTarget;
  /**
   * The derived surface's reading of this spot, when one is on and has
   * something to say here (FISH-HUNT-ENGINE.md D4, "tap to explain"). Null covers every quiet
   * case — no derived layer, an unprepared cell, ground the model does not
   * read — because all three should leave the card unchanged.
   */
  potential?: PotentialExplainResponse | null;
  /** Display name of the surface's target, e.g. "Ørret". */
  potentialTarget?: string;
  /**
   * The stand plan this pin was saved as, when it came from the Fish & Hunt
   * shortlist. Read from the saved place rather than from the live surface: it
   * is the decision the user recorded, and it must still read months later with
   * nothing derived and no network.
   */
  stand?: PlaceStand | null;
  /** Downloaded regions supply article text before the network is tried. */
  packs: LocalPack[];
  /** Open the route planner with this point as the destination. */
  onDirections: () => void;
  onSave?: () => void;
  /** Open the saved place's edit panel (only for targets with a placeId). */
  onEdit?: () => void;
  /** Share the point as a web #map= link via the OS share sheet. */
  onShare: () => void;
  /** Open the weather & conditions sheet for this point. */
  onWeather: () => void;
  /** Re-aim the card at a described place picked from the nearby list. */
  onPickNearby: (place: NearbyPlaceArticle) => void;
  onCancel: () => void;
  bottomInset?: number;
}) {
  // Capped by the shared helper, so a chatty upstream is cut at the same place
  // on both clients rather than at whatever number each card happened to pick.
  const identify = identifyCardGroups(target.identify ?? []);
  // The block is 132 px — about six lines. More than that is clipped, and only
  // then is there anything for "Show more" to do.
  const identifyClipped = identifyCardLines(identify) > 6;
  const at = { lat: target.lat, lng: target.lng };
  const facts = usePlaceFacts(useServerOrigin(), at);
  const content = usePlaceContent(packs, target.name, at);
  const [photosOpen, setPhotosOpen] = useState(false);
  // Photos are a deliberate feature beside Nearby places, not eager card
  // decoration. Nothing is downloaded until that action is opened.
  const photos = useNearbyPhotos(at, photosOpen);
  const [nearbyOpen, setNearbyOpen] = useState(false);
  // Whether the overlay answers are opened out of their clipped box.
  const [identifyOpen, setIdentifyOpen] = useState(false);
  const [departuresOpen, setDeparturesOpen] = useState(false);
  const nearby = useNearbyPlaces(packs, at, nearbyOpen);
  // Every point is a new question — a list left open from the previous card
  // would describe somewhere the user has already moved on from.
  useEffect(() => {
    setNearbyOpen(false);
    setPhotosOpen(false);
    setDeparturesOpen(false);
    setIdentifyOpen(false);
  }, [target.lat, target.lng]);
  /**
   * Reading is a bigger sheet than tapping "Directions".
   *
   * The card opens peeked, which is right for a pin you tapped to route to —
   * but the moment the point is one the user is *reading about*, a peeked sheet
   * is a keyhole: opening the nearby list pushed the actions off it, and
   * picking a place from that list replaced the card with an article whose
   * first line was all that fit. Both gestures now raise the sheet themselves.
   */
  const sheet = useRef<BottomSheetHandle>(null);
  const expand = () => sheet.current?.snapTo('half');
  // A single tap on Directions/Save/Edit hands the point off and closes the
  // card, but a fast second tap arrives before the card unmounts and used to
  // fire the action twice — adding the same stop, or saving the same pin,
  // twice. Latch on the first fire (reset when the card shows a new point) so
  // only the first tap counts. Weather/Share reopen the same sheet, so they
  // don't need it.
  const fired = useRef(false);
  useEffect(() => {
    fired.current = false;
  }, [target.lat, target.lng, target.placeId]);
  const once = (fn: () => void) => () => {
    if (fired.current) return;
    fired.current = true;
    fn();
  };

  return (
    // The action row can wrap on narrower phones. Reserve three rows so
    // Weather, Save/Edit and Share stay inside the sheet and above Android's
    // gesture or three-button navigation area.
    <BottomSheet
      ref={sheet}
      visible
      mode="map"
      onClose={onCancel}
      initialSnap="peek"
      // Overlay/article answers need room of their own. Photos no longer affect
      // the initial card height: their peer action expands the sheet on demand.
      peekHeight={
        (identify.length > 0 || content.content.length > 0 ? 380 : 218) +
        52 +
        // Elevation is always a row; the light line is usually a second one and
        // wraps to two on a narrow phone.
        (facts.light ? 46 : 22) +
        // The explain block is several rows of reasoning; without its own
        // allowance it would push the actions off the peeked sheet.
        (potential ? 200 : 0)
      }
      bottomInset={bottomInset}
      testID="destination-sheet"
    >
      <View style={styles.header}>
        <View style={styles.titles}>
          <Text style={styles.name} numberOfLines={1}>
            {target.name}
          </Text>
          {target.detail ? (
            <Text style={styles.detail} numberOfLines={1}>
              {target.detail}
            </Text>
          ) : null}
          {target.address ? (
            <Text style={styles.detail} numberOfLines={2}>
              {target.address}
            </Text>
          ) : null}
        </View>
        <Pressable onPress={onCancel} testID="destination-cancel" hitSlop={10}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      <PlaceFacts {...facts} />

      {/* Above the surface's own reading when this pin *is* a stand: the ground
        is context, but which way to face is what the user came back for. */}
      {stand ? <StandBlock stand={stand} /> : null}

      {/* Why the derived surface reads this spot the way it does. Above the
        overlays' own answers: the user tapped the water they were looking at. */}
      {potential ? <PotentialExplainCard data={potential} targetLabel={potentialTarget} /> : null}

      {identify.length > 0 ? (
        // "What's here" from the visible overlays. Scrolls inside the card so a
        // chatty upstream can never push the actions off the sheet.
        <>
          <ScrollView
            style={identifyOpen ? styles.identifyOpen : styles.identify}
            bounces={false}
            testID="destination-identify"
          >
            {identify.map((group, i) => (
              <View key={`${group.title}-${i}`} style={styles.identifyGroup}>
                <Text style={styles.identifyTitle}>
                  {group.title}
                  {/* The first answer of an overlay is the one under the finger;
                      a distance here says this row is about a neighbour. */}
                  {group.distance ? (
                    <Text style={styles.identifyDistance}> {group.distance}</Text>
                  ) : null}
                </Text>
                {group.rows.map(([key, value]) => {
                  const url = identifyValueUrl(value);
                  return (
                    <View key={key} style={styles.identifyRow}>
                      <Text style={styles.identifyKey} numberOfLines={1}>
                        {key}
                      </Text>
                      {url ? (
                        // The register's own record: opened on a tap, copied on
                        // a long press — printed as text it was unusable.
                        <Text
                          style={[styles.identifyValue, styles.identifyLink]}
                          numberOfLines={1}
                          onPress={() => void Linking.openURL(url)}
                          onLongPress={() => copyToClipboard(url)}
                        >
                          {identifyLinkLabel(url)} ↗
                        </Text>
                      ) : (
                        <Text
                          style={styles.identifyValue}
                          // Clipped until the reader asks for it: a surveyor's
                          // field description is paragraphs long, and the sheet
                          // opens over the map.
                          numberOfLines={identifyOpen ? undefined : 2}
                          selectable
                        >
                          {value}
                        </Text>
                      )}
                    </View>
                  );
                })}
                {group.note ? <Text style={styles.identifyNote}>{group.note}</Text> : null}
              </View>
            ))}
          </ScrollView>
          {identifyClipped || identifyOpen ? (
            <Pressable
              onPress={() => {
                setIdentifyOpen((open) => !open);
                // Opening the answers over a peeked sheet is a keyhole, the
                // same reason the nearby list raises it.
                if (!identifyOpen) expand();
              }}
              hitSlop={8}
            >
              <Text style={styles.identifyMore}>{identifyExpandLabel(identifyOpen)}</Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {content.status === 'loading' ? (
        <Text style={styles.contentLoading}>Looking up local guide…</Text>
      ) : null}
      {content.content.length > 0 ? (
        <ScrollView style={styles.content} bounces={false} testID="destination-content">
          {content.content.map((article) => (
            <View key={`${article.source}/${article.url}`} style={styles.article}>
              <View style={styles.articleHead}>
                <View style={styles.articleSourceRow}>
                  <WikiBadge />
                  <Text style={styles.articleSource}>
                    {article.source === 'wikipedia' ? 'Wikipedia' : 'Wikivoyage'}
                    {article.offline ? ' · offline' : ''}
                  </Text>
                </View>
                <Pressable onPress={() => void Linking.openURL(article.url)}>
                  <Text style={styles.articleLink}>Read article</Text>
                </Pressable>
              </View>
              <Text style={styles.articleText}>{article.extract}</Text>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {/* Photos and described places are peer actions. Images no longer load
          into every marker card or displace its primary actions. */}
      <View style={styles.nearbyButtons}>
        <Pressable
          style={[styles.nearbyToggle, photosOpen && styles.nearbyToggleOpen]}
          onPress={() => {
            const opening = !photosOpen;
            setPhotosOpen(opening);
            if (opening) expand();
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: photosOpen }}
          testID="destination-photos-toggle"
        >
          <Text style={styles.nearbyToggleText}>◫ Photos nearby</Text>
        </Pressable>
        <Pressable
          style={[styles.nearbyToggle, nearbyOpen && styles.nearbyToggleOpen]}
          onPress={() => {
            const opening = !nearbyOpen;
            setNearbyOpen(opening);
            if (opening) expand();
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: nearbyOpen }}
          testID="destination-nearby-toggle"
        >
          <WikiBadge />
          <Text style={styles.nearbyToggleText}>Nearby places</Text>
        </Pressable>
      </View>
      {photosOpen ? (
        photos.status === 'loading' && !content.content.some((article) => article.image) ? (
          <Text style={styles.contentLoading}>Looking for photos…</Text>
        ) : photos.photos.length === 0 && !content.content.some((article) => article.image) ? (
          <Text style={styles.contentLoading}>No nearby photos found.</Text>
        ) : (
          <View style={styles.photos} testID="destination-photos">
            <Text style={styles.sectionLabel}>Wikimedia Commons</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.photoStrip}>
              {content.content
                .filter((article) => article.image)
                .map((article) => (
                  <Pressable
                    key={article.url}
                    onPress={() => void Linking.openURL(article.url)}
                    style={styles.photoTile}
                    accessibilityLabel={article.title}
                  >
                    <Image
                      source={wikimediaSource(article.image!.url)}
                      style={styles.photo}
                      resizeMode="cover"
                    />
                    <Text style={styles.photoDistance}>Article</Text>
                  </Pressable>
                ))}
              {photos.photos.map((photo) => (
                <Pressable
                  key={photo.pageUrl}
                  onPress={() => void Linking.openURL(photo.pageUrl)}
                  style={styles.photoTile}
                  accessibilityLabel={`${photo.title}${photo.credit ? `, ${photo.credit}` : ''}`}
                >
                  <Image
                    source={wikimediaSource(photo.url)}
                    style={styles.photo}
                    resizeMode="cover"
                  />
                  {photo.distanceM !== null ? (
                    <Text style={styles.photoDistance}>{fmtDistanceM(photo.distanceM)}</Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )
      ) : null}

      {/* Described places around this spot — the question a name lookup cannot
          answer, since most POIs have no article of their own. */}
      {nearbyOpen ? (
        nearby.status === 'loading' ? (
          <Text style={styles.contentLoading}>Looking around…</Text>
        ) : nearby.places.length === 0 ? (
          <Text style={styles.contentLoading}>
            Nothing described within a couple of kilometres.
          </Text>
        ) : (
          <ScrollView style={styles.nearbyList} bounces={false} testID="destination-nearby">
            {nearby.places.map((place, index) => (
              <Pressable
                key={place.url}
                style={styles.nearbyRow}
                onPress={() => {
                  onPickNearby(place);
                  expand();
                }}
                testID={`destination-nearby-${index}`}
              >
                {place.image ? (
                  <Image
                    source={wikimediaSource(place.image.url)}
                    style={styles.nearbyThumb}
                    resizeMode="cover"
                  />
                ) : (
                  <View style={[styles.nearbyThumb, styles.nearbyThumbEmpty]} />
                )}
                <View style={styles.nearbyText}>
                  <View style={styles.nearbyTitleRow}>
                    <WikiBadge />
                    <Text style={styles.nearbyTitle} numberOfLines={1}>
                      {place.title}
                    </Text>
                  </View>
                  <Text style={styles.nearbyExtract} numberOfLines={2}>
                    {fmtDistanceM(place.distanceM)} away · {place.extract}
                  </Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        )
      ) : null}

      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.navigate, pressed && styles.pressed]}
          onPress={once(onDirections)}
          testID="destination-navigate"
        >
          <Text style={styles.navigateText}>Directions</Text>
        </Pressable>
        {target.canSave && onSave ? (
          <Pressable
            style={({ pressed }) => [styles.save, pressed && styles.pressed]}
            onPress={once(onSave)}
            testID="destination-save"
          >
            <Text style={styles.saveText}>Save pin</Text>
          </Pressable>
        ) : null}
        {onEdit ? (
          <Pressable
            style={({ pressed }) => [styles.save, pressed && styles.pressed]}
            onPress={once(onEdit)}
            testID="destination-edit"
          >
            {/* The star says "already saved" — the same word and mark the web
                card uses once a spot has a place behind it. */}
            <Text style={styles.saveText}>★ Edit</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.save, pressed && styles.pressed]}
          onPress={onWeather}
          testID="destination-weather"
        >
          <WeatherIcon />
          <Text style={styles.saveText}>Weather</Text>
        </Pressable>
        {transitCoversPoint(at) ? (
          <Pressable
            style={({ pressed }) => [styles.save, pressed && styles.pressed]}
            onPress={() => {
              setDeparturesOpen((open) => !open);
              sheet.current?.snapTo('full');
            }}
            accessibilityState={{ expanded: departuresOpen }}
            testID="destination-departures"
          >
            <Text style={styles.saveText}>Departures</Text>
          </Pressable>
        ) : null}
        <Pressable
          style={({ pressed }) => [styles.save, pressed && styles.pressed]}
          onPress={onShare}
          testID="destination-share"
        >
          <Text style={styles.saveText}>Share</Text>
        </Pressable>
      </View>
      {departuresOpen ? (
        <StopDepartures
          location={{
            ...at,
            ...(target.transitStopId ? { stopId: target.transitStopId } : {}),
          }}
          onClose={() => setDeparturesOpen(false)}
        />
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titles: { flexShrink: 1, paddingRight: 12 },
  name: { fontSize: 17, fontWeight: '700', color: theme.text },
  detail: { fontSize: 13, color: theme.textMuted, marginTop: 1 },
  close: { fontSize: 18, color: theme.textMuted, paddingHorizontal: 4 },
  facts: { marginTop: 10, gap: 2 },
  factRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  // A fixed label column keeps the two values aligned; the light line is long
  // enough to wrap, and wrapping under a ragged label reads as two columns.
  factLabel: { width: 62, fontSize: 12, color: theme.textMuted },
  factValue: { flex: 1, fontSize: 12, color: theme.text },
  identify: { maxHeight: 132, marginTop: 12 },
  // Opened by "Show more" — still bounded, so the card's actions stay on the
  // sheet however much the upstream has to say.
  identifyOpen: { maxHeight: 320, marginTop: 12 },
  identifyMore: { color: theme.accent, fontSize: 12, fontWeight: '700', marginTop: 4 },
  identifyLink: { color: theme.accent, textDecorationLine: 'underline' },
  identifyGroup: { marginBottom: 8 },
  identifyTitle: { fontSize: 12, fontWeight: '800', color: theme.textMuted, marginBottom: 2 },
  identifyDistance: { fontWeight: '400' },
  identifyRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  identifyNote: { fontSize: 12, color: theme.textMuted, marginTop: 2 },
  identifyKey: { flexShrink: 1, fontSize: 13, color: theme.textMuted },
  identifyValue: { flex: 1, fontSize: 13, color: theme.text, fontWeight: '600' },
  contentLoading: { marginTop: 12, color: theme.textMuted, fontSize: 13 },
  content: { maxHeight: 150, marginTop: 12 },
  article: { marginBottom: 10 },
  articleHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  articleSourceRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  articleSource: { color: theme.textMuted, fontWeight: '800', fontSize: 12 },
  wikiBadge: {
    width: 15,
    height: 15,
    borderRadius: 3,
    backgroundColor: theme.icon,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wikiBadgeText: { color: theme.surface, fontSize: 10, fontWeight: '900' },
  sectionLabel: { color: theme.textMuted, fontWeight: '800', fontSize: 12 },
  photos: { marginTop: 12 },
  photoStrip: { marginTop: 6 },
  photoTile: { marginRight: 6, borderRadius: 8, overflow: 'hidden' },
  // A muted surface, never `border` (which is the *foreground* colour): an
  // image still loading should read as an empty slot, not a black hole.
  photo: { width: 116, height: 84, backgroundColor: theme.surfaceMuted },
  photoDistance: {
    position: 'absolute',
    right: 3,
    bottom: 3,
    paddingHorizontal: 4,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.62)',
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  nearbyToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.border,
  },
  nearbyButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  nearbyToggleOpen: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  nearbyToggleText: { fontSize: 13, color: theme.text, fontWeight: '600' },
  nearbyList: { maxHeight: 200, marginTop: 6 },
  nearbyRow: { flexDirection: 'row', gap: 8, paddingVertical: 6 },
  nearbyThumb: { width: 46, height: 46, borderRadius: 6, backgroundColor: theme.surfaceMuted },
  nearbyThumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  nearbyText: { flex: 1, minWidth: 0 },
  nearbyTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  nearbyTitle: { flexShrink: 1, color: theme.text, fontSize: 14, fontWeight: '700' },
  nearbyExtract: { color: theme.textMuted, fontSize: 11, lineHeight: 15, marginTop: 1 },
  articleLink: { color: theme.accent, fontWeight: '700', fontSize: 12 },
  articleText: { color: theme.text, fontSize: 13, lineHeight: 18, marginTop: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 16 },
  navigate: {
    flexGrow: 1,
    flexBasis: '100%',
    backgroundColor: theme.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  navigateText: { color: theme.onAccent, fontWeight: '700', fontSize: 15 },
  save: {
    flexDirection: 'row',
    gap: 7,
    backgroundColor: theme.surfaceMuted,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  saveText: { color: theme.text, fontWeight: '700', fontSize: 15 },
  pressed: { opacity: 0.65 },
});
