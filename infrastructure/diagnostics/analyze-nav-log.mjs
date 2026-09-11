#!/usr/bin/env node
/**
 * Read a navigation diagnostic log and print the report.
 *
 * Every analysis of an uploaded log used to be written from scratch — a
 * throwaway script per question — so two readings of the same file agreed only
 * by luck and each new question cost another script. The
 * reading itself lives in `@atlas/navigation` (`analyzeNavLog`), beside the
 * vocabulary the app writes, so the two cannot drift; this is the command that
 * points it at a file.
 *
 * The backend deliberately has no download route — exact GPS history is
 * private support material, not a public paste — so pull the file first:
 *
 *   docker exec atlas-backend cat /data/diagnostics/ABCDE12345.jsonl > trip.jsonl
 *   node infrastructure/diagnostics/analyze-nav-log.mjs trip.jsonl
 *
 * Options:
 *   --prompts        include the voice cues (hidden by default; they are many)
 *   --only <kinds>   comma-separated incident kinds, e.g. route,off-route,fix-gap
 *   --max <n>        cap the timeline (default 4000 lines)
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const args = process.argv.slice(2);
const files = [];
let only = null;
let maxIncidents = 4000;
let prompts = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--prompts') prompts = true;
  else if (arg === '--only') only = (args[++i] ?? '').split(',').filter(Boolean);
  else if (arg === '--max') maxIncidents = Number(args[++i]);
  else if (arg === '-h' || arg === '--help') {
    console.log('usage: analyze-nav-log.mjs <log.jsonl> [--prompts] [--only kinds] [--max n]');
    process.exit(0);
  } else files.push(arg);
}

if (files.length === 0) {
  console.error('usage: analyze-nav-log.mjs <log.jsonl> [--prompts] [--only kinds] [--max n]');
  process.exit(2);
}

let navigation;
try {
  navigation = await import('@atlas/navigation');
} catch (error) {
  console.error(
    'Could not load @atlas/navigation — run `npm run build:packages` in the repo first.\n' +
      String(error),
  );
  process.exit(2);
}

const { analyzeNavLog, formatNavLogReport } = navigation;

for (const file of files) {
  const text = await readFile(file, 'utf8');
  const analysis = analyzeNavLog(text);
  // Every kind but the cues, unless asked for: a drive emits a hundred prompts
  // and they would bury the six lines a report is usually about.
  const include = only ?? (prompts ? allKinds(analysis) : null);
  console.log(`# ${file}`);
  console.log(formatNavLogReport(analysis, { ...(include ? { include } : {}), maxIncidents }));
}

/** Every kind present, so `--prompts` adds the cues without hiding anything. */
function allKinds(analysis) {
  const kinds = new Set();
  for (const trip of analysis.trips)
    for (const incident of trip.incidents) kinds.add(incident.kind);
  return [...kinds];
}
