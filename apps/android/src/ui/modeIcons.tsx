import type { RoutingProfile } from '@atlas/routing';
import type { TransitMode } from '@atlas/transit';
import { filterModeOf } from '@atlas/transit';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * Travel-mode glyphs as real vector icons rather than emoji.
 *
 * Emoji were doing this job and it never looked deliberate: they carry their
 * own colours (so a selected chip cannot tint them), render at whatever size
 * and baseline the system font decides, and differ between Android versions —
 * 🚊 and 🚆 are near-identical on some, unrecognisable on others. These are
 * drawn on a 24×24 grid with `currentColor`-style tinting, so a mode picker
 * can be icon-only the way a maps app's should be: shapes read faster than
 * words, and the row fits on one line.
 *
 * `react-native-svg` is already a native dependency of the app, so this stays
 * shippable as an OTA update — no APK required.
 */

export interface ModeIconProps {
  color?: string;
  size?: number;
}

const DEFAULT_COLOR = '#3a4455';

/** Car: cabin over a body, two wheels. */
export function CarIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M3.5 17v-3.2a2 2 0 0 1 1.2-1.8h14.6a2 2 0 0 1 1.2 1.8V17a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-.8H7v.8a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1z"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={7} cy={14.5} r={1} fill={color} />
      <Circle cx={17} cy={14.5} r={1} fill={color} />
    </Svg>
  );
}

/** Bicycle: two wheels, a crank and the frame's top tube. */
export function BicycleIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={5.5} cy={16} r={3.7} stroke={color} strokeWidth={1.7} fill="none" />
      <Circle cx={18.5} cy={16} r={3.7} stroke={color} strokeWidth={1.7} fill="none" />
      <Path
        d="M5.5 16l4-6.5h5L18.5 16M9.5 9.5h5.5M12 16l2.5-6.5"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path d="M15.5 6.2h2.2" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
    </Svg>
  );
}

/** Walking figure: head, torso, and the classic mid-stride legs. */
export function WalkIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={13} cy={4.2} r={2} fill={color} />
      <Path
        d="M13 8.2l-3 1.8-1.2 3.5M13 8.2l2.4 1.6 1.6 2.6M13 8.2v4.6l2 3.2.8 3.8M13 12.8l-2.6 3-1.2 3.8"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/**
 * Hiking: an evergreen, which is what "hike" means here — the profile prefers
 * trails and terrain, not a different gait. A boot would collide with the walk
 * figure at chip size, which is the exact confusion this set exists to remove.
 */
export function HikeIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 2.5l-3.6 5.4h2L7 13.4h2.4L6.4 18.6h11.2L14.6 13.4H17L13.6 7.9h2z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        fill="none"
      />
      <Path d="M12 18.6v3" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

/** Bus: windscreen, body, wheels — the shape used for coaches too. */
export function BusIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect
        x={4.5}
        y={3}
        width={15}
        height={14.5}
        rx={2.4}
        stroke={color}
        strokeWidth={1.7}
        fill="none"
      />
      <Path d="M4.5 11.5h15M9 3v8.5" stroke={color} strokeWidth={1.5} />
      <Circle cx={8} cy={14.6} r={1.15} fill={color} />
      <Circle cx={16} cy={14.6} r={1.15} fill={color} />
      <Path
        d="M7.5 17.5v2M16.5 17.5v2"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

/** Tram: a railcar with a pantograph arm to the overhead wire. */
export function TramIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 2v2.5M8.5 1.6l7 2" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <Rect
        x={5.5}
        y={4.5}
        width={13}
        height={13}
        rx={3}
        stroke={color}
        strokeWidth={1.7}
        fill="none"
      />
      <Path d="M5.5 11h13" stroke={color} strokeWidth={1.5} />
      <Circle cx={9} cy={14.3} r={1.1} fill={color} />
      <Circle cx={15} cy={14.3} r={1.1} fill={color} />
      <Path
        d="M8.5 17.5l-1.5 2.5M15.5 17.5l1.5 2.5"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Train: a locomotive nose over rails — heavy rail, distinct from the tram's wire. */
export function TrainIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M6 16.5V7.5c0-2.2 2.7-3.5 6-3.5s6 1.3 6 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 16.5z"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
        fill="none"
      />
      <Path d="M6 11h12" stroke={color} strokeWidth={1.5} />
      <Circle cx={9.2} cy={14.6} r={1.1} fill={color} />
      <Circle cx={14.8} cy={14.6} r={1.1} fill={color} />
      <Path
        d="M8.5 18l-2 3M15.5 18l2 3M4.5 21h15"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Metro: the train shape in a roundel, the way underground networks sign themselves. */
export function MetroIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={9.2} stroke={color} strokeWidth={1.7} fill="none" />
      <Path
        d="M8.2 15.6V9.8c0-1.5 1.7-2.4 3.8-2.4s3.8.9 3.8 2.4v5.8a1 1 0 0 1-1 1h-5.6a1 1 0 0 1-1-1z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        fill="none"
      />
      <Path d="M8.2 12.2h7.6" stroke={color} strokeWidth={1.3} />
      <Circle cx={10.2} cy={14.4} r={0.85} fill={color} />
      <Circle cx={13.8} cy={14.4} r={0.85} fill={color} />
    </Svg>
  );
}

/** Ferry: a hull on water, with the wave line that says "this crosses a fjord". */
export function FerryIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M4.5 13.5l1.2-3.6a1.4 1.4 0 0 1 1.3-1h10a1.4 1.4 0 0 1 1.3 1l1.2 3.6"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M8.5 8.9V6.2h7v2.7M12 3v3.2"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M3 17.6c1.6 0 1.6 1.6 3.2 1.6s1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6 1.6-1.6 3.2-1.6 1.6 1.6 3.2 1.6"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M5 13.5h14l-1.4 3.2H6.4z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Plane: Entur really does return scheduled domestic flights on long queries. */
export function PlaneIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M2.5 13.2l19-6.4a1.6 1.6 0 0 0-1-2.2l-2.3-.5a2 2 0 0 0-1.5.3L11 8.2 5.6 7a1.4 1.4 0 0 0-1 .2l-1.2.8 4.4 3.1-2.6 1.8-2-.6-1 .7z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        fill="none"
      />
      <Path d="M6.5 19.5h13" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

/** Cable car: a cabin hanging from its haul rope. */
export function CableCarIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M2.5 5.5l19 3.5" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      <Path d="M11 7.2v2.6" stroke={color} strokeWidth={1.6} />
      <Rect
        x={5.5}
        y={9.8}
        width={11}
        height={8.4}
        rx={2.2}
        stroke={color}
        strokeWidth={1.7}
        fill="none"
      />
      <Path d="M5.5 13.6h11" stroke={color} strokeWidth={1.5} />
    </Svg>
  );
}

/** Fallback dot for a mode with no icon — a leg still has a time worth showing. */
export function UnknownModeIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={3.4} fill={color} />
    </Svg>
  );
}

type ModeIcon = (props: ModeIconProps) => React.ReactElement;

/** Road profiles, keyed by the ids in `ROUTING_PROFILES`. */
export const PROFILE_ICON: Record<RoutingProfile, ModeIcon> = {
  car: CarIcon,
  bike: BicycleIcon,
  foot: WalkIcon,
  hike: HikeIcon,
};

/**
 * Transit modes. `coach` shares the bus glyph deliberately: the wire keeps them
 * apart, but a traveller sees a bus either way.
 */
export const TRANSIT_ICON: Record<TransitMode, ModeIcon> = {
  foot: WalkIcon,
  bus: BusIcon,
  coach: BusIcon,
  tram: TramIcon,
  metro: MetroIcon,
  rail: TrainIcon,
  water: FerryIcon,
  air: PlaneIcon,
  funicular: CableCarIcon,
  cableway: CableCarIcon,
  unknown: UnknownModeIcon,
};

/** The icon for a leg's mode, folding coach onto bus and anything odd onto the dot. */
export function transitIcon(mode: TransitMode): ModeIcon {
  return TRANSIT_ICON[filterModeOf(mode)] ?? UnknownModeIcon;
}
