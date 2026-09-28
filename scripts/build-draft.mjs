// Bundles the real GhostShell (plus three.js) into one self-contained HTML page for design review.
// Usage: node scripts/build-draft.mjs [out.html]
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? resolve(root, 'out/draft/ghost-shell-lab.html'));
const result = await build({
  entryPoints: [resolve(root, 'scripts/draft-entry.ts')], bundle: true, format: 'iife', minify: true,
  target: 'es2022', write: false, legalComments: 'inline',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync(resolve(root, 'scripts/draft-template.html'), 'utf8').replace('/*GHOST_BUNDLE*/', () => js);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
