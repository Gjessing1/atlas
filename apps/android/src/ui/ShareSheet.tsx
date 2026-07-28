import { atlasShareUrl, shareFormats, type LatLng, type ShareFormat } from '@atlas/core';
import { Linking, Modal, Pressable, Share, StyleSheet, Text } from 'react-native';

import { getServerOrigin } from '../serverOrigin';
import { copyToClipboard } from './clipboard';
import { useSideInsets } from './insets';
import { theme } from './theme';

export interface ShareTarget extends LatLng {
  name: string;
}

/**
 * A small chooser for *how* to share a point, because one format never suits
 * everyone: an Atlas link opens the map here, plain coordinates paste anywhere,
 * and a `geo:` link hands the point to whatever map app the user actually
 * prefers. Presented as a compact bottom sheet over the destination card.
 *
 * The options themselves come from `shareFormats` in @atlas/core, so the web
 * card's chooser offers the same things in the same words — everything platform
 * -specific is the *doing*, below, not the list.
 */
export function ShareSheet({
  target,
  zoom,
  onClose,
  bottomInset = 0,
}: {
  /** The point to share, or null when the sheet is closed. */
  target: ShareTarget | null;
  /** Current map zoom, so the shared Atlas link opens at a sensible scale. */
  zoom: number;
  onClose: () => void;
  bottomInset?: number;
}) {
  const side = useSideInsets();
  if (!target) return null;
  const pin = { lat: target.lat, lng: target.lng };

  const act = (format: ShareFormat) => {
    if (format.action === 'send') void Share.share({ message: format.payload });
    // geo: lets Android offer every installed map app.
    else if (format.action === 'open') void Linking.openURL(format.payload);
    else copyToClipboard(format.payload);
    onClose();
  };

  const options = shareFormats(
    pin,
    target.name,
    atlasShareUrl(`${getServerOrigin()}/`, pin, zoom),
    {
      handoff: true,
    },
  );

  return (
    <Modal
      visible
      animationType="fade"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} testID="share-backdrop">
        {/* Stop taps on the card itself from dismissing the sheet. */}
        <Pressable
          style={[
            styles.sheet,
            {
              paddingBottom: bottomInset + 16,
              // Landscape: clear the side-mounted system navigation bar.
              paddingLeft: 20 + side.left,
              paddingRight: 20 + side.right,
            },
          ]}
          onPress={() => {}}
          testID="share-sheet"
        >
          <Text style={styles.heading} numberOfLines={1}>
            Share {target.name}
          </Text>
          {options.map((option) => (
            <Pressable
              key={option.key}
              style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
              onPress={() => act(option)}
              testID={`share-${option.key}`}
            >
              <Text style={styles.optionTitle}>{option.title}</Text>
              <Text style={styles.optionSubtitle} numberOfLines={1}>
                {option.subtitle}
              </Text>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: theme.backdrop, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 18,
    gap: 8,
    elevation: 16,
  },
  heading: { fontSize: 15, fontWeight: '700', color: theme.text, marginBottom: 4 },
  option: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: theme.surfaceMuted,
  },
  optionPressed: { backgroundColor: theme.surfaceActive },
  optionTitle: { fontSize: 15, fontWeight: '700', color: theme.text },
  optionSubtitle: { fontSize: 12, color: theme.textMuted, marginTop: 2 },
});
