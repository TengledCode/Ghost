// Makes room for the new installer. electron-builder writes "dist/Ghost Setup <version>.exe" over the
// previous one, and on Windows that fails ("Can't open output file") while the old file is still
// locked, e.g. by antivirus scanning it or by the last update's installer. A locked file can still be
// renamed, so old installers are moved aside, then deleted where Windows allows it.
import { readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
let files = [];
try { files = readdirSync(dist); } catch { process.exit(0); } // first build: nothing to clear
const stamp = Date.now();
for (const f of files) {
  const path = join(dist, f);
  if (/setup.*\.exe$/i.test(f) || /\.exe\.old-\d+$/i.test(f) || /\.__uninstaller\.exe$/i.test(f)) {
    try { rmSync(path, { force: true }); continue; } catch { /* locked: move it aside instead */ }
    if (/\.old-\d+$/.test(f)) continue; // already aside; it goes next time
    try { renameSync(path, `${path}.old-${stamp}`); console.log(`moved aside (in use): ${f}`); }
    catch (e) { console.error(`can't clear ${f}: ${e.message}. Close anything using it and try again.`); process.exit(1); }
  }
}
