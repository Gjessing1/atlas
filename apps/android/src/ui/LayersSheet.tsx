import {
  groupLayerCatalog,
  mapProfile,
  searchLayerGroups,
  type LayerMeta,
  type LayerOption,
} from '@atlas/core';
import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { OverlaysController } from '../layers/useOverlays';
import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

/** Opacity choices as chips — no native slider dependency, OTA-friendly. */
const OPACITY_STEPS = [0.25, 0.5, 0.75, 1];

/**
 * The ramp a derived surface is drawn with, in the model's own words — the web
 * DerivedLegend's twin.
 *
 * A heatmap whose colours are unexplained is a decoration, and these ones carry
 * a specific claim: the bands are percentiles of *what is on screen*, so "Prime"
 * means the top 5 % of this water rather than the best water in Norway. The
 * words and the swatches arrive together from the catalog, so the two clients
 * cannot drift apart on what a colour means.
 */
function DerivedLegend({ meta }: { meta: LayerMeta }) {
  const legend = meta.derived?.legend ?? [];
  if (legend.length === 0) return null;
  return (
    <View style={styles.legend}>
      {legend.map((band) => (
        <View key={band.key} style={styles.legendBand}>
          <View style={[styles.legendSwatch, { backgroundColor: band.color }]} />
          <Text style={styles.legendLabel}>{band.label}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A layer's variant picker (`LayerMeta.options`) — the web LayersPanel's twin.
 * The caption under the chips carries what the choice tunes; a filtered layer
 * is meaningless without it.
 */
function LayerOptionChips({
  overlays,
  meta,
  option,
}: {
  overlays: OverlaysController;
  meta: LayerMeta;
  option: LayerOption;
}) {
  const selected = overlays.optionsFor(meta)[option.key];
  const caption = option.choices.find((choice) => choice.value === selected)?.caption;
  return (
    <View>
      <View style={styles.opacityRow}>
        {option.choices.map((choice) => {
          const on = choice.value === selected;
          return (
            <Pressable
              key={choice.value}
              style={[styles.opacityChip, on ? styles.opacityChipOn : null]}
              onPress={() => overlays.setOption(meta, option.key, choice.value)}
              testID={`layer-option-${meta.id}-${option.key}-${choice.value}`}
            >
              <Text style={[styles.opacityChipText, on ? styles.opacityChipTextOn : null]}>
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {caption ? <Text style={styles.muted}>{caption}</Text> : null}
    </View>
  );
}

/**
 * "Keep this area offline" for a derived surface.
 *
 * It sits under the legend of the switched-on surface rather than in Settings →
 * Offline regions, because what it keeps is *what the map is looking at* — the
 * area you framed when you looked up your permit — and that is only meaningful
 * beside the surface it belongs to. Once it is kept it says so and stops
 * offering, since a second copy of the same ground is never what was wanted.
 */
export interface KeepOfflineControls {
  /** Ask for the framed area. Absent = the affordance is not offered at all. */
  onKeep: (meta: LayerMeta) => void;
  /** A request is in flight. */
  busy: boolean;
  /** A downloaded pack already carries this surface where the map is looking. */
  kept: boolean;
}

function KeepOffline({ meta, controls }: { meta: LayerMeta; controls: KeepOfflineControls }) {
  if (controls.kept) {
    return <Text style={styles.hint}>Kept offline — this area draws without a connection.</Text>;
  }
  return (
    <Pressable
      style={styles.keepOffline}
      disabled={controls.busy}
      onPress={() => controls.onKeep(meta)}
      testID={`layer-keep-offline-${meta.id}`}
    >
      <Text style={styles.keepOfflineText}>
        {controls.busy ? 'Packing this area…' : '↓ Keep this area offline'}
      </Text>
    </Pressable>
  );
}

/** Full layer controls without sheet chrome, reused by Settings → Map. */
export function LayersContent({
  overlays,
  keepOffline,
}: {
  overlays: OverlaysController;
  /** Omitted by Settings → Map, which has no viewport to keep. */
  keepOffline?: KeepOfflineControls;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const groups = groupLayerCatalog(overlays.catalog, overlays.profileId);

  if (overlays.catalog.length === 0) {
    return (
      <Text style={styles.muted}>
        No layers available — the layer catalog needs a server connection at least once.
      </Text>
    );
  }

  const note = mapProfile(overlays.profileId).note;
  const searching = query.trim().length > 0;
  const visibleGroups = searchLayerGroups(groups, query);
  const activeLayers = overlays.catalog.filter((meta) => overlays.isOn(meta.id));
  const visibleIds = new Set(visibleGroups.flatMap((group) => group.layers.map((meta) => meta.id)));
  const visibleActiveLayers = searching
    ? activeLayers.filter((meta) => visibleIds.has(meta.id))
    : activeLayers;
  const availableGroups = visibleGroups
    .map((group) => ({
      ...group,
      layers: group.layers.filter((meta) => !overlays.isOn(meta.id)),
    }))
    .filter((group) => group.layers.length > 0);
  const layerRow = (meta: LayerMeta, keyPrefix = '') => {
    const on = overlays.isOn(meta.id);
    const opacity = overlays.opacityFor(meta.id);
    return (
      <View key={`${keyPrefix}${meta.id}`} style={styles.row}>
        <Pressable
          style={styles.toggleRow}
          onPress={() => overlays.toggle(meta.id)}
          testID={`layer-toggle-${meta.id}`}
          accessibilityRole="switch"
          accessibilityState={{ checked: on }}
        >
          <Text style={styles.layerTitle}>{meta.title}</Text>
          <View style={[styles.toggle, on ? styles.toggleOn : null]}>
            <View style={[styles.toggleThumb, on ? styles.toggleThumbOn : null]} />
          </View>
        </Pressable>
        <Text style={styles.muted}>
          {meta.description}{' '}
          {meta.metadataUrl ? (
            <Text style={styles.sourceLink} onPress={() => void Linking.openURL(meta.metadataUrl!)}>
              source
            </Text>
          ) : null}
        </Text>
        {on
          ? meta.options?.map((option) => (
              <LayerOptionChips key={option.key} overlays={overlays} meta={meta} option={option} />
            ))
          : null}
        {on ? <DerivedLegend meta={meta} /> : null}
        {on && meta.derived && keepOffline ? (
          <KeepOffline meta={meta} controls={keepOffline} />
        ) : null}
        {on && meta.minzoom !== undefined ? (
          <Text style={styles.hint}>Visible from zoom {meta.minzoom} — zoom in.</Text>
        ) : null}
        {on && meta.coverageNote ? <Text style={styles.hint}>{meta.coverageNote}</Text> : null}
        {on ? (
          <View style={styles.opacityRow}>
            {OPACITY_STEPS.map((step) => (
              <Pressable
                key={step}
                style={[
                  styles.opacityChip,
                  Math.abs(opacity - step) < 0.125 ? styles.opacityChipOn : null,
                ]}
                onPress={() => overlays.setOpacity(meta.id, step)}
              >
                <Text
                  style={[
                    styles.opacityChipText,
                    Math.abs(opacity - step) < 0.125 ? styles.opacityChipTextOn : null,
                  ]}
                >
                  {Math.round(step * 100)}%
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View>
      <View style={styles.searchHead}>
        <Text style={styles.searchTitle}>Available to this profile</Text>
        <Pressable
          style={styles.searchButton}
          onPress={() => {
            setSearchOpen((open) => !open);
            if (searchOpen) setQuery('');
          }}
          accessibilityRole="button"
          accessibilityLabel="Search layers"
          accessibilityState={{ expanded: searchOpen }}
          testID="layer-search-toggle"
        >
          <Text style={styles.searchGlyph}>⌕</Text>
        </Pressable>
      </View>
      {searchOpen ? (
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search layers"
          autoFocus
          testID="layer-search"
        />
      ) : null}
      {note ? <Text style={styles.profileNote}>{note}</Text> : null}
      <View style={styles.row}>
        <Pressable
          style={styles.toggleRow}
          onPress={() => overlays.setPoiOn(!overlays.poiOn)}
          testID="layer-toggle-points-of-interest"
        >
          <Text style={styles.layerTitle}>Points of interest</Text>
          <View style={[styles.toggle, overlays.poiOn ? styles.toggleOn : null]}>
            <View style={[styles.toggleThumb, overlays.poiOn ? styles.toggleThumbOn : null]} />
          </View>
        </Pressable>
        <Text style={styles.muted}>
          Shops, food, services, sights and outdoor places already carried by the map. Labels appear
          as you zoom in — this profile only.
        </Text>
      </View>
      {/* The map the overlays are drawn on, above the overlays themselves. Off
          is how a raster with holes in it — a 1826 amtskart sheet, the edge of a
          bathymetry survey — is read honestly: today's coloured land fills those
          holes and the eye takes it for part of the old map. Web twin in
          LayersPanel. */}
      <View style={styles.row}>
        <Pressable
          style={styles.toggleRow}
          onPress={() => overlays.setBasemapOn(!overlays.basemapOn)}
          testID="layer-toggle-basemap"
        >
          <Text style={styles.layerTitle}>Base map</Text>
          <View style={[styles.toggle, overlays.basemapOn ? styles.toggleOn : null]}>
            <View style={[styles.toggleThumb, overlays.basemapOn ? styles.toggleThumbOn : null]} />
          </View>
        </Pressable>
        <Text style={styles.muted}>
          Roads, land and place names under the overlays. Turn it off to read a historic map or any
          overlay with gaps on its own — this profile only.
        </Text>
      </View>
      {visibleActiveLayers.length > 0 ? (
        <View style={styles.activeSection}>
          <Text style={styles.groupHeading}>Active</Text>
          {visibleActiveLayers.map((meta) => layerRow(meta, 'active-'))}
        </View>
      ) : null}
      {availableGroups.map((group) => (
        <View key={group.name}>
          <Text style={styles.groupHeading}>{group.name}</Text>
          {group.layers.map((meta) => layerRow(meta))}
        </View>
      ))}
    </View>
  );
}

/**
 * Map-layers sheet (☰ → Layers): the curated overlay catalog grouped by
 * theme, with visibility toggles, opacity chips, a source link and honest
 * coverage notes ("blank ≠ broken"). The web Sidebar's LayersPanel twin.
 */
export function LayersSheet({
  visible,
  onClose,
  overlays,
  keepOffline,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  overlays: OverlaysController;
  keepOffline?: KeepOfflineControls;
  /** System nav-bar inset — keeps the Close button clear of it (edge-to-edge). */
  bottomInset?: number;
}) {
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="layers-sheet"
    >
      <Text style={styles.heading}>Map layers</Text>
      <ScrollView style={styles.scroll}>
        <LayersContent overlays={overlays} keepOffline={keepOffline} />
      </ScrollView>
      <Pressable style={styles.closeButton} onPress={onClose} testID="layers-close">
        <Text style={styles.closeButtonText}>Close</Text>
      </Pressable>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  heading: { fontSize: 15, fontWeight: '700', color: theme.text, marginBottom: 4 },
  searchHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 36,
  },
  searchTitle: { fontSize: 12, color: theme.textMuted },
  searchButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surfaceMuted,
  },
  searchGlyph: { fontSize: 20, color: theme.text },
  searchInput: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 11,
    paddingVertical: 7,
    backgroundColor: theme.surface,
    color: theme.text,
    fontSize: 14,
    marginBottom: 6,
  },
  groupHeading: {
    marginTop: 10,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: theme.textMuted,
  },
  // The profile's standing caveat (MapProfile.note), above the whole list so it
  // reads as being about the activity rather than about one layer.
  profileNote: {
    borderLeftWidth: 3,
    borderLeftColor: theme.warning,
    paddingLeft: 8,
    paddingVertical: 4,
    marginBottom: 4,
    fontSize: 12,
    lineHeight: 17,
    color: theme.warning,
  },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  legendBand: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendSwatch: { width: 16, height: 10, borderRadius: 2 },
  legendLabel: { fontSize: 11, color: theme.textMuted },
  row: { paddingVertical: 8 },
  activeSection: {
    marginTop: 6,
    paddingHorizontal: 9,
    paddingBottom: 7,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    backgroundColor: theme.surfaceMuted,
  },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toggle: {
    width: 34,
    height: 20,
    marginLeft: 'auto',
    padding: 3,
    borderRadius: 10,
    backgroundColor: theme.border,
  },
  toggleOn: { backgroundColor: theme.accent },
  toggleThumb: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.surface,
  },
  toggleThumbOn: { transform: [{ translateX: 14 }] },
  layerTitle: { flex: 1, fontSize: 15, color: theme.text },
  muted: { fontSize: 13, color: theme.textMuted, marginTop: 4 },
  sourceLink: { color: theme.accent, textDecorationLine: 'underline' },
  hint: { fontSize: 12, color: theme.warning, marginTop: 2 },
  keepOffline: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: theme.surfaceMuted,
    alignSelf: 'flex-start',
  },
  keepOfflineText: { fontSize: 13, color: theme.text, fontWeight: '600' },
  opacityRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  opacityChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: theme.surfaceMuted,
  },
  opacityChipOn: { backgroundColor: theme.accent },
  opacityChipText: { fontSize: 13, fontWeight: '600', color: theme.text },
  opacityChipTextOn: { color: theme.onAccent },
  closeButton: {
    marginTop: 12,
    alignSelf: 'stretch',
    alignItems: 'center',
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingVertical: 9,
  },
  closeButtonText: { color: theme.onAccent, fontWeight: '600' },
});
