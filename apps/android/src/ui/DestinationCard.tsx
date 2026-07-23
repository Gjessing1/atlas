import type { OverlayIdentifyGroup } from '@atlas/core';
import { useEffect, useRef } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePlaceContent } from '../place/usePlaceContent';
import type { LocalPack } from '../regions/packs';
import { BottomSheet } from './BottomSheet';
import { WeatherIcon } from './icons';
import { theme } from './theme';

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
  /** Set when the target is a saved place — enables the Edit action. */
  placeId?: string;
  /**
   * What the visible overlays say sits here (tap-to-identify: a lake's surveyed
   * depth, a parcel's number). Arrives after the card opens — the network round
   * trip must not delay the actions.
   */
  identify?: OverlayIdentifyGroup[];
}

/** Attribute rows shown per overlay, and how many of each fit the card. */
const MAX_IDENTIFY_GROUPS = 3;
const MAX_IDENTIFY_ROWS = 6;

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
  onDirections,
  onSave,
  onEdit,
  onShare,
  onWeather,
  onCancel,
  bottomInset = 0,
}: {
  target: DestinationTarget;
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
  onCancel: () => void;
  bottomInset?: number;
}) {
  const identify = target.identify ?? [];
  const content = usePlaceContent(packs, target.name, { lat: target.lat, lng: target.lng });
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
      visible
      mode="map"
      onClose={onCancel}
      initialSnap="peek"
      // Overlay answers need room of their own; without them the card keeps its
      // three action rows exactly as before.
      peekHeight={identify.length > 0 || content.content.length > 0 ? 380 : 218}
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

      {identify.length > 0 ? (
        // "What's here" from the visible overlays. Scrolls inside the card so a
        // chatty upstream can never push the actions off the sheet.
        <ScrollView style={styles.identify} bounces={false} testID="destination-identify">
          {identify.slice(0, MAX_IDENTIFY_GROUPS).map((group, i) => (
            <View key={`${group.title}-${i}`} style={styles.identifyGroup}>
              <Text style={styles.identifyTitle}>{group.title}</Text>
              {Object.entries(group.properties)
                .slice(0, MAX_IDENTIFY_ROWS)
                .map(([key, value]) => (
                  <View key={key} style={styles.identifyRow}>
                    <Text style={styles.identifyKey} numberOfLines={1}>
                      {key}
                    </Text>
                    <Text style={styles.identifyValue} numberOfLines={2}>
                      {value}
                    </Text>
                  </View>
                ))}
            </View>
          ))}
        </ScrollView>
      ) : null}

      {content.status === 'loading' ? (
        <Text style={styles.contentLoading}>Looking up local guide…</Text>
      ) : null}
      {content.content.length > 0 ? (
        <ScrollView style={styles.content} bounces={false} testID="destination-content">
          {content.content.map((article) => (
            <View key={`${article.source}/${article.url}`} style={styles.article}>
              <View style={styles.articleHead}>
                <Text style={styles.articleSource}>
                  {article.source === 'wikipedia' ? 'Wikipedia' : 'Wikivoyage'}
                  {article.offline ? ' · offline' : ''}
                </Text>
                <Pressable onPress={() => void Linking.openURL(article.url)}>
                  <Text style={styles.articleLink}>Read article</Text>
                </Pressable>
              </View>
              <Text style={styles.articleText}>{article.extract}</Text>
            </View>
          ))}
        </ScrollView>
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
            <Text style={styles.saveText}>Edit</Text>
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
        <Pressable
          style={({ pressed }) => [styles.save, pressed && styles.pressed]}
          onPress={onShare}
          testID="destination-share"
        >
          <Text style={styles.saveText}>Share</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titles: { flexShrink: 1, paddingRight: 12 },
  name: { fontSize: 17, fontWeight: '700', color: theme.text },
  detail: { fontSize: 13, color: theme.textMuted, marginTop: 1 },
  close: { fontSize: 18, color: theme.textMuted, paddingHorizontal: 4 },
  identify: { maxHeight: 132, marginTop: 12 },
  identifyGroup: { marginBottom: 8 },
  identifyTitle: { fontSize: 12, fontWeight: '800', color: theme.textMuted, marginBottom: 2 },
  identifyRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  identifyKey: { flexShrink: 1, fontSize: 13, color: theme.textMuted },
  identifyValue: { flex: 1, fontSize: 13, color: theme.text, fontWeight: '600' },
  contentLoading: { marginTop: 12, color: theme.textMuted, fontSize: 13 },
  content: { maxHeight: 150, marginTop: 12 },
  article: { marginBottom: 10 },
  articleHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  articleSource: { color: theme.textMuted, fontWeight: '800', fontSize: 12 },
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
