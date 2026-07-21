import type { LayerMeta } from '@atlas/core';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { OverlaysController } from '../layers/useOverlays';
import { theme } from './theme';

/** Opacity choices as chips — no native slider dependency, OTA-friendly. */
const OPACITY_STEPS = [0.25, 0.5, 0.75, 1];

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
  const groups: [string, LayerMeta[]][] = [];
  for (const meta of overlays.catalog) {
    const group = groups.find(([name]) => name === meta.group);
    if (group) group[1].push(meta);
    else groups.push([meta.group, [meta]]);
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: bottomInset + 20 }]}>
          <Text style={styles.heading}>Map layers</Text>
          {overlays.catalog.length === 0 ? (
            <Text style={styles.muted}>
              No layers available — the layer catalog needs a server connection at least once.
            </Text>
          ) : (
            <ScrollView>
              {groups.map(([group, metas]) => (
                <View key={group}>
                  <Text style={styles.groupHeading}>{group}</Text>
                  {metas.map((meta) => {
                    const on = overlays.isOn(meta.id);
                    const opacity = overlays.state[meta.id]?.opacity ?? meta.defaultOpacity;
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
                        {on && meta.minzoom !== undefined ? (
                          <Text style={styles.hint}>
                            Visible from zoom {meta.minzoom} — zoom in.
                          </Text>
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
                                    Math.abs(opacity - step) < 0.125
                                      ? styles.opacityChipTextOn
                                      : null,
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
            </ScrollView>
          )}
          <Pressable style={styles.closeButton} onPress={onClose} testID="layers-close">
            <Text style={styles.closeButtonText}>Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    maxHeight: '85%',
  },
  heading: { fontSize: 15, fontWeight: '700', color: '#334', marginBottom: 4 },
  groupHeading: {
    marginTop: 10,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: theme.textMuted,
  },
  row: { paddingVertical: 8 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#cdd3dd',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  checkmark: { color: '#fff', fontWeight: '800', fontSize: 14, lineHeight: 16 },
  layerTitle: { fontSize: 15, color: theme.text },
  muted: { fontSize: 13, color: theme.textMuted, marginTop: 4 },
  sourceLink: { color: theme.accent, textDecorationLine: 'underline' },
  hint: { fontSize: 12, color: theme.warning, marginTop: 2 },
  opacityRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  opacityChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#eef1f6',
  },
  opacityChipOn: { backgroundColor: theme.accent },
  opacityChipText: { fontSize: 13, fontWeight: '600', color: '#334' },
  opacityChipTextOn: { color: '#fff' },
  closeButton: {
    marginTop: 12,
    alignSelf: 'stretch',
    alignItems: 'center',
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingVertical: 9,
  },
  closeButtonText: { color: '#fff', fontWeight: '600' },
});
