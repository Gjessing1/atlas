import type { TrackRecord } from '@atlas/storage';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

/** Direct map-level entry point for the Fish & Hunt permit workflow. */
export function PermitButton({
  top,
  left,
  onPress,
}: {
  top: number;
  left: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.mapButton, { top, left }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="My permit area"
      testID="permit-open"
    >
      <Text style={styles.mapButtonText}>My permit area</Text>
    </Pressable>
  );
}

export function PermitSheet({
  visible,
  onClose,
  onSave,
  onSaved,
  bottomInset = 0,
}: {
  visible: boolean;
  onClose: () => void;
  onSave: (input: string) => Promise<TrackRecord | null>;
  onSaved: (track: TrackRecord) => void;
  bottomInset?: number;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const track = await onSave(input.trim());
      if (!track) return;
      setInput('');
      onSaved(track);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="permit-sheet"
    >
      <Text style={styles.heading}>My permit area</Text>
      <Text style={styles.body}>
        Paste the iNatur hunting or fishing offer you bought. Atlas will save its exact published
        boundary as a filled map overlay.
      </Text>
      <View style={styles.row}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={(value) => {
            setInput(value);
            setError(null);
          }}
          placeholder="iNatur offer link or id"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          onSubmitEditing={() => void save()}
          accessibilityLabel="iNatur offer link or id"
          testID="permit-input"
        />
        <Pressable
          style={[styles.save, (busy || !input.trim()) && styles.disabled]}
          disabled={busy || !input.trim()}
          onPress={() => void save()}
          testID="permit-save"
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.saveText}>Show area</Text>
          )}
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Text style={styles.note}>
        The map is never permission. Your permit terms still decide what and when you may hunt or
        fish.
      </Text>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  mapButton: {
    position: 'absolute',
    zIndex: 20,
    height: 34,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 17,
    backgroundColor: '#c2410c',
    elevation: 4,
  },
  mapButtonText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  heading: { color: theme.text, fontSize: 20, fontWeight: '700' },
  body: { color: theme.textMuted, fontSize: 14, lineHeight: 20, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  input: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 9,
    color: theme.text,
    fontSize: 14,
  },
  save: {
    minWidth: 92,
    minHeight: 42,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 9,
    backgroundColor: '#c2410c',
  },
  saveText: { color: '#fff', fontWeight: '700' },
  disabled: { opacity: 0.5 },
  error: { color: theme.danger, fontSize: 13, marginTop: 10 },
  note: { color: theme.textMuted, fontSize: 12, lineHeight: 17, marginTop: 12 },
});
