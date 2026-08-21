import type { SideInsets } from '../ui/insets';

/** Shared geometry for every piece of Android's active-navigation UI. */
export interface NavViewport {
  landscape: boolean;
  /** Leading edge and width of the guidance rail/card. */
  guidanceLeft: number;
  guidanceWidth: number;
  /** Uncovered map pane used for the route, puck, road chip and re-centre control. */
  mapLeft: number;
  mapRight: number;
  /** MapLibre camera padding and its resulting on-screen target positions. */
  coursePadding: { top: number; right: number; bottom: number; left: number };
  flatPadding: { top: number; right: number; bottom: number; left: number };
  overviewPadding: { top: number; right: number; bottom: number; left: number };
  courseAnchor: { x: number; y: number };
  flatAnchor: { x: number; y: number };
}

const EDGE_GAP = 12;
const RAIL_GAP = 12;

/**
 * Lay active navigation out around an unobstructed map viewport.
 *
 * Portrait keeps the guidance card full-width and the route centred. In
 * landscape the guidance becomes a leading-side rail and the camera target is
 * centred in the remaining (right in LTR) map pane. Moving only the drawn
 * chevron would make it lie about the camera's actual centre and leave the
 * road running underneath the guidance card.
 */
export function navViewport(
  width: number,
  height: number,
  side: SideInsets,
  topInset: number,
  bottomInset: number,
  compact = false,
): NavViewport {
  // A picture-in-picture window is never a landscape *screen*, whichever way
  // round it happens to be: there is no room beside the map for a guidance
  // rail, so splitting the window in two would leave the camera pointing at the
  // wrong half of a very small map. Atlas now asks for a portrait window, but a
  // pinch can still make one wider than it is tall.
  const landscape = !compact && width > height;
  const guidanceLeft = side.left + EDGE_GAP;
  const guidanceWidth = landscape
    ? Math.min(360, Math.round(width * 0.42))
    : Math.max(0, width - guidanceLeft - side.right - EDGE_GAP);
  const mapLeft = landscape ? guidanceLeft + guidanceWidth + RAIL_GAP : side.left;
  const mapRight = width - side.right;

  // Camera padding moves MapLibre's target to the centre of the usable pane.
  // Course-up additionally puts it low enough for a long view of the road
  // ahead: a little higher in landscape because that screen is much shorter.
  const rightPadding = side.right;
  const leftPadding = landscape ? mapLeft : side.left;
  // Full-screen, guidance covers a small enough share of the phone that 72% of
  // the *window* is still well above it. A mini window is not like that: its
  // strip is nearer 40% of a 147 dp-tall window, so the same fraction puts the
  // puck behind the very strip whose height was passed in to clear it. Compact
  // therefore measures the fraction over the map that is actually uncovered.
  const targetY = compact
    ? topInset + (height - bottomInset - topInset) * 0.72
    : height * (landscape ? 0.68 : 0.72);
  const courseTop = Math.max(topInset, Math.round(2 * targetY - height + bottomInset));
  const coursePadding = {
    top: courseTop,
    right: rightPadding,
    bottom: bottomInset,
    left: leftPadding,
  };
  const flatPadding = {
    top: topInset,
    right: rightPadding,
    bottom: bottomInset,
    left: leftPadding,
  };
  const anchorX = (leftPadding + width - rightPadding) / 2;

  return {
    landscape,
    guidanceLeft,
    guidanceWidth,
    mapLeft,
    mapRight,
    coursePadding,
    flatPadding,
    // Overview breathing room is in screen dp, so the full-screen margins would
    // be most of a mini window (60 + 40 of 110 dp wide). A window entered while
    // the map was in overview still has to show the route.
    overviewPadding: {
      top: topInset + (compact ? 12 : 40),
      right: rightPadding + (compact ? 12 : 40),
      bottom: bottomInset + (compact ? 12 : 40),
      left: landscape ? mapLeft + 28 : side.left + (compact ? 12 : 60),
    },
    courseAnchor: {
      x: anchorX,
      y: (courseTop + height - bottomInset) / 2,
    },
    flatAnchor: {
      x: anchorX,
      y: (topInset + height - bottomInset) / 2,
    },
  };
}
