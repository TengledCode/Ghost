// `npm run preview:ui`: runs the renderer in a normal browser against a mock core.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await build({
  entryPoints: [resolve(root, 'scripts/preview-core.ts')], bundle: true, platform: 'node', format: 'esm',
  outfile: resolve(root, 'out/preview-core.mjs'), packages: 'external', target: 'node20',
});
const coreProc = spawn(process.execPath, [resolve(root, 'out/preview-core.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
const { url, token } = await new Promise(res => createInterface({ input: coreProc.stdout }).once('line', l => res(JSON.parse(l))));

const server = await createServer({ root: resolve(root, 'src/renderer'), publicDir: resolve(root, 'vendor'), server: { port: Number(process.env.PORT ?? 5199) } });
await server.listen();
const base = `http://localhost:${server.config.server.port}`;
const q = `?core=${encodeURIComponent(url)}&token=${token}`;
console.log(`GHOST_PREVIEW ${base}/overlay/index.html${q}`);
console.log(`Settings: ${base}/settings/index.html${q}`);
process.on('SIGTERM', () => { coreProc.kill(); server.close(); process.exit(0); });
process.on('SIGINT', () => { coreProc.kill(); server.close(); process.exit(0); });
