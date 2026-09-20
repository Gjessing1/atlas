import { POI_CATEGORIES, type PoiCategoryId } from '@atlas/core';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { theme } from './theme';

/** The unchanged text-only category row shared by the compact dock and list. */
export function PoiCategoryDock({
  categories,
  onToggle,
  onShowAll,
}: {
  categories: readonly PoiCategoryId[];
  onToggle: (id: PoiCategoryId) => void;
  onShowAll: () => void;
}) {
  return (
    <View style={styles.control} accessibilityLabel="POI categories">
      <Text style={styles.title}>POIs</Text>
      <ScrollView
        horizontal
        style={styles.scroller}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        directionalLockEnabled
      >
        <Pressable
          style={[styles.button, categories.length === 0 ? styles.buttonOn : null]}
          onPress={onShowAll}
          accessibilityRole="button"
          accessibilityState={{ selected: categories.length === 0 }}
          testID="poi-category-all"
        >
          <Text style={[styles.text, categories.length === 0 ? styles.textOn : null]}>All</Text>
        </Pressable>
        {POI_CATEGORIES.map((category) => {
          const on = categories.includes(category.id);
          return (
            <Pressable
              key={category.id}
              style={[styles.button, on ? styles.buttonOn : null]}
              onPress={() => onToggle(category.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              testID={`poi-category-${category.id}`}
            >
              <Text style={[styles.text, on ? styles.textOn : null]}>{category.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  control: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: 24,
    backgroundColor: theme.surface,
  },
  title: { fontSize: 12, fontWeight: '700', color: theme.text },
  scroller: { flex: 1 },
  scroll: {
    flexDirection: 'row',
    padding: 2,
    borderRadius: 999,
    backgroundColor: theme.surfaceMuted,
  },
  button: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  buttonOn: { backgroundColor: theme.surface, elevation: 1 },
  text: { fontSize: 11, color: theme.textMuted, opacity: 0.75 },
  textOn: { color: theme.text, opacity: 1, fontWeight: '700' },
});
