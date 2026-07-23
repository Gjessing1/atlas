#!/usr/bin/env node
// Fetch short article intros for the OSM-tagged Wikipedia/Wikivoyage POIs in a
// pack search database. The resulting rows travel inside search.sqlite, so the
// Android destination card can read them without a network connection.
//
// Usage: node enrich-place-content.mjs <search.sqlite>

import { DatabaseSync } from 'node:sqlite';

const [file] = process.argv.slice(2);
if (!file) {
  console.error('usage: enrich-place-content.mjs <search.sqlite>');
  process.exit(1);
}

const USER_AGENT = 'Atlas pack builder (place content; https://git.gjessing.io/gjessing1/atlas)';
const db = new DatabaseSync(file);
const rows = db
  .prepare(
    `SELECT rowid, wikipedia, wikivoyage
       FROM places
      WHERE wikipedia <> '' OR wikivoyage <> ''`,
  )
  .all();

function reference(raw, fallbackLanguage) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  const url = /^https?:\/\/([a-z-]+)\.(wikipedia|wikivoyage)\.org\/wiki\/(.+)$/i.exec(value);
  if (url) {
    return {
      language: url[1].toLowerCase(),
      title: decodeURIComponent(url[3]).replaceAll('_', ' '),
    };
  }
  const tagged = /^([a-z]{2,3}(?:-[a-z]+)?):(.+)$/i.exec(value);
  if (tagged) return { language: tagged[1].toLowerCase(), title: tagged[2].trim() };
  return { language: fallbackLanguage, title: value.replaceAll('_', ' ') };
}

const jobs = new Map();
for (const row of rows) {
  for (const source of ['wikipedia', 'wikivoyage']) {
    const ref = reference(row[source], 'en');
    if (!ref) continue;
    const key = `${source}/${ref.language}`;
    const list = jobs.get(key) ?? [];
    list.push({ placeRowid: row.rowid, source, ...ref });
    jobs.set(key, list);
  }
}

const insert = db.prepare(`
  INSERT OR REPLACE INTO place_content
    (place_rowid, source, language, title, extract, url)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const normalise = (value) => value.replaceAll('_', ' ').trim().toLocaleLowerCase();
let inserted = 0;

for (const [key, items] of jobs) {
  const [source, language] = key.split('/');
  const unique = [...new Map(items.map((item) => [normalise(item.title), item.title])).values()];
  for (let offset = 0; offset < unique.length; offset += 20) {
    const titles = unique.slice(offset, offset + 20);
    const url = new URL(`https://${language}.${source}.org/w/api.php`);
    for (const [name, value] of Object.entries({
      action: 'query',
      format: 'json',
      formatversion: '2',
      redirects: '1',
      prop: 'extracts|info',
      exintro: '1',
      explaintext: '1',
      exchars: '700',
      inprop: 'url',
      titles: titles.join('|'),
    })) {
      url.searchParams.set(name, value);
    }
    let query = {};
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        console.warn(`${key}: HTTP ${response.status}`);
        continue;
      }
      query = (await response.json()).query ?? {};
    } catch (error) {
      console.warn(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const byTitle = new Map(
      (query.pages ?? [])
        .filter((page) => page.extract && page.fullurl)
        .map((page) => [normalise(page.title), page]),
    );
    // MediaWiki returns the canonical page title after normalization and
    // redirects. Rebuild the aliases in reverse order so the raw OSM title
    // still finds that canonical response.
    for (const alias of query.redirects ?? []) {
      const page = byTitle.get(normalise(alias.to));
      if (page) byTitle.set(normalise(alias.from), page);
    }
    for (const alias of query.normalized ?? []) {
      const page = byTitle.get(normalise(alias.to));
      if (page) byTitle.set(normalise(alias.from), page);
    }
    db.exec('BEGIN');
    for (const item of items) {
      if (!titles.some((title) => normalise(title) === normalise(item.title))) continue;
      const page = byTitle.get(normalise(item.title));
      if (!page) continue;
      insert.run(
        item.placeRowid,
        item.source,
        item.language,
        page.title,
        page.extract,
        page.fullurl,
      );
      inserted++;
    }
    db.exec('COMMIT');
  }
}

db.close();
console.log(`${file}: bundled ${inserted} place articles`);
