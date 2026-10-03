import { StyleSheet, Text, View, type ColorValue } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { theme } from './theme';

/**
 * Colour-badged teardrop pin — the mobile twin of the web's `.place-marker`
 * CSS marker (a rounded square with one sharp corner as the tail, rotated so
 * the tail points straight down, with the emoji un-rotated inside). The
 * wrapper is sized to the rotated square's diagonal so the tail tip touches
 * its bottom edge, making it safe to anchor a map Marker at "bottom".
 */
export function PlacePin({
  color,
  icon,
  selected = false,
}: {
  color: string;
  icon?: string;
  selected?: boolean;
}) {
  return (
    <View style={[pinStyles.wrap, selected ? pinStyles.wrapSelected : null]}>
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
  wrapSelected: {
    borderRadius: PIN_BOX / 2,
    backgroundColor: 'rgba(79,145,239,0.25)',
    transform: [{ scale: 1.18 }],
  },
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
  color?: ColorValue;
  notchColor?: ColorValue;
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
export function CrosshairIcon({ color = theme.icon }: { color?: string }) {
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

/** Sun behind a cloud: a stable, tintable weather action glyph. */
export function WeatherIcon({ color = theme.icon }: { color?: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Circle cx={8} cy={8} r={3.2} stroke={color} strokeWidth={1.7} fill="none" />
      <Path
        d="M8 2.3v1.4M8 12.3v1.4M2.3 8h1.4M12.3 8h1.4M4 4l1 1M11 11l1 1M12 4l-1 1M4 12l1-1"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <Path
        d="M7.2 18.7h10.6a3.2 3.2 0 0 0 .2-6.4 4.7 4.7 0 0 0-8.8-1.4 3.9 3.9 0 0 0-2 .6 3.7 3.7 0 0 0 0 7.2z"
        fill="#fff"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Magnifier (ring + diagonal handle) for the collapsed search button. */
export function SearchIcon({ color = theme.icon }: { color?: string }) {
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

/**
 * Cloud with a slash through it — "the map is not coming from the server".
 * Used as the offline-tiles badge, where the pack's name (which the badge used
 * to spell out) is a detail for Settings, not for the map.
 */
export function CloudOffIcon({ color = theme.icon }: { color?: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M7 18.5h10.3a3.5 3.5 0 0 0 .3-7 5.2 5.2 0 0 0-9.6-1.6 4.2 4.2 0 0 0-2.2.7 4 4 0 0 0 1.2 7.9z"
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
      <Path d="M4 3.5 20.5 20" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

/** Three-bar hamburger for the bottom-left menu button. */
export function MenuIcon({ color = theme.icon }: { color?: string }) {
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

/** Right-pointing chevron for drill-down menu rows. */
export function ChevronRightIcon({ color = theme.icon }: { color?: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path
        d="m9 5 7 7-7 7"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Left-pointing chevron for the "back to menu" header. */
export function ChevronLeftIcon({ color = theme.icon }: { color?: string }) {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Path
        d="m15 5-7 7 7 7"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Edit — the nib and its stroke; the sheet's twin of the web panel's pencil. */
export function PencilIcon({ color = theme.icon }: { color?: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M4.5 19.5l4.2-1 9.4-9.4a1.8 1.8 0 0 0 0-2.6l-.6-.6a1.8 1.8 0 0 0-2.6 0L5.5 15.3l-1 4.2z"
        fill="none"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
      />
      <Path
        d="M14.2 7.3l2.5 2.5"
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Camera outline for photo discovery actions. */
export function CameraIcon({ color = theme.icon }: { color?: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M4 8.5h3l1.3-2h7.4l1.3 2h3v10H4z"
        fill="none"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={13.5} r={3.1} fill="none" stroke={color} strokeWidth={1.7} />
    </Svg>
  );
}

/**
 * "Names on the map": a pin head with a name line under it — the label switch
 * on folder rows and the tag filter. Same shape as web's `PinLabelIcon`.
 */
export function PinLabelIcon({ color = theme.icon }: { color?: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Circle cx={12} cy={7.5} r={3.6} fill="none" stroke={color} strokeWidth={1.7} />
      <Path d="M12 11.1v2.4" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
      <Path d="M5 17.5h14M8 21h8" stroke={color} strokeWidth={1.9} strokeLinecap="round" />
    </Svg>
  );
}

/** Done — the same button, once it has been opened. */
export function CheckIcon({ color = theme.icon }: { color?: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      <Path
        d="M5.5 12.5l4.2 4.2 8.8-9.4"
        fill="none"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
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
