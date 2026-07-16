import { StyleSheet, Text, View } from 'react-native';

/**
 * Colour-badged teardrop pin — the mobile twin of the web's `.place-marker`
 * CSS marker (a rounded square with one sharp corner as the tail, rotated so
 * the tail points straight down, with the emoji un-rotated inside). The
 * wrapper is sized to the rotated square's diagonal so the tail tip touches
 * its bottom edge, making it safe to anchor a map Marker at "bottom".
 */
export function PlacePin({ color, icon }: { color: string; icon?: string }) {
  return (
    <View style={pinStyles.wrap}>
      <View style={[pinStyles.body, { backgroundColor: color }]}>
        {icon ? <Text style={pinStyles.glyph}>{icon}</Text> : <View style={pinStyles.dot} />}
      </View>
    </View>
  );
}

const PIN_SIZE = 28;
const PIN_BOX = Math.ceil(PIN_SIZE * Math.SQRT2);

const pinStyles = StyleSheet.create({
  wrap: { width: PIN_BOX, height: PIN_BOX, alignItems: 'center', justifyContent: 'center' },
  body: {
    width: PIN_SIZE,
    height: PIN_SIZE,
    borderRadius: PIN_SIZE / 2,
    // The sharp corner becomes the tail once rotated -45°.
    borderBottomLeftRadius: 0,
    borderWidth: 2,
    borderColor: '#fff',
    transform: [{ rotate: '-45deg' }],
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
  },
  glyph: { fontSize: 13, transform: [{ rotate: '45deg' }] },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
});

/** The standard GPS crosshair (ring + four ticks + centre dot) for the locate button. */
export function CrosshairIcon({ color = '#3a4455' }: { color?: string }) {
  return (
    <View style={xStyles.box}>
      <View style={[xStyles.ring, { borderColor: color }]} />
      <View style={[xStyles.dot, { backgroundColor: color }]} />
      <View style={[xStyles.tickV, xStyles.tickN, { backgroundColor: color }]} />
      <View style={[xStyles.tickV, xStyles.tickS, { backgroundColor: color }]} />
      <View style={[xStyles.tickH, xStyles.tickW, { backgroundColor: color }]} />
      <View style={[xStyles.tickH, xStyles.tickE, { backgroundColor: color }]} />
    </View>
  );
}

const xStyles = StyleSheet.create({
  box: { width: 24, height: 24 },
  ring: {
    position: 'absolute',
    left: 4,
    top: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
  },
  dot: { position: 'absolute', left: 10, top: 10, width: 4, height: 4, borderRadius: 2 },
  tickV: { position: 'absolute', left: 11, width: 2, height: 5, borderRadius: 1 },
  tickN: { top: 0 },
  tickS: { bottom: 0 },
  tickH: { position: 'absolute', top: 11, width: 5, height: 2, borderRadius: 1 },
  tickW: { left: 0 },
  tickE: { right: 0 },
});
