#!/usr/bin/env node
// Decide whether the national NVDB SQLite needs rebuilding from NVDB API v4's
// change feeds. This is deliberately a cheap read-only probe: the 800+ MB
// rebuild only runs after enough source churn, or when the maximum dataset age
// is reached.

import { pathToFileURL } from 'node:url';

const API_BASE = 'https://nvdbapiles.atlas.vegvesen.no';
const CHANGE_KEYS = [
  'vegobjektVersjonerOpprettet',
  'vegobjektVersjonerEndret',
  'vegobjektVersjonerFjernet',
  'vegobjektVersjonerSegmentert',
];
const TYPE_IDS = [162, 823, 105, 616]; // cameras first: one material change is urgent

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const DEFAULT_THRESHOLDS = Object.freeze({
  content: positiveInt(process.env.NVDB_CONTENT_CHANGE_THRESHOLD, 500),
  segmentation: positiveInt(process.env.NVDB_SEGMENT_CHANGE_THRESHOLD, 25_000),
  maxAgeDays: positiveInt(process.env.NVDB_MAX_AGE_DAYS, 14),
});

export function countPage(json) {
  const counts = Object.fromEntries(
    CHANGE_KEYS.map((key) => [key, Array.isArray(json?.[key]) ? json[key].length : 0]),
  );
  return {
    content: counts[CHANGE_KEYS[0]] + counts[CHANGE_KEYS[1]] + counts[CHANGE_KEYS[2]],
    segmentation: counts[CHANGE_KEYS[3]],
  };
}

export function decideRefresh({ since, now, byType, thresholds = DEFAULT_THRESHOLDS }) {
  const sinceMs = Date.parse(since);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(nowMs) || sinceMs > nowMs) {
    throw new Error(`invalid refresh window: ${since} → ${now}`);
  }

  const contentChanges = byType.reduce((sum, row) => sum + row.content, 0);
  const segmentationChanges = byType.reduce((sum, row) => sum + row.segmentation, 0);
  const cameraContentChanges = byType
    .filter((row) => row.type === 162 || row.type === 823)
    .reduce((sum, row) => sum + row.content, 0);
  const ageDays = (nowMs - sinceMs) / 86_400_000;

  let reason = null;
  if (cameraContentChanges > 0) reason = 'camera data changed';
  else if (contentChanges >= thresholds.content)
    reason = `content-change threshold reached (${contentChanges} >= ${thresholds.content})`;
  else if (segmentationChanges >= thresholds.segmentation)
    reason =
      `road-network resegmentation threshold reached ` +
      `(${segmentationChanges} >= ${thresholds.segmentation})`;
  else if (ageDays >= thresholds.maxAgeDays)
    reason = `maximum age reached (${ageDays.toFixed(1)} >= ${thresholds.maxAgeDays} days)`;

  return {
    rebuild: reason !== null,
    reason,
    since,
    checkedAt: now,
    ageDays: Number(ageDays.toFixed(2)),
    contentChanges,
    segmentationChanges,
    cameraContentChanges,
    thresholds,
    byType,
  };
}

export async function readChanges(type, since, { fetchImpl = fetch, stopWhen } = {}) {
  let start = since;
  let content = 0;
  let segmentation = 0;
  let pages = 0;
  let truncated = false;
  const cursors = new Set();

  for (;;) {
    const url = new URL(`${API_BASE}/vegobjekter/api/v4/vegobjekter/${type}/endringer`);
    url.searchParams.set('start', start);
    url.searchParams.set('antall', '1000');
    const response = await fetchImpl(url, {
      headers: { 'X-Client': 'atlas-refresh-monitor', Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`NVDB change feed ${type}: HTTP ${response.status}`);
    const json = await response.json();
    const page = countPage(json);
    content += page.content;
    segmentation += page.segmentation;
    pages++;

    if (stopWhen?.({ type, content, segmentation })) {
      truncated = true;
      break;
    }
    const next = json?.metadata?.neste?.start;
    // API v4 may return a synthetic `...,null,null` cursor on an empty final
    // page. The event count, not merely the presence of `neste`, is the end.
    if (page.content + page.segmentation === 0 || !next || next === start || cursors.has(next)) {
      break;
    }
    if (pages >= 500) throw new Error(`NVDB change feed ${type}: pagination exceeded 500 pages`);
    cursors.add(start);
    start = next;
  }

  return { type, content, segmentation, pages, truncated };
}

export async function checkRefresh(since, options = {}) {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const byType = [];
  let totalContent = 0;
  let totalSegmentation = 0;
  for (const type of TYPE_IDS) {
    const row = await readChanges(type, since, {
      fetchImpl: options.fetchImpl,
      stopWhen: ({ type: rowType, content, segmentation }) =>
        ((rowType === 162 || rowType === 823) && content > 0) ||
        totalContent + content >= thresholds.content ||
        totalSegmentation + segmentation >= thresholds.segmentation,
    });
    byType.push(row);
    totalContent += row.content;
    totalSegmentation += row.segmentation;
    if (
      ((type === 162 || type === 823) && row.content > 0) ||
      totalContent >= thresholds.content ||
      totalSegmentation >= thresholds.segmentation
    ) {
      break;
    }
  }
  return decideRefresh({
    since,
    now: options.now ?? new Date().toISOString(),
    byType,
    thresholds,
  });
}

async function main() {
  const sinceAt = process.argv.indexOf('--since');
  const since = sinceAt >= 0 ? process.argv[sinceAt + 1] : null;
  if (!since) throw new Error('usage: refresh-check.mjs --since <ISO timestamp>');
  console.log(JSON.stringify(await checkRefresh(since), null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
