import { mapProfile, type LayerMeta, type LayerOption } from '@atlas/core';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { OverlaysController } from '../layers/useOverlays';
import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

/** Opacity choices as chips — no native slider dependency, OTA-friendly. */
const OPACITY_STEPS = [0.25, 0.5, 0.75, 1];

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

/** Full layer controls without sheet chrome, reused by Settings → Map. */
export function LayersContent({ overlays }: { overlays: OverlaysController }) {
  const groups: [string, LayerMeta[]][] = [];
  for (const meta of overlays.catalog) {
    const group = groups.find(([name]) => name === meta.group);
    if (group) group[1].push(meta);
    else groups.push([meta.group, [meta]]);
  }

  if (overlays.catalog.length === 0) {
    return (
      <Text style={styles.muted}>
        No layers available — the layer catalog needs a server connection at least once.
      </Text>
    );
  }

  const note = mapProfile(overlays.profileId).note;

  return (
    <View>
      {note ? <Text style={styles.profileNote}>{note}</Text> : null}
      {groups.map(([group, metas]) => (
        <View key={group}>
          <Text style={styles.groupHeading}>{group}</Text>
          {metas.map((meta) => {
            const on = overlays.isOn(meta.id);
            const opacity = overlays.opacityFor(meta.id);
            return (
              <View key={meta.id} style={styles.row}>
                <Pressable
                  style={styles.toggleRow}
                  onPress={() => overlays.toggle(meta.id)}
                  testID={`layer-toggle-${meta.id}`}
                >
                  <View style={[styles.checkbox, on ? styles.checkboxOn : null]}>
                    {on ? <Text style={styles.checkmark}>✓</Text> : null}
                  </View>
                  <Text style={styles.layerTitle}>{meta.title}</Text>
                </Pressable>
                <Text style={styles.muted}>
                  {meta.description}{' '}
                  {meta.metadataUrl ? (
                    <Text
                      style={styles.sourceLink}
                      onPress={() => void Linking.openURL(meta.metadataUrl!)}
                    >
                      source
                    </Text>
                  ) : null}
                </Text>
                {on
                  ? meta.options?.map((option) => (
                      <LayerOptionChips
                        key={option.key}
                        overlays={overlays}
                        meta={meta}
                        option={option}
                      />
                    ))
                  : null}
                {on && meta.minzoom !== undefined ? (
                  <Text style={styles.hint}>Visible from zoom {meta.minzoom} — zoom in.</Text>
                ) : null}
                {on && meta.coverageNote ? (
                  <Text style={styles.hint}>{meta.coverageNote}</Text>
                ) : null}
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
          })}
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
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  overlays: OverlaysController;
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
        <LayersContent overlays={overlays} />
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
  row: { paddingVertical: 8 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  checkmark: { color: theme.onAccent, fontWeight: '800', fontSize: 14, lineHeight: 16 },
  layerTitle: { fontSize: 15, color: theme.text },
  muted: { fontSize: 13, color: theme.textMuted, marginTop: 4 },
  sourceLink: { color: theme.accent, textDecorationLine: 'underline' },
  hint: { fontSize: 12, color: theme.warning, marginTop: 2 },
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
