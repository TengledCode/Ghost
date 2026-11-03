import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explain, newestInstaller, runCommand, Updater, type Runner } from '../src/main/updater';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

/** "GitHub" (a bare repo) and Aaron's Ghost folder (a clone), with the installed build at the clone's HEAD. */
function repos() {
  const root = mkdtempSync(join(tmpdir(), 'ghost-upd-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const src = join(root, 'Ghost');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', origin, work);
  writeFileSync(join(work, 'a.txt'), '1');
  git(work, 'add', '.'); git(work, '-c', 'commit.gpgsign=false', 'commit', '-m', 'First version'); git(work, 'push', 'origin', 'main');
  git(root, 'clone', origin, src);
  const commit = git(src, 'rev-parse', 'HEAD');
  const push = (msg: string) => { writeFileSync(join(work, 'a.txt'), msg); git(work, '-c', 'commit.gpgsign=false', 'commit', '-am', msg); git(work, 'push', 'origin', 'main'); };
  return { root, src, commit, push };
}

describe('Settings → Updates', () => {
  it('finds new changes on GitHub, newest first, and says when it is up to date', async () => {
    const r = repos();
    const u = new Updater({ info: { sourceDir: r.src, branch: 'main', commit: r.commit }, version: '0.1.0', installable: true, logFile: join(r.root, 'log'), install: () => {} });
    expect((await u.check()).state).toBe('up-to-date');
    r.push('Obsidian starter layout');
    r.push('Ghost watches what you type');
    const s = await u.check();
    expect(s).toMatchObject({ state: 'available', changes: ['Ghost watches what you type', 'Obsidian starter layout'], commit: r.commit.slice(0, 7) });
  });

  it('pulls, installs packages, builds, then hands over to the newest installer', async () => {
    const r = repos();
    r.push('New thing');
    const ran: string[] = [];
    const fake: Runner = async (cmd, args, cwd) => {
      ran.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git') return runCommand(cmd, args, cwd); // really pull
      if (args.includes('dist:win')) { mkdirSync(join(cwd, 'dist'), { recursive: true }); writeFileSync(join(cwd, 'dist', 'Ghost Setup 0.1.0.exe'), 'exe'); }
      return { code: 0, out: 'ok' };
    };
    let installed = '';
    const u = new Updater({ info: { sourceDir: r.src, branch: 'main', commit: r.commit }, version: '0.1.0', installable: true, logFile: join(r.root, 'log'), run: fake, install: p => { installed = p; } });
    const seen: string[] = [];
    u.on('status', s => { if (s.step) seen.push(s.step); });
    await u.update();
    expect(ran).toEqual(['git pull --ff-only origin main', 'npm install --no-audit --no-fund', 'npm run dist:win']);
    expect(git(r.src, 'log', '-1', '--format=%s')).toBe('New thing');
    expect(installed).toBe(join(r.src, 'dist', 'Ghost Setup 0.1.0.exe'));
    expect(seen.at(-1)).toBe('Installing and restarting Ghost');
  });

  it('stops at a failed step, installs nothing, and explains in plain words', async () => {
    const r = repos();
    let installed = false;
    const failing: Runner = async (cmd) => (cmd === 'npm' ? { code: 1, out: 'npm ERR! network request failed: getaddrinfo ENOTFOUND registry.npmjs.org' } : { code: 0, out: '' });
    const u = new Updater({ info: { sourceDir: r.src, branch: 'main', commit: r.commit }, version: '0.1.0', installable: true, logFile: join(r.root, 'log'), run: failing, install: () => { installed = true; } });
    const s = await u.update();
    expect(s.state).toBe('error');
    expect(s.error).toMatch(/Installing packages failed: no connection/);
    expect(s.error).toMatch(/Full details: .*log$/);
    expect(installed).toBe(false);
  });

  it('is off for copies without build info, and never installs when running from source', async () => {
    const off = new Updater({ info: null, version: '0.1.0', installable: true, logFile: '/dev/null', install: () => {} });
    expect(off.current.state).toBe('unavailable');
    const r = repos();
    let installed = false;
    const dev = new Updater({ info: { sourceDir: r.src, branch: 'main', commit: r.commit }, version: '0.1.0', installable: false, logFile: join(r.root, 'log'), install: () => { installed = true; } });
    await dev.update();
    expect(installed).toBe(false);
    expect(explain('Downloading the changes', "error: Your local changes to the following files would be overwritten")).toMatch(/changes of its own/);
    expect(newestInstaller(join(r.root, 'nope'))).toBeNull();
  });

  it("doesn't blame git or Node for a build error that mentions a missing file", () => {
    const build = [
      '> electron-builder --win nsis',
      '  • building        target=nsis file=dist\\Ghost Setup 0.1.0.exe',
      "  ⨯ ENOENT: no such file or directory, open 'C:\\Ghost\\build\\icon.ico'",
      'npm error code 1',
      'npm error A complete log of this run can be found in: C:\\npm-cache\\_logs\\x.log',
    ].join('\n');
    const msg = explain('Building the new version', build, 1);
    expect(msg).not.toMatch(/isn't available/);
    expect(msg).toMatch(/⨯ ENOENT: no such file or directory, open .*icon\.ico/);
    expect(explain('Building the new version', 'spawn npm ENOENT', -1)).toMatch(/isn't available/);
    const locked = "  ⨯ makensis.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE\nError output:\nCan't open output file\n    at ChildProcess.cp.emit (C:\\Ghost\\node_modules\\cross-spawn\\lib\\enoent.js:34:29)";
    expect(explain('Building the new version', locked, 1)).toMatch(/previous installer .* locked/);
    expect(explain('Installing packages', "'npm' is not recognized as an internal or external command,", 1)).toMatch(/isn't available/);
  });
});

describe("Settings → Updates: the brains' CLIs", () => {
  // Real git for the Ghost folder; claude / npm / agy answered by a fake.
  const fakeClis = (opts: { claude?: string; latest?: string; agyFails?: boolean } = {}) => {
    const ran: string[] = [];
    const run: Runner = async (cmd, args, cwd) => {
      ran.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'git') return runCommand(cmd, args, cwd);
      if (cmd === 'claude' && args[0] === '--version') return { code: 0, out: `${opts.claude ?? '2.1.283'} (Claude Code)\n` };
      if (cmd === 'npm' && args[0] === 'view') return { code: 0, out: `${opts.latest ?? '2.1.316'}\n` };
      if (cmd === 'agy' && opts.agyFails) return { code: 1, out: 'agy: update server unreachable' };
      if (args.includes('dist:win')) { mkdirSync(join(cwd, 'dist'), { recursive: true }); writeFileSync(join(cwd, 'dist', 'Ghost Setup 0.1.0.exe'), 'exe'); }
      return { code: 0, out: 'ok' };
    };
    return { ran, run };
  };

  it('lists a newer Claude Code as an update', async () => {
    const r = repos();
    const { run } = fakeClis();
    const clis = { stopBrains: () => {}, restart: () => {} };
    const u = new Updater({ info: { sourceDir: r.src, branch: 'main', commit: r.commit }, version: '0.1.0', installable: true, logFile: join(r.root, 'log'), run, install: () => {}, clis });
    expect(await u.check()).toMatchObject({ state: 'available', changes: ['Claude Code 2.1.283 → 2.1.316'] });
    const same = new Updater({ info: { sourceDir: r.src, branch: 'main', commit: r.commit }, version: '0.1.0', installable: true, logFile: join(r.root, 'log'), run: fakeClis({ latest: '2.1.283' }).run, install: () => {}, clis });
    expect((await same.check()).state).toBe('up-to-date');
  });

  it('updates the CLIs with the brains stopped, and just restarts when Ghost itself has nothing new', async () => {
    const r = repos();
    const { ran, run } = fakeClis({ agyFails: true }); // one CLI failing doesn't stop the rest
    const events: string[] = [];
    let installed = false;
    const u = new Updater({ info: { sourceDir: r.src, branch: 'main', commit: r.commit }, version: '0.1.0', installable: true, logFile: join(r.root, 'log'), run,
      install: () => { installed = true; }, clis: { stopBrains: () => events.push('brains stopped'), restart: () => events.push('restarted') } });
    await u.update();
    expect(events).toEqual(['brains stopped', 'restarted']);
    expect(ran.filter(c => !c.startsWith('git'))).toEqual(['claude update', 'agy update']); // no rebuild
    expect(installed).toBe(false);
  });

  it('updates the CLIs and then Ghost itself when there are new changes', async () => {
    const r = repos();
    r.push('New thing');
    const { ran, run } = fakeClis();
    let installed = '';
    const u = new Updater({ info: { sourceDir: r.src, branch: 'main', commit: r.commit }, version: '0.1.0', installable: true, logFile: join(r.root, 'log'), run,
      install: p => { installed = p; }, clis: { stopBrains: () => {}, restart: () => { throw new Error('should rebuild, not just restart'); } } });
    await u.update();
    expect(ran.filter(c => !c.startsWith('git log'))).toEqual(['claude update', 'agy update', 'git fetch --quiet origin main', 'git pull --ff-only origin main', 'npm install --no-audit --no-fund', 'npm run dist:win']);
    expect(installed).toBe(join(r.src, 'dist', 'Ghost Setup 0.1.0.exe'));
  });

  it("offers and builds a change made in the Ghost folder that isn't on GitHub yet", async () => {
    const r = repos();
    writeFileSync(join(r.src, 'a.txt'), 'held back');
    git(r.src, '-c', 'commit.gpgsign=false', 'commit', '-am', 'Recordings fix');
    const { run } = fakeClis({ latest: '2.1.283' }); // Claude Code already current
    let installed = '';
    const u = new Updater({ info: { sourceDir: r.src, branch: 'main', commit: r.commit }, version: '0.1.0', installable: true, logFile: join(r.root, 'log'), run,
      install: p => { installed = p; }, clis: { stopBrains: () => {}, restart: () => { throw new Error('should rebuild, not just restart'); } } });
    const s = await u.check();
    expect(s.state).toBe('available');
    expect(s.changes).toEqual(['Recordings fix (on this PC only)']);
    await u.update();
    expect(installed).toBe(join(r.src, 'dist', 'Ghost Setup 0.1.0.exe'));
  });
});
