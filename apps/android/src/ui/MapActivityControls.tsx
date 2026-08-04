import type { MapProfileController, PotentialTargetSwitch } from '@atlas/app-hooks';
import { groupLayerCatalog, type LayerMeta, type MapProfile } from '@atlas/core';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { OverlaysController } from '../layers/useOverlays';
import { useSideInsets } from './insets';
import { FishHuntIcon, LayersIcon, MAP_PROFILE_ICON } from './modeIcons';
import { theme } from './theme';

/** The chosen variant of a layer that has one ("Springs", "Severe") — web's twin. */
function variantLabel(overlays: OverlaysController, meta: LayerMeta): string | null {
  if (!meta.options?.length) return null;
  const chosen = overlays.optionsFor(meta);
  const labels = meta.options
    .map((option) => option.choices.find((choice) => choice.value === chosen[option.key])?.label)
    .filter((label): label is string => Boolean(label));
  return labels.length > 0 ? labels.join(' · ') : null;
}

/**
 * Bottom-right, one-tap map setup: activity profiles, the Fish & Hunt
 * sub-profile, and the current profile's overlay catalog. All three operate on
 * the same persisted state as the route planner and full Layers sheet, so
 * switching never creates a second source of truth.
 *
 * The overlay menu is grouped and ordered by `groupLayerCatalog`, exactly as
 * the Layers sheet and the web switcher are: a profile's own registers come
 * first, and a menu that reaches eleven rows in Curiosities needs headings to
 * stay scannable on a phone.
 */
export function MapActivityControls({
  profile,
  visibleProfiles,
  overlays,
  targets,
  mapZoom,
  bottom,
  onPickProfile,
}: {
  profile: MapProfileController;
  visibleProfiles: readonly MapProfile[];
  overlays: OverlaysController;
  /**
   * What the derived surface is tuned for. Its trigger is absent outside Fish &
   * Hunt, where the catalog carries nothing derived — the row is decided by the
   * data, not by a profile id spelled out a second time here.
   */
  targets: PotentialTargetSwitch;
  mapZoom: number;
  /** Already includes the system navigation-bar inset. */
  bottom: number;
  onPickProfile: (id: string) => void;
}) {
  const [layersOpen, setLayersOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const win = useWindowDimensions();
  // In landscape the system navigation bar sits on a side of the screen: the
  // triggers and the menus they open both start inside it. `right` is the
  // 64 dp gap that keeps the row clear of the locate button, plus that inset.
  const side = useSideInsets();
  const right = side.right + 64;
  const activeCount = overlays.overlays.length;
  const activeProfile = profile.profile;
  const ActiveIcon = MAP_PROFILE_ICON[activeProfile.id]!;
  const quarry = targets.active;
  // The quarry pill gets a row of its own rather than a third seat in the
  // bottom row: a labelled pill beside two 44 dp circles reaches ~270 dp, which
  // on a 360 dp phone runs straight into the menu/search/route cluster on the
  // other side. A row to itself also puts it where the web app puts it.
  const quarryRow = targets.groups.length > 0;
  const layerGroups = useMemo(
    () => groupLayerCatalog(overlays.catalog, overlays.profileId),
    [overlays.catalog, overlays.profileId],
  );
  const menuBottom = bottom + (quarryRow ? 104 : 52);
  const closeMenus = () => {
    setLayersOpen(false);
    setProfilesOpen(false);
    setTargetsOpen(false);
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {layersOpen || profilesOpen || targetsOpen ? (
        <Pressable
          style={styles.backdrop}
          onPress={closeMenus}
          accessibilityLabel="Close map controls"
          testID="layer-quick-backdrop"
        />
      ) : null}

      {profilesOpen ? (
        <View
          style={[styles.profileMenu, { bottom: menuBottom, right }]}
          accessibilityLabel="Map profile"
        >
          {visibleProfiles.map((item) => {
            const active = item.id === activeProfile.id;
            const Icon = MAP_PROFILE_ICON[item.id]!;
            return (
              <Pressable
                key={item.id}
                style={[styles.profileItem, active && styles.profileItemOn]}
                onPress={() => {
                  onPickProfile(item.id);
                  setProfilesOpen(false);
                }}
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
                accessibilityLabel={item.label}
                testID={`map-profile-${item.id}`}
              >
                <Icon color={active ? theme.accent : theme.icon} size={21} />
                <Text style={[styles.profileLabel, active && styles.profileLabelOn]}>
                  {item.label}
                </Text>
                {active ? <Text style={styles.profileCheck}>✓</Text> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {/* What are you after? Grouped by surface, because lake and river ask
          different questions about the same fish. */}
      {targetsOpen ? (
        <View
          style={[
            styles.quarryMenu,
            {
              bottom: menuBottom,
              right,
              maxHeight: Math.max(88, Math.min(win.height * 0.52, 420, win.height - bottom - 64)),
            },
          ]}
          accessibilityLabel="Fish & game"
        >
          <ScrollView bounces={false} contentContainerStyle={styles.layerMenuContent}>
            {targets.groups.map((group) => (
              <View key={group.layer}>
                <Text style={styles.quarryGroupTitle}>{group.title}</Text>
                {group.choices.map((choice) => (
                  <Pressable
                    key={`${choice.layer}:${choice.value}`}
                    style={[styles.layerItem, choice.active && styles.layerItemOn]}
                    onPress={() => {
                      targets.select(choice.layer, choice.value);
                      setTargetsOpen(false);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: choice.active }}
                    accessibilityLabel={choice.label}
                    testID={`quarry-${choice.layer}-${choice.value}`}
                  >
                    <Text
                      style={[styles.layerLabel, choice.active && styles.layerLabelOn]}
                      numberOfLines={1}
                    >
                      {choice.label}
                    </Text>
                    {choice.active ? <Text style={styles.profileCheck}>✓</Text> : null}
                  </Pressable>
                ))}
              </View>
            ))}
            {quarry ? (
              // The way back out: without it the only way to stop drawing an
              // opinion over the map is to find the row in the Layers sheet.
              <Pressable
                style={[styles.layerItem, styles.quarryClear]}
                onPress={() => {
                  targets.clear();
                  setTargetsOpen(false);
                }}
                accessibilityRole="button"
                accessibilityLabel="Turn the surface off"
                testID="quarry-clear"
              >
                <Text style={styles.quarryClearLabel}>Turn the surface off</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      ) : null}

      {layersOpen ? (
        <View
          style={[
            styles.layerMenu,
            {
              bottom: menuBottom,
              right,
              // In landscape the system inset + offline controls can consume
              // half the short edge; cap the menu to the room actually left.
              maxHeight: Math.max(88, Math.min(win.height * 0.48, 380, win.height - bottom - 64)),
            },
          ]}
          accessibilityLabel="Map layers"
        >
          <ScrollView bounces={false} contentContainerStyle={styles.layerMenuContent}>
            {layerGroups.map((group) => (
              <View key={group.name}>
                <Text style={styles.layerGroupHeading}>{group.name}</Text>
                {group.layers.map((meta) => {
                  const on = overlays.isOn(meta.id);
                  const tooLowZoom = meta.minzoom !== undefined && mapZoom < meta.minzoom;
                  const variant = on ? variantLabel(overlays, meta) : null;
                  return (
                    <Pressable
                      key={meta.id}
                      style={[styles.layerItem, on && styles.layerItemOn]}
                      onPress={() => overlays.toggle(meta.id)}
                      accessibilityRole="switch"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={variant ? `${meta.title}, ${variant}` : meta.title}
                      testID={`layer-quick-${meta.id}`}
                    >
                      <View style={[styles.check, on && styles.checkOn]}>
                        {on ? <Text style={styles.checkText}>✓</Text> : null}
                      </View>
                      <Text
                        style={[styles.layerLabel, on && styles.layerLabelOn]}
                        numberOfLines={1}
                      >
                        {meta.title}
                        {variant ? <Text style={styles.layerVariant}>{`  ${variant}`}</Text> : null}
                      </Text>
                      {on && tooLowZoom ? (
                        <Text style={styles.zoomHint}>z{meta.minzoom}+</Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* A pill rather than a third identical circle: the animal's name is the
          whole point of the control, and an icon cannot say "Elg". */}
      {quarryRow ? (
        <View style={[styles.controlRow, { bottom: bottom + 52, right }]}>
          <Pressable
            style={[styles.quarryTrigger, targetsOpen && styles.controlSelected]}
            onPress={() => {
              setLayersOpen(false);
              setProfilesOpen(false);
              setTargetsOpen((open) => !open);
            }}
            accessibilityRole="button"
            accessibilityLabel={
              quarry
                ? `Fish & game: ${quarry.label}, ${quarry.layerTitle}`
                : 'Fish & game potential'
            }
            accessibilityState={{ expanded: targetsOpen }}
            testID="quarry-toggle"
          >
            <FishHuntIcon color={quarry ? theme.accent : theme.icon} size={20} />
            <Text
              style={[styles.quarryTriggerLabel, quarry && styles.quarryTriggerLabelOn]}
              numberOfLines={1}
            >
              {quarry ? quarry.label : 'What to look for'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View style={[styles.controlRow, { bottom, right }]}>
        <Pressable
          style={[styles.profileTrigger, profilesOpen && styles.controlSelected]}
          onPress={() => {
            setLayersOpen(false);
            setTargetsOpen(false);
            setProfilesOpen((open) => !open);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Map profile: ${activeProfile.label}`}
          accessibilityState={{ expanded: profilesOpen }}
          testID="map-profile-toggle"
        >
          <ActiveIcon color={theme.accent} size={22} />
        </Pressable>

        {overlays.catalog.length > 0 ? (
          <Pressable
            style={styles.layerButton}
            onPress={() => {
              setProfilesOpen(false);
              setTargetsOpen(false);
              setLayersOpen((open) => !open);
            }}
            accessibilityRole="button"
            accessibilityLabel={activeCount > 0 ? `Map layers, ${activeCount} on` : 'Map layers'}
            accessibilityState={{ expanded: layersOpen }}
            testID="layer-quick-toggle"
          >
            <LayersIcon color={activeCount > 0 ? theme.accent : theme.icon} size={22} />
            {activeCount > 0 ? (
              <View style={styles.countBadge}>
                <Text style={styles.countText}>{activeCount}</Text>
              </View>
            ) : null}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'transparent',
  },
  controlRow: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // Both triggers are the same 44pt circle: the glyph alone says which map
  // you're on, and two labelled pills were eating the width a map is for.
  // The words live on in the accessibility labels and in the menus they open.
  profileTrigger: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: 'transparent',
    elevation: 4,
  },
  controlSelected: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  quarryTrigger: {
    height: 44,
    maxWidth: 200,
    paddingHorizontal: 12,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: 'transparent',
    elevation: 4,
  },
  quarryTriggerLabel: { flexShrink: 1, color: theme.text, fontSize: 13, fontWeight: '600' },
  quarryTriggerLabelOn: { color: theme.accent, fontWeight: '700' },
  quarryMenu: {
    position: 'absolute',
    width: 230,
    padding: 4,
    borderRadius: 12,
    backgroundColor: theme.surface,
    elevation: 8,
  },
  quarryGroupTitle: {
    paddingHorizontal: 9,
    paddingTop: 8,
    paddingBottom: 3,
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  quarryClear: { marginTop: 4, borderTopWidth: 1, borderTopColor: theme.border },
  quarryClearLabel: { flex: 1, color: theme.textMuted, fontSize: 13 },
  layerButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
    elevation: 4,
  },
  countBadge: {
    position: 'absolute',
    right: -2,
    top: -3,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.accent,
    borderWidth: 2,
    borderColor: theme.surface,
  },
  countText: { color: theme.onAccent, fontSize: 10, fontWeight: '800' },
  layerMenu: {
    position: 'absolute',
    width: 250,
    padding: 4,
    borderRadius: 12,
    backgroundColor: theme.surface,
    elevation: 8,
  },
  profileMenu: {
    position: 'absolute',
    width: 172,
    padding: 4,
    borderRadius: 12,
    backgroundColor: theme.surface,
    elevation: 8,
  },
  profileItem: {
    minHeight: 44,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 8,
  },
  profileItemOn: { backgroundColor: theme.surfaceActive },
  profileLabel: { flex: 1, color: theme.text, fontSize: 14 },
  profileLabelOn: { color: theme.accent, fontWeight: '700' },
  profileCheck: { color: theme.accent, fontWeight: '800' },
  layerMenuContent: { paddingVertical: 2 },
  layerItem: {
    minHeight: 42,
    paddingHorizontal: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: 8,
  },
  layerItemOn: { backgroundColor: theme.surfaceActive },
  check: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { borderColor: theme.accent, backgroundColor: theme.accent },
  checkText: { color: theme.onAccent, fontWeight: '800', fontSize: 12, lineHeight: 14 },
  layerLabel: { flex: 1, color: theme.text, fontSize: 14 },
  layerLabelOn: { color: theme.accent, fontWeight: '700' },
  layerGroupHeading: {
    paddingHorizontal: 9,
    paddingTop: 8,
    paddingBottom: 2,
    color: theme.textMuted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  // Which variant an on layer is set to. Never bold: context for the row, not
  // a second control — the chips that change it live in the Layers sheet.
  layerVariant: { color: theme.textMuted, fontSize: 11, fontWeight: '400' },
  zoomHint: {
    color: theme.warning,
    backgroundColor: '#f6ecd7',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 10,
    fontWeight: '700',
  },
});
