import { describe, expect, it, vi } from 'vitest';

/**
 * The v2 widget's commitment bridge — ROADMAP §6.4 §7.
 *
 * What is worth testing here is not the JSON: it is that this file survives the
 * APK it runs on. A JS bundle reaches a device by OTA, so this code routinely
 * runs against a native module built before it — one with `configure` and none
 * of these functions — and the failure mode that matters is an unhandled
 * rejection on the commute sheet, not a widget that misses an update.
 */
const module_: Record<string, unknown> = {};

vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: () => module_,
}));

const { readCommuteWidgetCommit, setCommuteWidgetCommit } = await import('./commuteWidget.js');

const commit = {
  direction: 'outbound' as const,
  departureMs: 1_756_276_200_000,
  line: '280',
  committedAtMs: 1_756_276_000_000,
};

describe('the widget’s commitment', () => {
  it('hands the store the same shape the widget writes itself', async () => {
    const setCommitV2 = vi.fn().mockResolvedValue(undefined);
    module_.setCommitV2 = setCommitV2;
    await setCommuteWidgetCommit(commit);
    expect(JSON.parse(setCommitV2.mock.calls[0]?.[0] as string)).toEqual(commit);
  });

  it('clears every instance when tracking stops', async () => {
    const setCommitV2 = vi.fn().mockResolvedValue(undefined);
    module_.setCommitV2 = setCommitV2;
    await setCommuteWidgetCommit(null);
    expect(setCommitV2).toHaveBeenCalledWith(null);
  });

  it('reads a commitment made on the home screen', async () => {
    module_.commitV2 = vi.fn().mockResolvedValue(JSON.stringify(commit));
    expect(await readCommuteWidgetCommit()).toMatchObject(commit);
  });

  it('reads nothing rather than something from a store that answers rubbish', async () => {
    module_.commitV2 = vi.fn().mockResolvedValue('{"direction":"outbound"}');
    expect(await readCommuteWidgetCommit()).toBeNull();
    module_.commitV2 = vi.fn().mockResolvedValue('not json');
    expect(await readCommuteWidgetCommit()).toBeNull();
  });

  it('shrugs at an APK older than the bundle driving it', async () => {
    delete module_.setCommitV2;
    delete module_.commitV2;
    await expect(setCommuteWidgetCommit(commit)).resolves.toBeUndefined();
    await expect(readCommuteWidgetCommit()).resolves.toBeNull();
  });
});
