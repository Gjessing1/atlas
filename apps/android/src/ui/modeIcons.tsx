import type { RouteActionKey, RoutingProfile } from '@atlas/routing';
import type { TransitMode } from '@atlas/transit';
import { filterModeOf } from '@atlas/transit';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { theme } from './theme';

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

const DEFAULT_COLOR = theme.icon;

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

export function RunIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={14.8} cy={4.1} r={1.9} fill={color} />
      <Path
        d="M13.8 8.1l-3.5 2.2 2.8 2.1 2-1.2 2.6 2.1M13.1 12.4l-3 3.1-3.2 1.1M14.5 12l1 4 3.2 2.1"
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

/** Explore: a compass, because this profile has no routing opinion. */
export function CompassIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={8.8} stroke={color} strokeWidth={1.7} fill="none" />
      <Path
        d="M15.8 8.2l-2.2 5.4-5.4 2.2 2.2-5.4z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={12} cy={12} r={1} fill={color} />
    </Svg>
  );
}

/** Ski: crossed skis and poles, kept legible at the profile switch's 20 dp. */
export function SkiIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M7 4l8.5 15.2c.7 1.2 2.1 1.8 3.4 1.4M13 3.5L5.8 18.8c-.6 1.3-2 2-3.4 1.7M5 8l3.5 1.7M16 8.5l3-1.8M5 8l-2 9M19 6.7l1.8 10"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Fish & Hunt: a barbed fish hook — eye loop, shaft and bend. */
export function FishHuntIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={4.3} r={1.8} stroke={color} strokeWidth={1.6} fill="none" />
      <Path
        d="M12 6.1V13.5C12 17.5 6.5 17.8 7.2 13M7.2 13l-1.4 1M7.2 13l1.2 1"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Stacked map sheets: the compact overlay-catalog control. */
export function LayersIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 3l8.5 4.5L12 12 3.5 7.5zM4.5 12l7.5 4 7.5-4M4.5 16.5l7.5 4 7.5-4"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/**
 * Funnel: what the layers on the map are narrowed to (web's FilterIcon twin).
 * A funnel rather than sliders — every one of these filters picks *which*
 * records are drawn, and none of them is a continuous value.
 */
export function FilterIcon({ color = DEFAULT_COLOR, size = 20 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M4 5.5h16l-6.2 7.3v5.4l-3.6 1.8v-7.2z"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Directions sign: a turn arrow inside the diamond used by map apps. */
export function DirectionsIcon({ color = DEFAULT_COLOR, size = 23 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 2.8L21.2 12 12 21.2 2.8 12z"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M8.2 14.8v-2.2c0-1.5 1.2-2.7 2.7-2.7h4.2M12.8 7.6l2.4 2.3-2.4 2.3"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
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

export function CuriositiesIcon({ color = DEFAULT_COLOR, size = 22 }: ModeIconProps) {
  // Mirrors the web glyph exactly (apps/web/src/icons.tsx): a lens with a spark
  // beside it. No single subject icon would do — the profile carries heritage
  // sites, wrecks, caves, mines and springs at once.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={10.5} cy={10.5} r={5.8} stroke={color} strokeWidth={1.6} fill="none" />
      <Path d="M14.8 14.8l5 5" stroke={color} strokeWidth={1.8} strokeLinecap="round" fill="none" />
      <Path
        d="M18.4 3l.85 1.95 1.95.85-1.95.85L18.4 8.6l-.85-1.95-1.95-.85 1.95-.85z"
        stroke={color}
        strokeWidth={1.3}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/*
 * The route planner's toolbar, as glyphs — the same paths web draws
 * (apps/web/src/icons.tsx), so one action is one picture on both clients.
 *
 * The panel used to spend two bands on six same-weight text buttons for
 * actions nobody opens the planner to perform. Drawn, they cost one short row,
 * and Share finally looks like Share. Nothing is unlabelled: each button keeps
 * the descriptor's sentence as its TalkBack name, and the fold under ⋯ shows
 * the words beside the glyph.
 */

/** Sliders: the route's terms, folded behind one button. */
export function SlidersIcon({ color = DEFAULT_COLOR, size = 18 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M4 7.5h4.5M13 7.5h7M4 16.5h7M15.5 16.5h4.5"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        fill="none"
      />
      <Circle cx={10.8} cy={7.5} r={2.3} stroke={color} strokeWidth={1.7} fill="none" />
      <Circle cx={13.3} cy={16.5} r={2.3} stroke={color} strokeWidth={1.7} fill="none" />
    </Svg>
  );
}

/** The overflow: everything the mode's toolbar did not lead with. */
export function MoreIcon({ color = DEFAULT_COLOR, size = 18 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={5.2} cy={12} r={1.7} fill={color} />
      <Circle cx={12} cy={12} r={1.7} fill={color} />
      <Circle cx={18.8} cy={12} r={1.7} fill={color} />
    </Svg>
  );
}

/** A pin with a plus: add somewhere to stop on the way. */
export function PinPlusIcon({ color = DEFAULT_COLOR, size = 18 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 21.2s6.6-6.4 6.6-10.7a6.6 6.6 0 1 0-13.2 0C5.4 14.8 12 21.2 12 21.2z"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M12 7.6v5.9M9.05 10.55h5.9"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

/** Bookmark: keep this route as a track. */
export function BookmarkIcon({ color = DEFAULT_COLOR, size = 18 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M6.5 3.8h11a1 1 0 0 1 1 1v15.6L12 16.8l-6.5 3.6V4.8a1 1 0 0 1 1-1z"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Download: the route leaves as a file. */
export function DownloadIcon({ color = DEFAULT_COLOR, size = 18 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 3.8v10.6M7.8 10.6L12 14.8l4.2-4.2"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M4.6 17.6v1.6a1 1 0 0 0 1 1h12.8a1 1 0 0 0 1-1v-1.6"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

/** Two arrows passing: turn the journey around. */
export function SwapIcon({ color = DEFAULT_COLOR, size = 18 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M7.6 4.6v14.8M4.1 15.9l3.5 3.5 3.5-3.5"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M16.4 19.4V4.6M12.9 8.1l3.5-3.5 3.5 3.5"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Sparkles: let the planner choose the order of the stops. */
export function SparkleIcon({ color = DEFAULT_COLOR, size = 18 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M10 3.8l1.6 4.1 4.1 1.6-4.1 1.6L10 15.2l-1.6-4.1-4.1-1.6 4.1-1.6z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M17.2 14.2l.85 2.15 2.15.85-2.15.85-.85 2.15-.85-2.15-2.15-.85 2.15-.85z"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** Bin: throw the whole plan away. */
export function TrashIcon({ color = DEFAULT_COLOR, size = 18 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M5.5 6.8h13M9.8 6.8V5.3a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1v1.5"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M7.2 6.8l.75 12.1a1 1 0 0 0 1 .94h6.1a1 1 0 0 0 1-.94l.75-12.1"
        stroke={color}
        strokeWidth={1.7}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M10.5 10.2v6.2M13.5 10.2v6.2"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

/** Share, drawn the way every other app draws it: three nodes and two links. */
export function ShareIcon({ color = DEFAULT_COLOR, size = 18 }: ModeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={18} cy={5.4} r={2.6} stroke={color} strokeWidth={1.7} fill="none" />
      <Circle cx={6} cy={12} r={2.6} stroke={color} strokeWidth={1.7} fill="none" />
      <Circle cx={18} cy={18.6} r={2.6} stroke={color} strokeWidth={1.7} fill="none" />
      <Path
        d="M8.35 10.75l7.3-4.05M8.35 13.25l7.3 4.05"
        stroke={color}
        strokeWidth={1.7}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

type ModeIcon = (props: ModeIconProps) => React.ReactElement;

/**
 * One glyph per secondary action, keyed by the shared descriptor so the two
 * clients cannot end up drawing different pictures for the same button.
 */
export const ROUTE_ACTION_ICON: Record<RouteActionKey, ModeIcon> = {
  alongRoute: PinPlusIcon,
  saveTrack: BookmarkIcon,
  exportGpx: DownloadIcon,
  reverse: SwapIcon,
  optimize: SparkleIcon,
  clear: TrashIcon,
  share: ShareIcon,
};

/** Road profiles, keyed by the ids in `ROUTING_PROFILES`. */
export const PROFILE_ICON: Record<RoutingProfile, ModeIcon> = {
  car: CarIcon,
  bike: BicycleIcon,
  foot: WalkIcon,
  hike: HikeIcon,
  run: RunIcon,
};

/** Activity profiles, including the non-routing Explore and Ski modes. */
export const MAP_PROFILE_ICON: Record<string, ModeIcon> = {
  explore: CompassIcon,
  drive: CarIcon,
  bike: BicycleIcon,
  hike: HikeIcon,
  run: RunIcon,
  ski: SkiIcon,
  fishhunt: FishHuntIcon,
  curiosities: CuriositiesIcon,
};

/**
 * Transit modes. `coach` shares the bus glyph deliberately: the wire keeps them
 * apart, but a traveller sees a bus either way.
 */
export const TRANSIT_ICON: Record<TransitMode, ModeIcon> = {
  foot: WalkIcon,
  bicycle: BicycleIcon,
  bike_rental: BicycleIcon,
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
