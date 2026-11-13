// Self-contained review artifacts; no CDN, server or image-processing dependency.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const html = (text) =>
  String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
export const dp = (profile) =>
  profile.size
    .split('x')
    .map((n) => Math.round((Number(n) * 160) / profile.density))
    .join(' × ');

export async function writeReport(out, manifest) {
  await mkdir(out, { recursive: true });
  const web = manifest.platform === 'web';
  const platform = web ? 'Web' : 'Android';
  const screens = manifest.screens;
  const areas = [...new Set(screens.map((s) => s.area))];
  const gaps = manifest.gaps.map((g) => `<li>${html(g.file)}: ${html(g.error)}</li>`).join('');
  const sections = areas
    .map(
      (area) =>
        `<section><h2>${html(area)}</h2>${[
          ...new Set(screens.filter((s) => s.area === area).map((s) => s.id ?? s.title)),
        ]
          .map(
            (id) =>
              `<article><div class="shots">${screens
                .filter((s) => s.area === area && (s.id ?? s.title) === id)
                .map(
                  (s) => `
<figure data-size="${html(s.size)}" data-search="${html(`${area} ${s.title}`.toLowerCase())}"><a href="${html(s.file)}"><img loading="lazy" src="${html(s.file)}" alt="${html(s.title)}"></a><figcaption><strong>${html(s.title)}</strong><br>${html(s.size)} · ${html(s.orientation)} · ${s.width} × ${s.height} px${s.settled ? '' : '<br><b>Rendering did not settle</b>'}${s.note ? `<br>${html(s.note)}` : ''}</figcaption></figure>`,
                )
                .join('')}</div></article>`,
          )
          .join('')}</section>`,
    )
    .join('');
  const gallery = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atlas ${platform} screenshot review</title>
<style>body{font:16px/1.5 system-ui;margin:24px;background:#eee;color:#222}a{color:#2359ad}header{max-width:1000px}label{display:inline-block;margin:8px}input,select{font:inherit;padding:8px}article{margin-bottom:24px}.shots{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}figure{margin:0;padding:12px;background:white;border-radius:10px;width:300px}img{width:100%;height:420px;object-fit:contain;background:#ddd}figcaption{padding-top:8px}b{color:#9d3100}[hidden]{display:none!important}@media(prefers-color-scheme:dark){body{background:#18191b;color:#eee}figure{background:#292b2f}a{color:#9cc4ff}}</style>
<header><h1>Atlas ${platform} screenshot review</h1><p>${screens.length} captures · ${manifest.gaps.length} gaps · ${html(manifest.generatedAt)}</p><p><a href="REVIEW.md">Review context and prompts</a> · <a href="manifest.json">JSON manifest</a>. Select an image to open its full-resolution PNG.</p>
${manifest.stopped ? `<p><b>Run stopped: ${html(manifest.stopped)}</b></p>` : ''}${gaps ? `<details open><summary>Missing or failed screens</summary><ul>${gaps}</ul></details>` : ''}
<label>Find a screen <input id="search" type="search"></label><label for="size">Size</label><select id="size"><option value="">All sizes</option>${Object.keys(
    manifest.sizes,
  )
    .map((size) => `<option>${html(size)}</option>`)
    .join('')}</select></header>${sections}
<script>const search=document.querySelector('#search'),size=document.querySelector('#size');function filter(){for(const f of document.querySelectorAll('figure'))f.hidden=!f.dataset.search.includes(search.value.toLowerCase())||(size.value!==''&&f.dataset.size!==size.value);for(const a of document.querySelectorAll('article'))a.hidden=!a.querySelector('figure:not([hidden])');for(const s of document.querySelectorAll('section'))s.hidden=!s.querySelector('figure:not([hidden])')}search.addEventListener('input',filter);size.addEventListener('change',filter);</script></html>\n`;
  const context = [
    `# Atlas ${platform} UI / UX review`,
    '',
    `Open index.html for the offline gallery. manifest.json records the capture recipe, device, image dimensions, SHA-256, settling status and gaps. ${web ? 'Browser errors and map readiness are recorded per screen.' : 'Each PNG has a matching UI hierarchy XML.'}`,
    '',
    '## Capture context',
    '',
    `- Captured at ${manifest.generatedAt} using ${web ? 'Playwright Chromium and accessible names' : 'ADB and native React Native test IDs'}.`,
    ...(web
      ? [
          `- Origin: ${manifest.origin}; deployed commit ${manifest.deployedSha ?? 'unknown'}; Chromium ${manifest.browser ?? 'unknown'}.`,
          '- Each screen uses a fresh isolated browser context with one page, an empty local library, no account, light theme, en-GB locale and Europe/Oslo timezone. No personal browser state is read. Live backend responses are used, with no mocks.',
          '- Viewports use CSS pixels at DPR 1. They exercise responsive web layouts, not Android hardware or a real mobile browser/soft keyboard.',
        ]
      : [
          `- Device: ${manifest.device?.serial ?? 'unknown'}, AVD ${manifest.device?.avd ?? 'unknown'}, Android ${manifest.device?.android ?? 'unknown'}.`,
          `- Installed APK version: ${manifest.device?.apkVersion ?? 'unknown'}. An installed OTA can have a different version; inspect Settings → System.`,
          '- The app is cold-launched for each screen. Existing library, account, server, theme and downloaded packs are retained. No library records or account/theme/server settings are edited. A restored unfinished planner is closed before each recipe; ordinary panel and map state can persist as during normal use.',
          '- Display size, density and rotation are temporarily emulated and restored afterwards. This does not emulate tablet hardware, GPS or GPU performance.',
        ]),
    `- Harness checkout: ${manifest.checkout?.sha ?? 'unknown'}${manifest.checkout?.dirty ? ' (uncommitted changes)' : ''}. This identifies the runner source, not the installed app bundle.`,
    '',
    '| Size | Pixels | Density | Base layout (dp / CSS px) |',
    '| --- | --- | --- | --- |',
    ...Object.entries(manifest.sizes).map(
      ([size, p]) => `| ${size} | ${p.size} | ${p.density} | ${dp(p)} |`,
    ),
    '',
    '## Coverage',
    '',
    ...areas.map(
      (area) =>
        `- **${area}:** ${screens
          .filter((s) => s.area === area)
          .map((s) => `${s.title} (${s.size}, ${s.orientation})`)
          .join('; ')}.`,
    ),
    '',
    '## Limits and gaps',
    '',
    '- This is a visual inventory. Navigation in progress, populated/empty library variants, downloads, offline operation, authentication, Garmin, widgets and destructive operations are not exhaustively exercised.',
    '- Live tiles, services, clocks, account state, GPS and the keyboard can change pixels. Identical frames are a settling heuristic, not proof that all network work finished. Inspect maps for missing tiles or labels; SwiftShader may omit native symbol text.',
    '- Changed-screen comparison is not implemented. Hashes record artifact identity; they are not a pixel-diff verdict.',
    ...(manifest.stopped ? [`- **Stopped:** ${manifest.stopped}`] : []),
    ...manifest.gaps.map((g) => `- **Gap:** ${g.file}: ${g.error}`),
    ...screens
      .filter((s) => !s.settled)
      .map((s) => `- **Unsettled:** ${s.file}; inspect the final frame manually.`),
    ...screens.flatMap((s) =>
      (s.errors ?? []).map((error) => `- **Browser error:** ${s.file}: ${error}`),
    ),
    ...(manifest.restoreErrors ?? []).map((error) => `- **Restoration failed:** ${error}`),
    '',
    '## Review prompts',
    '',
    ...areas.flatMap((area) => [
      `### ${area}`,
      '',
      `Review the **${area}** screenshots of Atlas, an offline-first mapping and navigation app for Android and web. The map should stay useful beside sheets; outdoor legibility, clear route planning, accessible controls and consistent interactions matter.`,
      '',
      'Compare the captured phone, tablet and desktop layouts where present. Be critical, precise and concise about usability, spacing, hierarchy, icons, consistency, clipped content and obvious missing interactions. Explain what should change and why. Treat live-service failures and rendering limitations separately from layout issues. Do not invent problems or infer that an operation works from a screenshot.',
      '',
      'End with a prioritized `- [ ]` checklist of concrete improvements. Suggestions are provisional until agreed.',
      '',
    ]),
  ];
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(out, 'index.html'), gallery);
  await writeFile(join(out, 'REVIEW.md'), `${context.join('\n')}\n`);
}
