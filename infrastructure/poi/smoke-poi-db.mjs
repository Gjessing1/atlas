#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [file, reportFile] = process.argv.slice(2);
if (!file || !reportFile) {
  console.error('usage: smoke-poi-db.mjs <candidate.sqlite> <report.json>');
  process.exit(2);
}

const db = new DatabaseSync(file, { readOnly: true });
try {
  const integrity = db.prepare('PRAGMA quick_check').get();
  if (integrity?.quick_check !== 'ok')
    throw new Error(`SQLite quick_check: ${integrity?.quick_check}`);
  const meta = new Map(
    db
      .prepare('SELECT name, value FROM metadata')
      .all()
      .map((row) => [row.name, row.value]),
  );
  if (meta.get('format_version') !== '1') throw new Error('wrong or missing format_version');
  const features = Number(meta.get('feature_count'));
  const pois = Number(db.prepare('SELECT count(*) AS n FROM pois').get().n);
  const rtree = Number(db.prepare('SELECT count(*) AS n FROM poi_rtree').get().n);
  if (!features || features !== pois || pois !== rtree) {
    throw new Error(`row mismatch: metadata=${features}, pois=${pois}, rtree=${rtree}`);
  }

  const oslo = [10.45, 59.75, 11.1, 60.15];
  const rawCount = (key, value) =>
    Number(
      db
        .prepare(
          `SELECT count(*) AS n FROM poi_rtree r JOIN pois p ON p.id = r.id
           WHERE r.max_lng >= ? AND r.min_lng <= ? AND r.max_lat >= ? AND r.min_lat <= ?
             AND json_extract(p.tags, ?) ${value === undefined ? 'IS NOT NULL' : '= ?'}`,
        )
        .get(
          oslo[0],
          oslo[2],
          oslo[1],
          oslo[3],
          `$.${key}`,
          ...(value === undefined ? [] : [value]),
        ).n,
    );
  const audits = {
    pharmacies: { count: rawCount('amenity', 'pharmacy'), expected: 125, tolerance: [45, 260] },
    restaurants: {
      count: rawCount('amenity', 'restaurant'),
      expected: 750,
      tolerance: [250, 1800],
    },
    shops: { count: rawCount('shop'), expected: 2882, tolerance: [900, 7000] },
    historic: { count: rawCount('historic'), expected: 1547, tolerance: [250, 5000] },
  };
  for (const [name, audit] of Object.entries(audits)) {
    if (audit.count < audit.tolerance[0] || audit.count > audit.tolerance[1]) {
      throw new Error(
        `Oslo ${name}: ${audit.count}, outside ${audit.tolerance.join('–')} (2026-09-19 audit ${audit.expected})`,
      );
    }
  }

  const cityCount = (name, [west, south, east, north]) => {
    const count = Number(
      db
        .prepare(
          `SELECT count(*) AS n FROM poi_rtree
           WHERE max_lng >= ? AND min_lng <= ? AND max_lat >= ? AND min_lat <= ?`,
        )
        .get(west, east, south, north).n,
    );
    if (count < 100) throw new Error(`${name}: only ${count} places`);
    return count;
  };
  const cities = {
    London: cityCount('London', [-0.25, 51.45, 0.05, 51.58]),
    Paris: cityCount('Paris', [2.22, 48.79, 2.46, 48.92]),
    Berlin: cityCount('Berlin', [13.25, 52.43, 13.55, 52.6]),
  };

  // Evict this candidate only (never the host's global page cache), then time
  // the same R-tree-first shape as the backend including its first open.
  db.close();
  const evicted = spawnSync(
    'python3',
    [
      '-c',
      'import os,sys; f=os.open(sys.argv[1], os.O_RDONLY); os.posix_fadvise(f,0,0,os.POSIX_FADV_DONTNEED); os.close(f)',
      file,
    ],
    { encoding: 'utf8' },
  );
  if (evicted.status !== 0) throw new Error(`could not evict candidate cache: ${evicted.stderr}`);
  const started = performance.now();
  const cold = new DatabaseSync(file, { readOnly: true });
  const sample = cold
    .prepare(
      `SELECT p.id FROM poi_rtree r JOIN pois p ON p.id = r.id
       WHERE r.max_lng >= ? AND r.min_lng <= ? AND r.max_lat >= ? AND r.min_lat <= ?
         AND EXISTS (SELECT 1 FROM poi_categories c WHERE c.poi_id=p.id AND c.category_id=?)
       LIMIT 51`,
    )
    .all(10.72, 10.8, 59.89, 59.94, 'shops');
  const coldTileQueryMs = Number((performance.now() - started).toFixed(2));
  cold.close();
  if (!sample.length) throw new Error('central Oslo cold-query sample returned nothing');

  const reportBuiltAt = new Date();
  const recordedBuildSeconds = Number(meta.get('build_seconds'));
  const explicitStartedAt = Date.parse(meta.get('build_started_at') ?? '');
  const databaseBuiltAt = Date.parse(meta.get('built_at') ?? '');
  // Older format-1 databases did not store the start instant, but their
  // import-time duration and built_at still let us infer it. The report's
  // duration includes indexes, quick_check and the cold query—not just ingest.
  const buildStartedAt = Number.isFinite(explicitStartedAt)
    ? explicitStartedAt
    : databaseBuiltAt - recordedBuildSeconds * 1000;
  const report = {
    sourceTimestamp: meta.get('source_timestamp'),
    sourceMd5: meta.get('source_md5'),
    filterSha256: meta.get('filter_sha256'),
    builtAt: reportBuiltAt.toISOString(),
    buildSeconds: Number.isFinite(buildStartedAt)
      ? Math.max(
          recordedBuildSeconds,
          Math.round((reportBuiltAt.getTime() - buildStartedAt) / 1000),
        )
      : recordedBuildSeconds,
    fileBytes: statSync(file).size,
    featureCount: features,
    categoryCounts: JSON.parse(meta.get('category_counts')),
    osloAudit: audits,
    nonNorwayCities: cities,
    coldTileQueryMs,
    storageRecommendation:
      coldTileQueryMs > 200 ? 'move to NVMe' : 'storage is within the 200 ms target',
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    db.close();
  } catch {
    // The latency check closes and reopens it on the success path.
  }
}
