#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { POI_CATEGORIES } from '../../packages/core/dist/index.js';

const [filterFile, configFile] = process.argv.slice(2);
if (!filterFile || !configFile) {
  console.error('usage: generate-config.mjs <filter.txt> <config.json>');
  process.exit(2);
}

const expressions = [
  ...new Set(
    POI_CATEGORIES.flatMap((category) =>
      category.selectors.flatMap((selector) =>
        selector.values?.length
          ? selector.values.map((value) => `nwr/${selector.key}=${value}`)
          : [`nwr/${selector.key}`],
      ),
    ),
  ),
].sort();
const filter = `${expressions.join('\n')}\n`;
const filterDigest = createHash('sha256').update(filter).digest('hex');
const tagKeys = [
  ...new Set([
    'name',
    'brand',
    'operator',
    'addr:place',
    'addr:street',
    'addr:housenumber',
    'addr:housename',
    'addr:postcode',
    'addr:city',
    'addr:country',
    'contact:phone',
    'phone',
    'opening_hours',
    'contact:website',
    'website',
    'url',
    ...POI_CATEGORIES.flatMap((category) => category.selectors.map((selector) => selector.key)),
  ]),
].sort();

writeFileSync(filterFile, filter);
writeFileSync(
  configFile,
  `${JSON.stringify({ filterDigest, expressions, tagKeys, categories: POI_CATEGORIES }, null, 2)}\n`,
);
console.log(filterDigest);
