import type { RouteActionKey, RoutingProfile } from '@atlas/routing';
import type { ReactNode } from 'react';

export interface IconProps {
  className?: string;
  size?: number;
}

type IconComponent = (props: IconProps) => React.ReactElement;

function IconFrame({ children, className, size = 20 }: IconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

export function CarIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 17v-3.2a2 2 0 0 1 1.2-1.8h14.6a2 2 0 0 1 1.2 1.8V17a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-.8H7v.8a1 1 0 0 1-1 1H4.5a1 1 0 0 1-1-1z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="14.5" r="1" fill="currentColor" />
      <circle cx="17" cy="14.5" r="1" fill="currentColor" />
    </IconFrame>
  );
}

export function BicycleIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="5.5" cy="16" r="3.7" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="18.5" cy="16" r="3.7" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M5.5 16l4-6.5h5L18.5 16M9.5 9.5h5.5M12 16l2.5-6.5M15.5 6.2h2.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function WalkIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="13" cy="4.2" r="2" fill="currentColor" />
      <path
        d="M13 8.2l-3 1.8-1.2 3.5M13 8.2l2.4 1.6 1.6 2.6M13 8.2v4.6l2 3.2.8 3.8M13 12.8l-2.6 3-1.2 3.8"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function RunIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="14.8" cy="4.1" r="1.9" fill="currentColor" />
      <path
        d="M13.8 8.1l-3.5 2.2 2.8 2.1 2-1.2 2.6 2.1M13.1 12.4l-3 3.1-3.2 1.1M14.5 12l1 4 3.2 2.1"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function HikeIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M12 2.5l-3.6 5.4h2L7 13.4h2.4L6.4 18.6h11.2L14.6 13.4H17L13.6 7.9h2zM12 18.6v3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function CompassIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="12" r="8.8" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M15.8 8.2l-2.2 5.4-5.4 2.2 2.2-5.4z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </IconFrame>
  );
}

/**
 * The navigation arrow, for starting a destination-free follow. Deliberately
 * the same silhouette as the map puck the button produces — a filled triangle
 * with a notched base — so the control looks like what it turns on.
 */
export function NavArrowIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M12 3 20 20 12 16 4 20Z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function CrosshairIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="12" r="5.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <path
        d="M12 2v3M12 19v3M2 12h3M19 12h3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </IconFrame>
  );
}

export function SkiIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M7 4l8.5 15.2c.7 1.2 2.1 1.8 3.4 1.4M13 3.5L5.8 18.8c-.6 1.3-2 2-3.4 1.7M5 8l3.5 1.7M16 8.5l3-1.8M5 8l-2 9M19 6.7l1.8 10"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function FishHuntIcon(props: IconProps) {
  // A fish hook: eye loop, straight shaft, and a barbed bend — the clearest
  // single glyph for the angling/outdoors profile at the 20 px switch size.
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="4.3" r="1.8" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 6.1V13.5C12 17.5 6.5 17.8 7.2 13M7.2 13l-1.4 1M7.2 13l1.2 1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function CuriositiesIcon(props: IconProps) {
  // A lens with a spark beside it: the Curiosities profile is about looking at
  // ground you are already on and finding something in it. Deliberately not a
  // monument or a rune stone — the profile carries wrecks, caves, mines and
  // springs too, and any single subject glyph would misname the other nine.
  return (
    <IconFrame {...props}>
      <circle cx="10.5" cy="10.5" r="5.8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14.8 14.8l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M18.4 3l.85 1.95 1.95.85-1.95.85L18.4 8.6l-.85-1.95-1.95-.85 1.95-.85z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function TrainIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M6 16.5V7.5C6 5.3 8.7 4 12 4s6 1.3 6 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 16.5zM6 11h12M8.5 18l-2 3M15.5 18l2 3M4.5 21h15"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.2" cy="14.6" r="1.1" fill="currentColor" />
      <circle cx="14.8" cy="14.6" r="1.1" fill="currentColor" />
    </IconFrame>
  );
}

export function StarIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M12 3.2l2.7 5.5 6 .9-4.4 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6-4.4-4.2 6-.9z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function RouteIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M4 6h13m0 0-3-3m3 3-3 3M20 18H7m0 0 3-3m-3 3 3 3"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="12" r="3.7" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M19.1 4.9l-1.6 1.6M6.5 17.5l-1.6 1.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </IconFrame>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M4 6h5M15 6h5M4 12h10M18 12h2M4 18h2M12 18h8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="16" cy="12" r="2.2" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="9" cy="18" r="2.2" stroke="currentColor" strokeWidth="1.7" />
    </IconFrame>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M12 3l8.5 4.5L12 12 3.5 7.5zM4.5 12l7.5 4 7.5-4M4.5 16.5l7.5 4 7.5-4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

/** Two overlapping ridges: the web map's DEM-backed 3D terrain control. */
export function TerrainIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M2.8 19l6.3-10 3.1 4.4 2.5-3.7L21.2 19H2.8z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.8 19l4.1-6.2M12.2 13.4l2.5 3.5 2.1-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

/**
 * Funnel glyph for the layer-filter control: what the layers on the map are
 * narrowed to. A funnel rather than sliders — every one of these filters picks
 * *which* records are drawn, and none of them is a continuous value.
 */
export function FilterIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M4 5.5h16l-6.2 7.3v5.4l-3.6 1.8v-7.2z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

/** Ruler glyph for the measure tool (distance ruler + radius circles). */
export function RulerIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M3.8 14.7l10.9-10.9a1 1 0 0 1 1.4 0l4.1 4.1a1 1 0 0 1 0 1.4L9.3 20.2a1 1 0 0 1-1.4 0l-4.1-4.1a1 1 0 0 1 0-1.4z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M8 10.5l1.8 1.8M11 7.5l2.6 2.6M14 4.5l1.8 1.8"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </IconFrame>
  );
}

/** Folder glyph for collection rows — open when the folder is expanded. */
export function FolderIcon({ open = false, ...props }: IconProps & { open?: boolean }) {
  return (
    <IconFrame {...props}>
      {open ? (
        <path
          d="M3 19V6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.5h6.8A1.5 1.5 0 0 1 19 9v1.5M3 19l2.7-7.2a1.5 1.5 0 0 1 1.4-1h13.3a1 1 0 0 1 .94 1.35L18.9 19z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M3 18.5v-12A1.5 1.5 0 0 1 4.5 5h4.2l2 2.5h8.8A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      )}
    </IconFrame>
  );
}

export function EyeIcon({ off = false, ...props }: IconProps & { off?: boolean }) {
  return (
    <IconFrame {...props}>
      <path
        d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.8" stroke="currentColor" strokeWidth="1.7" />
      {off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </IconFrame>
  );
}

/**
 * "Names on the map": a pin head with a name line under it — the label switch
 * on folder rows and the tag filter. Android draws the same shape.
 */
export function PinLabelIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="7.5" r="3.6" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 11.1v2.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M5 17.5h14M8 21h8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </IconFrame>
  );
}

/*
 * The route planner's toolbar, as glyphs.
 *
 * The panel used to spend two full bands on six same-weight text buttons —
 * "Reverse Optimize Clear Save track Export GPX Share" wrapped over two rows on
 * a phone — for actions nobody opens the planner to perform. Drawn instead,
 * they cost one short row, and Share finally looks like Share does everywhere
 * else. Their names are not lost: every button keeps the descriptor's sentence
 * as its accessible name and its tooltip, and the fold under ⋯ shows the words
 * beside the glyph. Android draws the same paths (apps/android/src/ui/icons.tsx).
 */

/** Sliders: the route's terms, folded behind one button. */
export function SlidersIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M4 7.5h4.5M13 7.5h7M4 16.5h7M15.5 16.5h4.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="10.8" cy="7.5" r="2.3" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="13.3" cy="16.5" r="2.3" stroke="currentColor" strokeWidth="1.7" />
    </IconFrame>
  );
}

/** The overflow: everything the mode's toolbar did not lead with. */
export function MoreIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="5.2" cy="12" r="1.7" fill="currentColor" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="18.8" cy="12" r="1.7" fill="currentColor" />
    </IconFrame>
  );
}

/** A pin with a plus: add somewhere to stop on the way. */
export function PinPlusIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M12 21.2s6.6-6.4 6.6-10.7a6.6 6.6 0 1 0-13.2 0C5.4 14.8 12 21.2 12 21.2z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M12 7.6v5.9M9.05 10.55h5.9"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </IconFrame>
  );
}

/** Bookmark: keep this route as a track. */
export function BookmarkIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M6.5 3.8h11a1 1 0 0 1 1 1v15.6L12 16.8l-6.5 3.6V4.8a1 1 0 0 1 1-1z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

/** Download: the route leaves as a file. */
export function DownloadIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M12 3.8v10.6M7.8 10.6L12 14.8l4.2-4.2"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4.6 17.6v1.6a1 1 0 0 0 1 1h12.8a1 1 0 0 0 1-1v-1.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </IconFrame>
  );
}

/** Two arrows passing: turn the journey around. */
export function SwapIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M7.6 4.6v14.8M4.1 15.9l3.5 3.5 3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.4 19.4V4.6M12.9 8.1l3.5-3.5 3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

/** Sparkles: let the planner choose the order of the stops. */
export function SparkleIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M10 3.8l1.6 4.1 4.1 1.6-4.1 1.6L10 15.2l-1.6-4.1-4.1-1.6 4.1-1.6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M17.2 14.2l.85 2.15 2.15.85-2.15.85-.85 2.15-.85-2.15-2.15-.85 2.15-.85z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

/** Bin: throw the whole plan away. */
export function TrashIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M5.5 6.8h13M9.8 6.8V5.3a1 1 0 0 1 1-1h2.4a1 1 0 0 1 1 1v1.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M7.2 6.8l.75 12.1a1 1 0 0 0 1 .94h6.1a1 1 0 0 0 1-.94l.75-12.1"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 10.2v6.2M13.5 10.2v6.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </IconFrame>
  );
}

/** Share, drawn the way every other app draws it: three nodes and two links. */
export function ShareIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="18" cy="5.4" r="2.6" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="6" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="18" cy="18.6" r="2.6" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M8.35 10.75l7.3-4.05M8.35 13.25l7.3 4.05"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </IconFrame>
  );
}

/** Camera outline for photo discovery actions. */
export function CameraIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M4 8.5h3l1.3-2h7.4l1.3 2h3v10H4z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13.5" r="3.1" stroke="currentColor" strokeWidth="1.7" />
    </IconFrame>
  );
}

/** Edit — the nib and its stroke, so a settings button need not spell itself out. */
export function PencilIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M4.5 19.5l4.2-1 9.4-9.4a1.8 1.8 0 0 0 0-2.6l-.6-.6a1.8 1.8 0 0 0-2.6 0L5.5 15.3l-1 4.2z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M14.2 7.3l2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </IconFrame>
  );
}

/** Done — the same button, once it has been opened. */
export function CheckIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M5.5 12.5l4.2 4.2 8.8-9.4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </IconFrame>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M8 5.5v13l10.5-6.5L8 5.5z" fill="currentColor" />
    </IconFrame>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="6.5" y="5.5" width="4" height="13" rx="1" fill="currentColor" />
      <rect x="13.5" y="5.5" width="4" height="13" rx="1" fill="currentColor" />
    </IconFrame>
  );
}

/**
 * One glyph per secondary action, keyed by the shared descriptor so the two
 * clients cannot end up drawing different pictures for the same button.
 */
export const ROUTE_ACTION_ICON: Record<RouteActionKey, IconComponent> = {
  alongRoute: PinPlusIcon,
  saveTrack: BookmarkIcon,
  exportGpx: DownloadIcon,
  sendGarmin: ShareIcon,
  reverse: SwapIcon,
  optimize: SparkleIcon,
  clear: TrashIcon,
  share: ShareIcon,
};

export const ROUTING_ICON: Record<RoutingProfile, IconComponent> = {
  car: CarIcon,
  bike: BicycleIcon,
  foot: WalkIcon,
  hike: HikeIcon,
  run: RunIcon,
};

const MAP_PROFILE_ICON: Record<string, IconComponent> = {
  explore: CompassIcon,
  drive: CarIcon,
  bike: BicycleIcon,
  hike: HikeIcon,
  run: RunIcon,
  ski: SkiIcon,
  fishhunt: FishHuntIcon,
  curiosities: CuriositiesIcon,
};

export function mapProfileIcon(id: string): IconComponent {
  return MAP_PROFILE_ICON[id] ?? CompassIcon;
}
