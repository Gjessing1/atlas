import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StatusRegistry } from './status.js';

/**
 * Is the routing service answering on this host the one this repo describes?
 *
 * Every other check we have compares files to files. `compose.test.ts` pins the
 * entrypoint, the coverage list and the admin rules against each other, and it
 * passes just as happily when none of them has been deployed — because a
 * running container keeps serving off whatever image it started from. CI
 * rebuilds and redeploys the backend on every push to main; the Valhalla
 * container is brought up by hand, so a change to `infrastructure/valhalla`
 * ships, passes the gate, deploys, and routing carries on exactly as before.
 * That drift once ran three weeks with nothing to show it: the service was up,
 * every route succeeded, and the answers came from the old graph.
 *
 * So both images carry the same digest of `infrastructure/valhalla`
 * (`revision.sh` there computes it, and is the only place the formula exists):
 * the routing image stamps its own at build time and its entrypoint publishes
 * it into the shared data volume on every start; this image bakes the repo's at
 * *its* build time. Two numbers that disagree mean the deployed router is not
 * this release's.
 *
 * That is the *silent* failure `warning` exists for — the upstream answers, and
 * the answer is not to be trusted — so it lands as a warning on Valhalla's own
 * status row, where both clients already render a warning ahead of everything
 * else. It is deliberately quiet in every other case: an image built before the
 * stamp existed, a host with no Valhalla at all, and a dev or test backend that
 * was never given an expectation all report *nothing*, because "I cannot tell"
 * is not "you are behind", and a status page that cries wolf gets ignored on
 * the day it is right.
 */

/** The status-page row this reports on: Valhalla's own. */
export const ROUTING_STATUS_ID = 'valhalla';

/**
 * Written beside `dist/` by backend/Dockerfile. Absent in dev and in tests,
 * which is the honest "this build has no expectation to compare against".
 */
const EXPECTED_FILE = fileURLToPath(new URL('../valhalla-revision', import.meta.url));

/** Where the routing container publishes its stamp, as this backend sees it. */
export const DEPLOYED_STAMP = path.join('valhalla', 'deployed.json');

export interface RoutingRevisions {
  /** What `infrastructure/valhalla` hashed to when this backend was built. */
  expected: string | null;
  /** What the running routing container stamped into the data volume. */
  deployed: string | null;
  /** When that container last started (ISO 8601), if it said. */
  startedAt: string | null;
}

async function readText(file: string): Promise<string | null> {
  try {
    const text = (await readFile(file, 'utf8')).trim();
    return text === '' ? null : text;
  } catch {
    // Missing is the common case (dev, tests, no routing container here) and
    // unreadable tells us no more than missing does. Neither is drift.
    return null;
  }
}

export async function readRoutingRevisions(
  dataDir: string,
  expectedFile: string = EXPECTED_FILE,
): Promise<RoutingRevisions> {
  const [expected, stamp] = await Promise.all([
    readText(expectedFile),
    readText(path.join(dataDir, DEPLOYED_STAMP)),
  ]);
  let deployed: string | null = null;
  let startedAt: string | null = null;
  if (stamp !== null) {
    try {
      const parsed: unknown = JSON.parse(stamp);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        if (typeof record.revision === 'string') deployed = record.revision;
        if (typeof record.startedAt === 'string') startedAt = record.startedAt;
      }
    } catch {
      // A half-written stamp (the container was starting as we read) says
      // nothing about which build is running. Wait for the next refresh.
    }
  }
  return { expected, deployed, startedAt };
}

/**
 * The sentence for the status row, or null when there is nothing to report.
 *
 * It names both builds and when the running one started, because "how long has
 * this been wrong" is the first thing anyone asks — and stops there. This row
 * is rendered in Settings on both clients, so it says which component is out of
 * step and leaves the command to CLAUDE.md rather than putting a shell
 * invocation in front of someone who is only trying to plan a route.
 *
 * Two revisions cannot say which of them is older, so this fires just as well
 * in the harmless direction: for the hour between rebuilding the container and
 * CI redeploying the backend, the deployed backend is the one behind. It
 * resolves itself, and "these two disagree" was true the whole time.
 */
export function routingDriftWarning(revisions: RoutingRevisions): string | null {
  const { expected, deployed, startedAt } = revisions;
  if (expected === null || deployed === null || expected === deployed) return null;
  const since = startedAt === null ? '' : ` (started ${startedAt.slice(0, 10)})`;
  return (
    `routing container runs build ${deployed}${since}, not this release's ${expected}` +
    ' — infrastructure/valhalla is deployed by hand and needs rebuilding'
  );
}

/**
 * The drift check as the app's local status refresh uses it. Cheap enough to run
 * on every refresh — two small files — and it always writes the current verdict,
 * so the warning clears itself the moment the container is rebuilt.
 *
 * It owns Valhalla's `warning` slot: an active probe for the same row would have
 * to report both, rather than each clearing the other's finding.
 */
export function createRoutingRevisionReporter(
  dataDir: string,
  options: { expectedFile?: string } = {},
): (status: StatusRegistry) => Promise<void> {
  return async (status) => {
    const revisions = await readRoutingRevisions(dataDir, options.expectedFile);
    status.warn(ROUTING_STATUS_ID, routingDriftWarning(revisions));
  };
}
