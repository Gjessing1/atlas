import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

/**
 * A single-line text-input dialog. React Native's `Alert.prompt` is iOS-only, so
 * Android needs this for name-on-save and rename (the mobile counterpart of the
 * web Sidebar's editable name field). Controlled by `visible`; the caller keeps
 * whatever context (e.g. the coords to save, or the place id to rename) and acts
 * on the entered value in `onConfirm`.
 */
export function PromptModal({
  visible,
  title,
  initialValue = '',
  placeholder,
  confirmLabel = 'Save',
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);

  // Reset the field to the caller's initial value each time the dialog opens, so
  // a reused modal never shows the previous prompt's text.
  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{title}</Text>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => onConfirm(value)}
            testID="prompt-input"
          />
          <View style={styles.buttonRow}>
            <Pressable style={[styles.button, styles.buttonQuiet]} onPress={onCancel}>
              <Text style={styles.buttonQuietText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={styles.button}
              onPress={() => onConfirm(value)}
              testID="prompt-confirm"
            >
              <Text style={styles.buttonText}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    alignSelf: 'stretch',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 18,
    gap: 12,
  },
  title: { fontSize: 16, fontWeight: '700', color: '#223' },
  input: {
    borderWidth: 1,
    borderColor: '#cdd3dd',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#111',
  },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  button: {
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  buttonText: { color: '#fff', fontWeight: '600' },
  buttonQuiet: { backgroundColor: '#eef1f6' },
  buttonQuietText: { color: '#334', fontWeight: '600' },
});
