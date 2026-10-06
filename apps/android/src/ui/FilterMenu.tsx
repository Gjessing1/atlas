import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useSideInsets } from './insets';
import { theme } from './theme';

export interface FilterOption<K extends string | number> {
  key: K;
  label: string;
  count?: number;
}

/**
 * One filter as one pill: "Sport ▾" while it is off, "Running ✕" while it is on. Tapping opens
 * a short menu of the choices with how many items each holds. A row of these replaces a wall
 * of chips — twelve sports and five years were five rows of chips above a list a phone could
 * then barely show.
 */
export function FilterMenu<K extends string | number>({
  label,
  allLabel,
  value,
  options,
  onChange,
  testID,
}: {
  /** What is being filtered, shown while nothing is picked ("Sport"). */
  label: string;
  /** The menu's first row, which clears the filter ("All sports"). */
  allLabel: string;
  value: K | null;
  options: readonly FilterOption<K>[];
  onChange: (value: K | null) => void;
  testID: string;
}) {
  const [open, setOpen] = useState(false);
  const side = useSideInsets();
  const picked = value === null ? null : options.find((option) => option.key === value);
  const pick = (next: K | null) => {
    setOpen(false);
    onChange(next);
  };
  return (
    <>
      <View style={[styles.pill, picked && styles.pillOn]}>
        <Pressable
          style={styles.pillMain}
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${picked ? picked.label : allLabel}`}
          testID={testID}
        >
          <Text style={[styles.pillText, picked && styles.pillTextOn]} numberOfLines={1}>
            {picked ? picked.label : label}
          </Text>
          {picked ? null : <Text style={styles.caret}>▾</Text>}
        </Pressable>
        {picked ? (
          <Pressable
            style={styles.clear}
            onPress={() => onChange(null)}
            hitSlop={8}
            accessibilityLabel={`Clear ${label.toLocaleLowerCase()} filter`}
            testID={`${testID}-clear`}
          >
            <Text style={[styles.pillText, styles.pillTextOn]}>✕</Text>
          </Pressable>
        ) : null}
      </View>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={[styles.backdrop, { paddingLeft: 24 + side.left, paddingRight: 24 + side.right }]}
          onPress={() => setOpen(false)}
          accessibilityLabel="Close menu"
        >
          {/* A Pressable that does nothing keeps taps inside the card off the backdrop. */}
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.title}>{label}</Text>
            <ScrollView style={styles.list}>
              {[{ key: null, label: allLabel } as const, ...options].map((option) => {
                const on = option.key === value;
                return (
                  <Pressable
                    key={String(option.key)}
                    style={[styles.row, on && styles.rowOn]}
                    onPress={() => pick(option.key)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    testID={`${testID}-option-${String(option.key ?? 'all')}`}
                  >
                    <Text style={[styles.rowText, on && styles.rowTextOn]}>{option.label}</Text>
                    {'count' in option && option.count !== undefined ? (
                      <Text style={styles.count}>{option.count}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export interface MenuAction {
  label: string;
  onPress: () => void;
  danger?: boolean;
  testID: string;
}

/**
 * "⋯" and the actions it holds: the occasional ones (rename, move, delete) that
 * should be one tap away without each taking a button's room on a phone row.
 */
export function ActionMenu({
  title,
  actions,
  testID,
}: {
  title: string;
  actions: readonly MenuAction[];
  testID: string;
}) {
  const [open, setOpen] = useState(false);
  const side = useSideInsets();
  return (
    <>
      <Pressable
        style={[styles.pill, styles.morePill]}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`More actions for ${title}`}
        testID={testID}
      >
        <Text style={styles.more}>⋯</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          style={[styles.backdrop, { paddingLeft: 24 + side.left, paddingRight: 24 + side.right }]}
          onPress={() => setOpen(false)}
          accessibilityLabel="Close menu"
        >
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {actions.map((action) => (
              <Pressable
                key={action.testID}
                style={styles.row}
                onPress={() => {
                  setOpen(false);
                  action.onPress();
                }}
                testID={action.testID}
              >
                <Text style={[styles.rowText, action.danger && styles.danger]}>{action.label}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
  },
  pillOn: { borderColor: theme.accent, backgroundColor: theme.accentFaint },
  pillMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 12,
    paddingRight: 10,
    minHeight: 36,
  },
  pillText: { fontSize: 14, color: theme.text, fontWeight: '600' },
  pillTextOn: { color: theme.accent },
  caret: { fontSize: 12, color: theme.textMuted },
  clear: { paddingLeft: 2, paddingRight: 12, minHeight: 36, justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: theme.backdrop, justifyContent: 'center' },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    paddingVertical: 8,
    maxHeight: '70%',
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
    color: theme.textMuted,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 18,
  },
  rowOn: { backgroundColor: theme.accentFaint },
  rowText: { fontSize: 16, color: theme.text },
  rowTextOn: { fontWeight: '700', color: theme.accent },
  count: { fontSize: 14, color: theme.textMuted },
  morePill: { paddingHorizontal: 14, justifyContent: 'center' },
  more: { fontSize: 18, lineHeight: 20, color: theme.text, fontWeight: '700' },
  danger: { color: theme.danger },
});
