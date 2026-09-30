// Records where this copy of Ghost was built from, so the installed app can update itself
// (Settings → Updates): the source folder, the branch and the exact commit.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const info = {
  sourceDir: process.cwd(),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  commit: git('rev-parse', 'HEAD'),
  builtAt: new Date().toISOString(),
};
mkdirSync('out', { recursive: true });
writeFileSync(join('out', 'build-info.json'), JSON.stringify(info, null, 2));
console.log(`build info: ${info.branch} @ ${info.commit.slice(0, 7)} from ${info.sourceDir}`);
