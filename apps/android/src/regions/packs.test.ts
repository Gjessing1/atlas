import { createHash, randomBytes } from 'node:crypto';

import type { RegionPackManifest } from '@atlas/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * In-memory stand-in for expo-file-system/legacy + react-native-zip-archive,
 * shared with the module mocks below (hoisted so the factories can see it). It
 * models files as byte buffers and directories as a set, with recursive
 * delete/move so the staging → swap → rollback dance can be exercised.
 */
const h = vi.hoisted(() => {
  const DOC = 'file:///doc/';
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();
  const strip = (uri: string) => uri.replace(/\/+$/, '');
  const toUri = (p: string) => (p.startsWith('file://') ? p : `file://${p}`);
  const registerParents = (norm: string) => {
    let idx = norm.lastIndexOf('/');
    while (idx > 'file://'.length) {
      dirs.add(norm.slice(0, idx));
      idx = norm.lastIndexOf('/', idx - 1);
    }
  };

  // Per-test scripting.
  const download = { behavior: new Map<string, string>() };
  const unzip = { behavior: 'ok' as 'ok' | 'throw' };
  const moveHook = { fn: null as null | ((from: string, to: string) => void) };

  const memfs = {
    reset() {
      files.clear();
      dirs.clear();
      download.behavior.clear();
      unzip.behavior = 'ok';
      moveHook.fn = null;
    },
    writeBytes(uri: string, bytes: Uint8Array) {
      const norm = strip(uri);
      files.set(norm, bytes);
      registerParents(norm);
    },
    has(uri: string) {
      const norm = strip(uri);
      return files.has(norm) || dirs.has(norm);
    },
    dump: () => [...files.keys(), ...dirs].sort(),
  };

  const FileSystem = {
    documentDirectory: DOC,
    EncodingType: { Base64: 'base64', UTF8: 'utf8' },
    async getInfoAsync(uri: string) {
      const norm = strip(uri);
      if (files.has(norm)) {
        return { exists: true, isDirectory: false, size: files.get(norm)!.length, uri };
      }
      if (dirs.has(norm)) return { exists: true, isDirectory: true, uri };
      return { exists: false, uri };
    },
    async readDirectoryAsync(uri: string) {
      const norm = strip(uri);
      if (!dirs.has(norm)) throw new Error(`ENOENT: ${uri}`);
      const prefix = `${norm}/`;
      const children = new Set<string>();
      for (const key of [...files.keys(), ...dirs]) {
        if (key.startsWith(prefix)) children.add(key.slice(prefix.length).split('/')[0]);
      }
      return [...children];
    },
    async makeDirectoryAsync(uri: string) {
      const norm = strip(uri);
      dirs.add(norm);
      registerParents(norm);
    },
    async writeAsStringAsync(uri: string, content: string) {
      memfs.writeBytes(uri, new Uint8Array(Buffer.from(content, 'utf8')));
    },
    async readAsStringAsync(
      uri: string,
      opts?: { encoding?: string; position?: number; length?: number },
    ) {
      const bytes = files.get(strip(uri));
      if (!bytes) throw new Error(`ENOENT: ${uri}`);
      if (opts?.encoding === 'base64' && opts.position != null) {
        const slice = bytes.subarray(opts.position, opts.position + (opts.length ?? bytes.length));
        return Buffer.from(slice).toString('base64');
      }
      return Buffer.from(bytes).toString('utf8');
    },
    async deleteAsync(uri: string, options?: { idempotent?: boolean }) {
      const norm = strip(uri);
      const prefix = `${norm}/`;
      let existed = files.delete(norm) || dirs.delete(norm);
      for (const key of [...files.keys(), ...dirs]) {
        if (key.startsWith(prefix)) {
          files.delete(key);
          dirs.delete(key);
          existed = true;
        }
      }
      if (!existed && !options?.idempotent) throw new Error(`ENOENT: ${uri}`);
    },
    async moveAsync({ from, to }: { from: string; to: string }) {
      const src = strip(from);
      const dst = strip(to);
      const prefix = `${src}/`;
      const moving = [...files.keys(), ...dirs].filter((k) => k === src || k.startsWith(prefix));
      if (moving.length === 0) throw new Error(`ENOENT: ${from}`);
      moveHook.fn?.(src, dst); // may throw to simulate ENOSPC before any mutation
      for (const key of moving) {
        const target = dst + key.slice(src.length);
        if (files.has(key)) {
          files.set(target, files.get(key)!);
          files.delete(key);
        } else {
          dirs.add(target);
          dirs.delete(key);
        }
      }
      registerParents(dst);
    },
    createDownloadResumable(
      url: string,
      target: string,
      _opts: unknown,
      onProgress?: (p: { totalBytesWritten: number }) => void,
    ) {
      const run = async () => {
        const base = target.split('/').pop()!;
        const behavior = download.behavior.get(base) ?? 'ok';
        if (behavior === 'throw') throw new Error('network down');
        if (behavior === 'badstatus') return { status: 500 };
        const truth = h.content.get(base);
        if (!truth) throw new Error(`no test content for ${base}`);
        let bytes = truth;
        if (behavior === 'shrink') bytes = truth.subarray(0, truth.length - 1);
        if (behavior === 'corrupt') {
          bytes = Uint8Array.from(truth);
          bytes[0] ^= 0xff;
        }
        memfs.writeBytes(target, bytes);
        onProgress?.({ totalBytesWritten: bytes.length });
        return { status: 200 };
      };
      return { downloadAsync: run, resumeAsync: run };
    },
  };

  const unzipFn = async (_src: string, dest: string) => {
    if (unzip.behavior === 'throw') throw new Error('unzip failed');
    const dir = toUri(dest);
    dirs.add(strip(dir));
    memfs.writeBytes(`${dir}/fonts/glyph.pbf`, new Uint8Array([1, 2, 3]));
  };

  return {
    memfs,
    FileSystem,
    unzipFn,
    download,
    unzip,
    moveHook,
    content: new Map<string, Uint8Array>(),
  };
});

vi.mock('expo-file-system/legacy', () => h.FileSystem);
vi.mock('react-native-zip-archive', () => ({ unzip: h.unzipFn }));
vi.mock('../serverOrigin', () => ({ getServerOrigin: () => 'http://test' }));
// No native digest off-device, which is also the fallback these tests cover.
vi.mock('../../modules/packdownload', () => ({ nativeSha256: async () => null }));

import { base64ToBytes, createSha256 } from './sha256';
import {
  deletePack,
  downloadPack,
  listLocalPacks,
  packDir,
  pendingPackFiles,
  pendingStagingPacks,
  prepareStaging,
  stagingDir,
  validatePackManifest,
} from './packs';

/** Build a manifest whose file digests match freshly generated random content. */
function makeManifest(
  id = 'oslo',
  version = 2,
  sizes: Record<string, number> = {
    'basemap.pmtiles': 300,
    'search.sqlite': 120,
    'valhalla.tar': 200,
    'assets.zip': 80,
  },
): RegionPackManifest {
  const file = (path: string) => {
    const bytes = new Uint8Array(randomBytes(sizes[path]));
    h.content.set(path, bytes);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  return {
    id,
    name: 'Oslo',
    bbox: { sw: { lat: 59, lng: 10 }, ne: { lat: 60, lng: 11 } },
    version,
    builtAt: 1000,
    files: {
      basemap: file('basemap.pmtiles'),
      search: file('search.sqlite'),
      routing: file('valhalla.tar'),
      assets: file('assets.zip'),
    },
  };
}

/** Seed a complete previous-generation pack directly into the live dir. */
function seedLivePack(id = 'oslo') {
  h.memfs.writeBytes(`${packDir(id)}/basemap.pmtiles`, new Uint8Array([9, 9, 9]));
  h.memfs.writeBytes(`${packDir(id)}/pack.json`, new Uint8Array(Buffer.from('{"version":1}')));
}

beforeEach(() => {
  h.memfs.reset();
  h.content.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('createSha256 / base64ToBytes', () => {
  it('matches node crypto across block boundaries', () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 200, 1000]) {
      const data = new Uint8Array(randomBytes(len));
      const hasher = createSha256();
      hasher.update(data);
      expect(hasher.hex()).toBe(createHash('sha256').update(data).digest('hex'));
    }
  });

  it('hashes identically whether fed in one or many chunks', () => {
    const data = new Uint8Array(randomBytes(5000));
    const whole = createSha256();
    whole.update(data);
    const chunked = createSha256();
    for (let i = 0; i < data.length; i += 97) chunked.update(data.subarray(i, i + 97));
    const expected = createHash('sha256').update(data).digest('hex');
    expect(whole.hex()).toBe(expected);
    expect(chunked.hex()).toBe(expected);
  });

  it('round-trips base64 (with and without padding)', () => {
    for (const len of [0, 1, 2, 3, 300]) {
      const data = new Uint8Array(randomBytes(len));
      const b64 = Buffer.from(data).toString('base64');
      expect([...base64ToBytes(b64)]).toEqual([...data]);
    }
  });
});

describe('validatePackManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(() => validatePackManifest(makeManifest())).not.toThrow();
  });

  it('rejects a traversing id or path', () => {
    const bad = makeManifest();
    expect(() => validatePackManifest({ ...bad, id: '../evil' })).toThrow(/unsafe pack id/);
    const badPath = makeManifest();
    badPath.files.basemap!.path = '../../etc/passwd';
    expect(() => validatePackManifest(badPath)).toThrow(/unsafe path/);
    const absolute = makeManifest();
    absolute.files.search!.path = '/etc/shadow';
    expect(() => validatePackManifest(absolute)).toThrow(/unsafe path/);
  });

  it('rejects a negative byte count', () => {
    const bad = makeManifest();
    bad.files.routing!.bytes = -1;
    expect(() => validatePackManifest(bad)).toThrow(/invalid byte count/);
  });
});

describe('downloadPack', () => {
  it('installs a fresh pack and reports full progress', async () => {
    const manifest = makeManifest();
    const progress: number[] = [];
    const pack = await downloadPack(manifest, (f) => progress.push(f));

    expect(pack.dir).toBe(packDir('oslo'));
    expect(h.memfs.has(`${packDir('oslo')}/pack.json`)).toBe(true);
    expect(h.memfs.has(`${packDir('oslo')}/basemap.pmtiles`)).toBe(true);
    expect(h.memfs.has(`${packDir('oslo')}/valhalla.tar`)).toBe(true);
    // assets.zip is unpacked and the archive removed.
    expect(h.memfs.has(`${packDir('oslo')}/assets/fonts/glyph.pbf`)).toBe(true);
    expect(h.memfs.has(`${packDir('oslo')}/assets.zip`)).toBe(false);
    // No staging or backup left behind; the pack lists cleanly.
    expect(h.memfs.has(`${packDir('oslo')}.staging`)).toBe(false);
    expect(h.memfs.has(`${packDir('oslo')}.old`)).toBe(false);
    expect((await listLocalPacks()).map((p) => p.manifest.id)).toEqual(['oslo']);
    expect(progress.at(-1)).toBe(1);
  });

  it('crosses the hash chunk boundary correctly (large basemap)', async () => {
    const manifest = makeManifest('big', 2, {
      'basemap.pmtiles': 3 * 262_144 + 1000, // > one HASH_CHUNK_BYTES
      'search.sqlite': 10,
      'valhalla.tar': 10,
      'assets.zip': 10,
    });
    await expect(downloadPack(manifest, () => {})).resolves.toBeDefined();
    expect(h.memfs.has(`${packDir('big')}/basemap.pmtiles`)).toBe(true);
  });

  it('rejects a same-size but corrupt file and keeps the previous pack', async () => {
    seedLivePack();
    const manifest = makeManifest();
    h.download.behavior.set('valhalla.tar', 'corrupt');

    await expect(downloadPack(manifest, () => {})).rejects.toThrow(/checksum mismatch/);
    // Old pack untouched, new one not installed.
    expect(await readJson(`${packDir('oslo')}/pack.json`)).toEqual({ version: 1 });
    // The corrupt artifact was discarded from staging.
    expect(h.memfs.has(`${packDir('oslo')}.staging/valhalla.tar`)).toBe(false);
  });

  it('survives an interrupted download and resumes to completion', async () => {
    seedLivePack();
    const manifest = makeManifest();
    h.download.behavior.set('valhalla.tar', 'throw');

    await expect(downloadPack(manifest, () => {})).rejects.toThrow(/network down/);
    // Previous pack still serves offline maps.
    expect(await readJson(`${packDir('oslo')}/pack.json`)).toEqual({ version: 1 });
    // Finished files are retained in staging for the retry.
    expect(h.memfs.has(`${packDir('oslo')}.staging/basemap.pmtiles`)).toBe(true);

    // Retry with the network restored.
    h.download.behavior.clear();
    await downloadPack(manifest, () => {});
    expect((await readJson(`${packDir('oslo')}/pack.json`)).version).toBe(2);
    expect(h.memfs.has(`${packDir('oslo')}.staging`)).toBe(false);
  });

  it('leaves no phantom pack when the very first install fails', async () => {
    const manifest = makeManifest();
    h.download.behavior.set('search.sqlite', 'badstatus');

    await expect(downloadPack(manifest, () => {})).rejects.toThrow();
    expect(await listLocalPacks()).toEqual([]);
  });

  it('fails cleanly on a broken unzip and keeps the previous pack', async () => {
    seedLivePack();
    h.unzip.behavior = 'throw';

    await expect(downloadPack(makeManifest(), () => {})).rejects.toThrow(/unzip failed/);
    expect(await readJson(`${packDir('oslo')}/pack.json`)).toEqual({ version: 1 });
  });

  it('rolls back to the previous pack when the final swap fails (no space)', async () => {
    seedLivePack();
    // Fail only the staging → live move; the live → backup move must succeed.
    h.moveHook.fn = (from) => {
      if (from.endsWith('.staging')) throw new Error('ENOSPC: no space left');
    };

    await expect(downloadPack(makeManifest(), () => {})).rejects.toThrow(/ENOSPC/);
    // The known-good pack was restored, not lost between the two moves.
    expect(await readJson(`${packDir('oslo')}/pack.json`)).toEqual({ version: 1 });
    expect(h.memfs.has(`${packDir('oslo')}.old`)).toBe(false);
  });

  it('discards a stale staging dir from a different version', async () => {
    // Leftover staging from an interrupted v1 build.
    h.memfs.writeBytes(`${packDir('oslo')}.staging/.staging.json`, jsonBytes({ version: 1 }));
    h.memfs.writeBytes(`${packDir('oslo')}.staging/orphan.tmp`, new Uint8Array([7]));

    await downloadPack(makeManifest('oslo', 2), () => {});
    // The v2 install must not have inherited the v1 orphan.
    expect(h.memfs.has(`${packDir('oslo')}/orphan.tmp`)).toBe(false);
  });
});

describe('resuming an interrupted download', () => {
  it('records the manifest in staging so a later run can finish the install', async () => {
    const manifest = makeManifest('oslo', 4);
    await prepareStaging(stagingDir('oslo'), manifest);

    expect(await pendingStagingPacks()).toEqual([manifest]);
  });

  it('ignores a staging dir with no recorded manifest, and installed packs', async () => {
    h.memfs.writeBytes(`${stagingDir('bergen')}/.staging.json`, jsonBytes({ version: 1 }));
    seedLivePack('trondheim');

    expect(await pendingStagingPacks()).toEqual([]);
  });

  it('asks only for the files still missing, skipping finished and unpacked ones', async () => {
    const manifest = makeManifest();
    const staging = stagingDir('oslo');
    await prepareStaging(staging, manifest);
    // basemap already complete, search half-written, assets already unpacked.
    h.memfs.writeBytes(`${staging}/basemap.pmtiles`, h.content.get('basemap.pmtiles')!);
    h.memfs.writeBytes(`${staging}/search.sqlite`, new Uint8Array(60));
    h.memfs.writeBytes(`${staging}/assets/.unzip-complete`, new Uint8Array(0));

    expect(await pendingPackFiles(manifest)).toEqual([
      { url: 'http://test/packs/oslo/search.sqlite', path: 'search.sqlite', bytes: 120 },
      { url: 'http://test/packs/oslo/valhalla.tar', path: 'valhalla.tar', bytes: 200 },
    ]);
  });

  it('finishes a pack whose files a background download already fetched', async () => {
    const manifest = makeManifest();
    const staging = stagingDir('oslo');
    await prepareStaging(staging, manifest);
    for (const name of ['basemap.pmtiles', 'search.sqlite', 'valhalla.tar', 'assets.zip']) {
      h.memfs.writeBytes(`${staging}/${name}`, h.content.get(name)!);
    }
    expect(await pendingPackFiles(manifest)).toEqual([]);

    // Nothing left to fetch: downloadPack only verifies, unpacks and swaps.
    h.download.behavior.set('basemap.pmtiles', 'throw');
    const pack = await downloadPack(manifest, () => {});

    expect(pack.dir).toBe(packDir('oslo'));
    expect(h.memfs.has(`${packDir('oslo')}/assets/fonts/glyph.pbf`)).toBe(true);
    expect(await readJson(`${packDir('oslo')}/pack.json`)).toEqual(manifest);
  });
});

describe('recovery and cleanup', () => {
  it('restores an orphaned backup left by a crash mid-swap', async () => {
    // A crash between "move live → backup" and "move staging → live".
    h.memfs.writeBytes(`${packDir('oslo')}.old/pack.json`, jsonBytes({ version: 1 }));

    const packs = await listLocalPacks();
    expect(packs.map((p) => p.dir)).toEqual([packDir('oslo')]);
    expect(h.memfs.has(`${packDir('oslo')}.old`)).toBe(false);
    expect(h.memfs.has(`${packDir('oslo')}/pack.json`)).toBe(true);
  });

  it('drops a stale backup when the live pack already exists', async () => {
    seedLivePack();
    h.memfs.writeBytes(`${packDir('oslo')}.old/pack.json`, jsonBytes({ version: 0 }));

    await listLocalPacks();
    expect(h.memfs.has(`${packDir('oslo')}.old`)).toBe(false);
    expect(await readJson(`${packDir('oslo')}/pack.json`)).toEqual({ version: 1 });
  });

  it('does not list staging or backup directories as packs', async () => {
    h.memfs.writeBytes(`${packDir('oslo')}/pack.json`, jsonBytes({ version: 2 }));
    h.memfs.writeBytes(`${packDir('oslo')}.staging/pack.json`, jsonBytes({ version: 3 }));

    expect((await listLocalPacks()).map((p) => p.dir)).toEqual([packDir('oslo')]);
  });

  it('deletePack removes the pack, its staging and its backup', async () => {
    seedLivePack();
    h.memfs.writeBytes(`${packDir('oslo')}.staging/x`, new Uint8Array([1]));
    h.memfs.writeBytes(`${packDir('oslo')}.old/x`, new Uint8Array([1]));

    await deletePack('oslo');
    expect(h.memfs.has(packDir('oslo'))).toBe(false);
    expect(h.memfs.has(`${packDir('oslo')}.staging`)).toBe(false);
    expect(h.memfs.has(`${packDir('oslo')}.old`)).toBe(false);
  });
});

function jsonBytes(value: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(value), 'utf8'));
}

async function readJson(uri: string): Promise<{ version: number }> {
  return JSON.parse((await h.FileSystem.readAsStringAsync(uri)) as string);
}
