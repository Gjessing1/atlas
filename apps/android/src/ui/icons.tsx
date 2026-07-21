import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

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

/**
 * Solid course-up navigation arrow (forward = up on screen) with the classic
 * swallow-tail notch, for the map-orientation toggle while navigating.
 */
export function NavArrowIcon({
  color = '#1a73e8',
  notchColor = '#fff',
}: {
  color?: string;
  notchColor?: string;
}) {
  return (
    <View style={aStyles.box}>
      <View style={[aStyles.body, { borderBottomColor: color }]} />
      <View style={[aStyles.notch, { borderBottomColor: notchColor }]} />
    </View>
  );
}

const aStyles = StyleSheet.create({
  box: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  body: {
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 18,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  notch: {
    position: 'absolute',
    bottom: 3,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 5,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
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

/** Folded-map outline for the navigation route-overview control. */
export function MapOverviewIcon({ color = '#1a73e8' }: { color?: string }) {
  return (
    <Svg width={24} height={24} viewBox="0 0 24 24">
      <Path
        d="m3.5 6 5-2.5 7 3 5-2.5v14l-5 2.5-7-3-5 2.5zM8.5 3.5v14M15.5 6.5v14"
        fill="none"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Magnifier (ring + diagonal handle) for the collapsed search button. */
export function SearchIcon({ color = '#3a4455' }: { color?: string }) {
  return (
    <View style={sStyles.box}>
      <View style={[sStyles.ring, { borderColor: color }]} />
      <View style={[sStyles.handle, { backgroundColor: color }]} />
    </View>
  );
}

const sStyles = StyleSheet.create({
  box: { width: 24, height: 24 },
  ring: {
    position: 'absolute',
    left: 3,
    top: 3,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    borderWidth: 2.5,
  },
  handle: {
    position: 'absolute',
    left: 12,
    top: 15.5,
    width: 9,
    height: 3,
    borderRadius: 1.5,
    transform: [{ rotate: '45deg' }],
  },
});

/** Three-bar hamburger for the bottom-left menu button. */
export function MenuIcon({ color = '#3a4455' }: { color?: string }) {
  return (
    <View style={mStyles.box}>
      <View style={[mStyles.bar, { top: 4, backgroundColor: color }]} />
      <View style={[mStyles.bar, { top: 10.5, backgroundColor: color }]} />
      <View style={[mStyles.bar, { top: 17, backgroundColor: color }]} />
    </View>
  );
}

const mStyles = StyleSheet.create({
  box: { width: 24, height: 24 },
  bar: { position: 'absolute', left: 2, width: 20, height: 3, borderRadius: 1.5 },
});

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
