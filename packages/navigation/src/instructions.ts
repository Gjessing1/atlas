import type { RouteInstruction } from '@atlas/routing';

/** The maneuver fields the banner shortener reads — a full instruction fits. */
export type ShortenableInstruction = Pick<RouteInstruction, 'text'> &
  Partial<Pick<RouteInstruction, 'exitNumber' | 'streetName' | 'exitSign'>>;

/** English ordinal for a roundabout exit count ("2nd", "11th"). */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** Everything after the first sentence is a second cue we render separately. */
function firstSentence(text: string): string {
  const end = text.search(/\.\s+\S/);
  return (end === -1 ? text : text.slice(0, end)).trim().replace(/\.$/, '').trim();
}

/** "onto Drammensveien" / "on E6" — the road the maneuver puts you on. */
function ontoRoad(text: string): string | null {
  const match = /\b(?:onto|on to|on) (.+)$/i.exec(text);
  return match ? (match[1]?.trim() ?? null) : null;
}

/**
 * Compress a router's display instruction into something a driver can read at
 * a glance from behind the wheel.
 *
 * Valhalla writes prose meant to be *spoken* in full ("Enter the roundabout
 * and take the 2nd exit onto Drammensveien."); at 80 km/h the banner has room
 * for a phrase, not a sentence. The parts dropped here are the ones the rest
 * of the banner already carries visually: which way to swing (the turn icon),
 * the exit number and its signed destinations (the exit-sign chip), and the
 * following maneuver (the "Then" row). What survives is the one thing only
 * words can say — the exit to count off, and the road it leads to.
 */
export function shortManeuverText(instruction: ShortenableInstruction): string {
  let text = firstSentence(instruction.text ?? '');
  if (text.length === 0) return '';

  // Side-of-road phrasing: the arrow in the turn panel says it better.
  text = text.replace(/\s+(?:on|to) the (?:right|left)\b/gi, '');
  // The signed destinations live in the exit-sign chip below the instruction;
  // repeating them costs the line that would otherwise show the road name.
  if (instruction.exitSign?.toward?.length) {
    text = text.replace(/\s+toward .+$/i, '');
  }
  text = text.replace(/\s{2,}/g, ' ').trim();

  // Roundabouts: the exit to count is the whole instruction. Rebuilt from the
  // structured exit count rather than trimmed, because Valhalla's wording for
  // the ring ("Enter the roundabout and take…") is pure preamble.
  if (instruction.exitNumber != null && instruction.exitNumber > 0) {
    const road = ontoRoad(text) ?? instruction.streetName ?? null;
    const exit = `${ordinal(instruction.exitNumber)} exit`;
    return road ? `${exit} onto ${road}` : exit;
  }
  // A roundabout without a usable count still loses the preamble.
  text = text.replace(/^Enter the roundabout and take the\s+/i, '');
  text = text.replace(/^Enter the roundabout(?:,|\.)?\s*/i, '');

  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/** The action phrase without the road name, which guidance renders on its own line. */
export function maneuverActionText(instruction: ShortenableInstruction): string {
  const text = shortManeuverText(instruction);
  const road = instruction.streetName?.trim();
  if (!road) return text;
  const escaped = road.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`\\s+(?:onto|on)\\s+${escaped}$`, 'i'), '').trim() || text;
}
