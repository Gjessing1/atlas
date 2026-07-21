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
  const win = useWindowDimensions();
  const activeCount = overlays.overlays.length;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {layersOpen ? (
        <Pressable
          style={styles.backdrop}
          onPress={() => setLayersOpen(false)}
          accessibilityLabel="Close map layers"
          testID="layer-quick-backdrop"
        />
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
        <View style={styles.profilePlate} accessibilityLabel="Map profile">
          {MAP_PROFILES.map((item) => {
            const active = item.id === profile.profile.id;
            const Icon = MAP_PROFILE_ICON[item.id]!;
            return (
              <Pressable
                key={item.id}
                style={[styles.profileButton, active && styles.profileButtonOn]}
                onPress={() => onPickProfile(item.id)}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: active }}
                testID={`map-profile-${item.id}`}
              >
                <Icon color={active ? '#fff' : theme.text} size={20} />
              </Pressable>
            );
          })}
        </View>

        {overlays.catalog.length > 0 ? (
          <Pressable
            style={[styles.layerButton, activeCount > 0 && styles.layerButtonOn]}
            onPress={() => setLayersOpen((open) => !open)}
            accessibilityRole="button"
            accessibilityLabel={activeCount > 0 ? `Map layers, ${activeCount} on` : 'Map layers'}
            accessibilityState={{ expanded: layersOpen }}
            testID="layer-quick-toggle"
          >
            <LayersIcon color={activeCount > 0 ? theme.accent : theme.text} size={21} />
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
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  profilePlate: {
    flexDirection: 'row',
    gap: 2,
    padding: 3,
    borderRadius: 22,
    backgroundColor: theme.surface,
    elevation: 4,
  },
  profileButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileButtonOn: { backgroundColor: theme.accent },
  layerButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
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
    right: 12,
    width: 250,
    padding: 4,
    borderRadius: 12,
    backgroundColor: theme.surface,
    elevation: 8,
  },
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
