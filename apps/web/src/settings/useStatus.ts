import type { SystemStatus } from '@atlas/core';
import { useCallback, useEffect, useState } from 'react';

export interface StatusState {
  data: SystemStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetches GET /api/status on mount and on demand. Kept dead simple — the
 * Settings panel is the only caller and it's a manual, low-frequency view.
 */
export function useStatus(enabled: boolean): StatusState {
  const [data, setData] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/status')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as SystemStatus;
      })
      .then((json) => setData(json))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'unreachable'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  return { data, loading, error, refresh };
}
