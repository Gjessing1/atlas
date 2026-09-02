import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRoutingRevisionReporter,
  readRoutingRevisions,
  ROUTING_STATUS_ID,
  routingDriftWarning,
} from './routing-revision.js';
import { StatusRegistry } from './status.js';

/**
 * The failure these guard is a deploy that looks perfect: routing up, every
 * route answered, and the container serving off an image three weeks behind the
 * repo. So the tests are about the two ways this check could fail to help —
 * staying silent when the revisions genuinely differ, and crying wolf when it
 * simply cannot tell.
 */

let dataDir = '';
let expectedFile = '';

async function writeExpected(revision: string): Promise<void> {
  // Trailing newline, because the Dockerfile writes this with `>` from a script
  // whose output ends in one.
  await writeFile(expectedFile, `${revision}\n`);
}

async function writeDeployed(body: string): Promise<void> {
  await mkdir(path.join(dataDir, 'valhalla'), { recursive: true });
  await writeFile(path.join(dataDir, 'valhalla', 'deployed.json'), body);
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'atlas-routing-rev-'));
  expectedFile = path.join(dataDir, 'valhalla-revision');
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('routing revision', () => {
  it('reads both stamps from where the two images write them', async () => {
    await writeExpected('abc123abc123');
    await writeDeployed('{"revision":"abc123abc123","startedAt":"2026-09-02T05:24:31Z"}');
    expect(await readRoutingRevisions(dataDir, expectedFile)).toEqual({
      expected: 'abc123abc123',
      deployed: 'abc123abc123',
      startedAt: '2026-09-02T05:24:31Z',
    });
  });

  it('reports drift, naming both builds and the command that fixes it', async () => {
    await writeExpected('9f9f9f9f9f9f');
    await writeDeployed('{"revision":"0a0a0a0a0a0a","startedAt":"2026-08-11T19:02:00Z"}');
    const warning = routingDriftWarning(await readRoutingRevisions(dataDir, expectedFile));
    expect(warning).toContain('0a0a0a0a0a0a');
    expect(warning).toContain('9f9f9f9f9f9f');
    // How long it has been wrong is the part that turns "huh" into "oh".
    expect(warning).toContain('2026-08-11');
    expect(warning).toContain('infrastructure/valhalla');
    // This row is rendered in Settings on both clients, so it names the
    // component and stops — a shell command belongs in CLAUDE.md, not in front
    // of someone trying to plan a route.
    expect(warning).not.toContain('docker ');
    // The registry truncates at 200 characters, and a half sentence is worse
    // than a short one.
    expect(warning!.length).toBeLessThanOrEqual(200);
  });

  it('says nothing when the two agree', async () => {
    await writeExpected('abc123abc123');
    await writeDeployed('{"revision":"abc123abc123"}');
    expect(routingDriftWarning(await readRoutingRevisions(dataDir, expectedFile))).toBeNull();
  });

  it('says nothing when either side is unknown', async () => {
    // No expectation: a dev backend, or a test — this build never had one baked
    // in, so it has no standing to call anything stale.
    await writeDeployed('{"revision":"abc123abc123"}');
    expect(routingDriftWarning(await readRoutingRevisions(dataDir, expectedFile))).toBeNull();

    // No stamp: no routing container on this host, or one from an image built
    // before the stamp existed. "I cannot tell" is not "you are behind".
    await rm(path.join(dataDir, 'valhalla'), { recursive: true });
    await writeExpected('abc123abc123');
    const revisions = await readRoutingRevisions(dataDir, expectedFile);
    expect(revisions.deployed).toBeNull();
    expect(routingDriftWarning(revisions)).toBeNull();
  });

  it('survives a stamp caught mid-write', async () => {
    await writeExpected('abc123abc123');
    await writeDeployed('{"revision":"abc12');
    const revisions = await readRoutingRevisions(dataDir, expectedFile);
    expect(revisions.deployed).toBeNull();
    expect(routingDriftWarning(revisions)).toBeNull();
  });

  it('counts as degraded before anyone has routed', async () => {
    // The state every deploy passes through: the backend has just restarted, no
    // route has been asked for yet, and the drift is knowable anyway because it
    // is read from two files. Reported as `unknown` it would be left out of the
    // status page's own "needs attention" count.
    const status = new StatusRegistry();
    status.register(ROUTING_STATUS_ID, 'Valhalla (routing)', 'Routing');
    await writeExpected('9f9f9f9f9f9f');
    await writeDeployed('{"revision":"0a0a0a0a0a0a"}');
    await createRoutingRevisionReporter(dataDir, { expectedFile })(status);
    expect(status.toStatus().find((s) => s.id === ROUTING_STATUS_ID)!.health).toBe('degraded');
    expect(status.overall()).toBe('degraded');
  });

  it('raises the warning on the routing row, and clears it on rebuild', async () => {
    const status = new StatusRegistry();
    status.register(ROUTING_STATUS_ID, 'Valhalla (routing)', 'Routing');
    // A row with real traffic behind it, so the verdict is the one users see.
    status.record(ROUTING_STATUS_ID, true);
    const report = createRoutingRevisionReporter(dataDir, { expectedFile });

    await writeExpected('9f9f9f9f9f9f');
    await writeDeployed('{"revision":"0a0a0a0a0a0a"}');
    await report(status);
    const drifted = status.toStatus().find((s) => s.id === ROUTING_STATUS_ID)!;
    expect(drifted.warning).toContain('0a0a0a0a0a0a');
    // Answering every request and still not to be trusted is precisely what
    // `degraded` means here.
    expect(drifted.health).toBe('degraded');

    await writeDeployed('{"revision":"9f9f9f9f9f9f"}');
    await report(status);
    const rebuilt = status.toStatus().find((s) => s.id === ROUTING_STATUS_ID)!;
    expect(rebuilt.warning).toBeNull();
    expect(rebuilt.health).toBe('ok');
  });
});
