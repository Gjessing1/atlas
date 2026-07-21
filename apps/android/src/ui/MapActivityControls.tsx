import type { MapProfileController } from '@atlas/app-hooks';
import { MAP_PROFILES } from '@atlas/core';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { OverlaysController } from '../layers/useOverlays';
import { LayersIcon, MAP_PROFILE_ICON } from './modeIcons';
import { theme } from './theme';

/**
 * Bottom-right, one-tap map setup: activity profiles plus the current
 * profile's overlay catalog. Both surfaces operate on the same persisted state
 * as the route planner and full Layers sheet, so switching never creates a
 * second source of truth.
 */
export function MapActivityControls({
  profile,
  overlays,
  mapZoom,
  bottom,
  onPickProfile,
}: {
  profile: MapProfileController;
  overlays: OverlaysController;
  mapZoom: number;
  /** Already includes the system navigation-bar inset. */
  bottom: number;
  onPickProfile: (id: string) => void;
}) {
  const [layersOpen, setLayersOpen] = useState(false);
  const [profilesOpen, setProfilesOpen] = useState(false);
  const win = useWindowDimensions();
  const activeCount = overlays.overlays.length;
  const activeProfile = profile.profile;
  const ActiveIcon = MAP_PROFILE_ICON[activeProfile.id]!;
  const closeMenus = () => {
    setLayersOpen(false);
    setProfilesOpen(false);
  };

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {layersOpen || profilesOpen ? (
        <Pressable
          style={styles.backdrop}
          onPress={closeMenus}
          accessibilityLabel="Close map controls"
          testID="layer-quick-backdrop"
        />
      ) : null}

      {profilesOpen ? (
        <View
          style={[styles.profileMenu, { bottom: bottom + 52 }]}
          accessibilityLabel="Map profile"
        >
          {MAP_PROFILES.map((item) => {
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
                <Icon color={active ? theme.accent : theme.text} size={21} />
                <Text style={[styles.profileLabel, active && styles.profileLabelOn]}>
                  {item.label}
                </Text>
                {active ? <Text style={styles.profileCheck}>✓</Text> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {layersOpen ? (
        <View
          style={[
            styles.layerMenu,
            {
              bottom: bottom + 52,
              // In landscape the system inset + offline controls can consume
              // half the short edge; cap the menu to the room actually left.
              maxHeight: Math.max(88, Math.min(win.height * 0.48, 380, win.height - bottom - 64)),
            },
          ]}
          accessibilityLabel="Map layers"
        >
          <ScrollView bounces={false} contentContainerStyle={styles.layerMenuContent}>
            {overlays.catalog.map((meta) => {
              const on = overlays.isOn(meta.id);
              const tooLowZoom = meta.minzoom !== undefined && mapZoom < meta.minzoom;
              return (
                <Pressable
                  key={meta.id}
                  style={[styles.layerItem, on && styles.layerItemOn]}
                  onPress={() => overlays.toggle(meta.id)}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={meta.title}
                  testID={`layer-quick-${meta.id}`}
                >
                  <View style={[styles.check, on && styles.checkOn]}>
                    {on ? <Text style={styles.checkText}>✓</Text> : null}
                  </View>
                  <Text style={[styles.layerLabel, on && styles.layerLabelOn]} numberOfLines={1}>
                    {meta.title}
                  </Text>
                  {on && tooLowZoom ? <Text style={styles.zoomHint}>z{meta.minzoom}+</Text> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      <View style={[styles.controlRow, { bottom }]}>
        <Pressable
          style={[styles.profileTrigger, profilesOpen && styles.controlSelected]}
          onPress={() => {
            setLayersOpen(false);
            setProfilesOpen((open) => !open);
          }}
          accessibilityRole="button"
          accessibilityLabel={`Map profile: ${activeProfile.label}`}
          accessibilityState={{ expanded: profilesOpen }}
          testID="map-profile-toggle"
        >
          <ActiveIcon color={theme.accent} size={21} />
          <Text style={styles.controlLabel}>{activeProfile.label}</Text>
          <Text style={styles.disclosure}>{profilesOpen ? '▾' : '▴'}</Text>
        </Pressable>

        {overlays.catalog.length > 0 ? (
          <Pressable
            style={[styles.layerButton, activeCount > 0 && styles.layerButtonOn]}
            onPress={() => {
              setProfilesOpen(false);
              setLayersOpen((open) => !open);
            }}
            accessibilityRole="button"
            accessibilityLabel={activeCount > 0 ? `Map layers, ${activeCount} on` : 'Map layers'}
            accessibilityState={{ expanded: layersOpen }}
            testID="layer-quick-toggle"
          >
            <LayersIcon color={activeCount > 0 ? theme.accent : theme.text} size={21} />
            <Text style={styles.controlLabel}>Layers</Text>
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
    right: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  profileTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 44,
    paddingHorizontal: 11,
    borderRadius: 22,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: 'transparent',
    elevation: 4,
  },
  controlSelected: { borderColor: theme.accent, backgroundColor: theme.surfaceActive },
  controlLabel: { color: theme.text, fontSize: 12, fontWeight: '700' },
  disclosure: { color: theme.textMuted, fontSize: 11 },
  layerButton: {
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 11,
    flexDirection: 'row',
    gap: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surface,
    elevation: 4,
  },
  layerButtonOn: { backgroundColor: theme.surfaceActive },
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
  countText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  layerMenu: {
    position: 'absolute',
    right: 64,
    width: 250,
    padding: 4,
    borderRadius: 12,
    backgroundColor: theme.surface,
    elevation: 8,
  },
  profileMenu: {
    position: 'absolute',
    right: 64,
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
    borderColor: '#cdd3dd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { borderColor: theme.accent, backgroundColor: theme.accent },
  checkText: { color: '#fff', fontWeight: '800', fontSize: 12, lineHeight: 14 },
  layerLabel: { flex: 1, color: theme.text, fontSize: 14 },
  layerLabelOn: { color: theme.accent, fontWeight: '700' },
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
