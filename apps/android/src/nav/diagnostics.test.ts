import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getInfoAsync: vi.fn(),
  readAsStringAsync: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  getInfoAsync: h.getInfoAsync,
  readAsStringAsync: h.readAsStringAsync,
  writeAsStringAsync: vi.fn(),
  deleteAsync: vi.fn(),
}));
vi.mock('expo-sharing', () => ({ isAvailableAsync: vi.fn(), shareAsync: vi.fn() }));
vi.mock('../serverOrigin', () => ({ getServerOrigin: () => 'https://atlas.example' }));

import { uploadNavigationDiagnostics } from './diagnostics';

describe('uploadNavigationDiagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', h.fetch);
    h.getInfoAsync.mockResolvedValue({ exists: true, size: 42 });
    h.readAsStringAsync.mockResolvedValue('{"event":"gps-stream"}\n');
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify({ reference: 'ABCDE-12345' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('uploads the private log only when explicitly called and returns its reference', async () => {
    await expect(uploadNavigationDiagnostics()).resolves.toBe('ABCDE-12345');
    expect(h.fetch).toHaveBeenCalledWith(
      'https://atlas.example/api/diagnostics/navigation',
      expect.objectContaining({
        method: 'POST',
        body: '{"event":"gps-stream"}\n',
      }),
    );
  });

  it('surfaces the server error instead of claiming the log was uploaded', async () => {
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'upload disabled' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(uploadNavigationDiagnostics()).rejects.toThrow('upload disabled');
  });
});
