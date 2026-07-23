import { roundaboutGlyph, ROUNDABOUT_RING } from '@atlas/navigation';
import type { RouteInstruction } from '@atlas/routing';

/**
 * One maneuver icon: the arrow's stroke path plus a triangular head placed at
 * `tip`, rotated to `angleDeg` (0 = east, like SVG). `ghost` is the road not
 * taken (forks/exits), drawn faint so the choice reads at a glance.
 */
interface ArrowSpec {
  d: string;
  tip: [number, number];
  angleDeg: number;
  ghost?: string;
}

// All right-handed; left variants are mirrored. 24×24 viewBox, stroke-drawn.
const ARROWS: Record<string, ArrowSpec> = {
  straight: { d: 'M12 20 V8', tip: [12, 8], angleDeg: -90 },
  slight: { d: 'M11 20 V14 L15.2 9.8', tip: [15.2, 9.8], angleDeg: -45 },
  turn: { d: 'M8 20 V13 Q8 10 11 10 H15.5', tip: [15.5, 10], angleDeg: 0 },
  sharp: { d: 'M9 20 V11.5 L14.6 15.9', tip: [14.6, 15.9], angleDeg: 38 },
  uturn: { d: 'M8 20 V10 Q8 5.5 12 5.5 Q16 5.5 16 10 V14.5', tip: [16, 14.5], angleDeg: 90 },
  keep: { d: 'M11 20 V15 L14.8 10.4', tip: [14.8, 10.4], angleDeg: -50, ghost: 'M11 15 L7.5 10.5' },
  ramp: {
    d: 'M8.5 20 V14.5 Q8.5 10.8 12 9.6 L15 8.6',
    tip: [15, 8.6],
    angleDeg: -18,
    ghost: 'M8.5 20 V6.5',
  },
  exit: { d: 'M10 20 V14 L14.6 9.4', tip: [14.6, 9.4], angleDeg: -45, ghost: 'M10 20 V6.5' },
  merge: {
    d: 'M8.5 20 Q8.5 14.5 12 12.5 V7.5',
    tip: [12, 7.5],
    angleDeg: -90,
    ghost: 'M15.5 20 Q15.5 14.5 12 12.5',
  },
};

function Arrow({ spec, mirrored }: { spec: ArrowSpec; mirrored: boolean }) {
  const [tx, ty] = spec.tip;
  return (
    <g transform={mirrored ? 'translate(24 0) scale(-1 1)' : undefined}>
      {spec.ghost ? (
        <path d={spec.ghost} fill="none" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      ) : null}
      <path
        d={spec.d}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M-1.2 -3.4 L4.2 0 L-1.2 3.4 Z"
        fill="currentColor"
        transform={`translate(${tx} ${ty}) rotate(${spec.angleDeg})`}
      />
    </g>
  );
}

/** The right-hand ArrowSpec + mirror flag for an instruction's sign/kind. */
function specFor(instruction: Pick<RouteInstruction, 'sign' | 'kind'>): {
  spec: ArrowSpec;
  mirrored: boolean;
} {
  const { sign, kind } = instruction;
  const mirrored = sign < 0;
  if (kind && kind in ARROWS) {
    // A straight-ahead ramp/keep is still drawn as its fork so the decision
    // point reads; merge keeps its own icon at any angle.
    return { spec: ARROWS[kind]!, mirrored };
  }
  const abs = Math.abs(sign);
  if (abs === 8) return { spec: ARROWS.uturn!, mirrored };
  if (abs === 7) return { spec: ARROWS.keep!, mirrored };
  if (abs === 3) return { spec: ARROWS.sharp!, mirrored };
  if (abs === 2) return { spec: ARROWS.turn!, mirrored };
  if (abs === 1) return { spec: ARROWS.slight!, mirrored };
  return { spec: ARROWS.straight!, mirrored: false };
}

/**
 * Proper turn icons for the nav banner (replacing the rotated ↑ glyph):
 * stroke-drawn arrows per maneuver family — turns, keeps, ramps, exits,
 * merges, u-turns — plus the roundabout ring (with exit number) and the
 * arrival flag. Left-hand maneuvers mirror the right-hand artwork.
 */
export function TurnIcon({
  instruction,
  size = 34,
}: {
  instruction: Pick<RouteInstruction, 'sign' | 'kind' | 'exitNumber' | 'exitAngleDeg'>;
  size?: number;
}) {
  const { sign, exitNumber } = instruction;
  if (sign === 6) {
    const ring = roundaboutGlyph(instruction.exitAngleDeg);
    return (
      <span className="nav-turn">
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <circle
            cx={ROUNDABOUT_RING.cx}
            cy={ROUNDABOUT_RING.cy}
            r={ROUNDABOUT_RING.r}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            opacity="0.75"
          />
          <path
            d={ring.entry}
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            opacity="0.75"
          />
          <path d={ring.exit} stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <path
            d="M-1.2 -3.4 L4.2 0 L-1.2 3.4 Z"
            fill="currentColor"
            transform={`translate(${ring.head.x} ${ring.head.y}) rotate(${ring.head.angleDeg})`}
          />
        </svg>
        {exitNumber ? <span className="nav-turn-exit">{exitNumber}</span> : null}
      </span>
    );
  }
  if (sign === 4 || sign === 5) {
    return (
      <span className="nav-turn">
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M8 21 V4 M8 5 H17 L14.2 8.2 L17 11.5 H8"
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (instruction.kind === 'ferry') {
    return (
      <span className="nav-turn">
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M5 13 H19 L17 17.5 H7 Z M9 13 V9.5 H15 V13"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M3.5 20.5 Q5.5 19 7.5 20.5 T11.5 20.5 T15.5 20.5 T19.5 20.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.7"
          />
        </svg>
      </span>
    );
  }
  const { spec, mirrored } = specFor(instruction);
  return (
    <span className="nav-turn">
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <Arrow spec={spec} mirrored={mirrored} />
      </svg>
    </span>
  );
}
