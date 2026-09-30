import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Settings → Updates: Ghost updates itself from the folder it was built from. It checks the branch on
// GitHub for new commits, and on "Update" runs the same steps Aaron would (git pull, npm install,
// npm run dist:win), then runs the new installer silently and restarts. If any step fails nothing is
// installed: Ghost keeps running as it is and says what went wrong.

export interface BuildInfo { sourceDir: string; branch: string; commit: string; builtAt?: string }

export type UpdateState = 'unavailable' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'updating' | 'error';

export interface UpdateStatus {
  state: UpdateState;
  version: string;
  commit: string; // the installed build (short)
  changes: string[]; // commit messages not yet installed, newest first
  step?: string;
  progress?: number; // 0 - 1 while updating
  error?: string;
  checkedAt?: number;
  canInstall: boolean; // false when running from source (npm run dev)
}

export type Runner = (cmd: string, args: string[], cwd: string) => Promise<{ code: number | null; out: string }>;

/** Runs a command (through the shell on Windows, where npm is a .cmd), collecting its output. */
export const runCommand: Runner = (cmd, args, cwd) => new Promise(resolve => {
  const win = process.platform === 'win32';
  const child = spawn(win ? [cmd, ...args].map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ') : cmd, win ? [] : args, {
    cwd, shell: win, windowsHide: true, env: process.env,
  });
  let out = '';
  const add = (d: Buffer) => { out = (out + d.toString('utf8')).slice(-20_000); };
  child.stdout?.on('data', add);
  child.stderr?.on('data', add);
  child.on('error', e => resolve({ code: -1, out: `${out}\n${e.message}` }));
  child.on('close', code => resolve({ code, out }));
});

export function readBuildInfo(file: string): BuildInfo | null {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as BuildInfo;
    return info.sourceDir && info.commit ? info : null;
  } catch { return null; }
}

export interface UpdaterOptions {
  info: BuildInfo | null;
  version: string;
  installable: boolean; // a packaged, installed build (not npm run dev)
  logFile: string;
  run?: Runner;
  /** Start the installer after Ghost quits (Windows), then quit. */
  install: (installer: string) => void;
}

export class Updater extends EventEmitter {
  private status: UpdateStatus;
  private readonly run: Runner;

  constructor(private readonly o: UpdaterOptions) {
    super();
    this.run = o.run ?? runCommand;
    this.status = {
      state: o.info ? 'idle' : 'unavailable', version: o.version, commit: o.info?.commit.slice(0, 7) ?? '', changes: [],
      canInstall: o.installable,
    };
  }

  get current(): UpdateStatus { return { ...this.status }; }

  /** Look for commits on the branch that this build doesn't have. */
  async check(): Promise<UpdateStatus> {
    const info = this.o.info;
    if (!info || this.status.state === 'updating' || this.status.state === 'checking') return this.current;
    this.set({ state: 'checking', error: undefined });
    const fetch = await this.run('git', ['fetch', '--quiet', 'origin', info.branch], info.sourceDir);
    if (fetch.code !== 0) return this.set({ state: 'error', error: explain('Checking for updates', fetch.out), checkedAt: Date.now() });
    const log = await this.run('git', ['log', '--format=%s', `${info.commit}..origin/${info.branch}`], info.sourceDir);
    if (log.code !== 0) return this.set({ state: 'error', error: explain('Checking for updates', log.out), checkedAt: Date.now() });
    const changes = log.out.split('\n').map(l => l.trim()).filter(Boolean);
    return this.set({ state: changes.length ? 'available' : 'up-to-date', changes, checkedAt: Date.now() });
  }

  /** Pull, install packages, build the installer, then hand over to it. */
  async update(): Promise<UpdateStatus> {
    const info = this.o.info;
    if (!info || !this.o.installable || this.status.state === 'updating') return this.current;
    const steps: [string, string, string[]][] = [
      ['Downloading the changes', 'git', ['pull', '--ff-only', 'origin', info.branch]],
      ['Installing packages', 'npm', ['install', '--no-audit', '--no-fund']],
      ['Building the new version (about a minute)', 'npm', ['run', 'dist:win']],
    ];
    this.log(`\n=== Update started ${new Date().toISOString()} (${info.branch} @ ${info.commit.slice(0, 7)})`);
    for (const [i, [label, cmd, args]] of steps.entries()) {
      this.set({ state: 'updating', step: label, progress: i / (steps.length + 1), error: undefined });
      this.log(`--- ${label}: ${cmd} ${args.join(' ')}`);
      const r = await this.run(cmd, args, info.sourceDir);
      this.log(r.out);
      if (r.code !== 0) {
        return this.set({ state: 'error', step: undefined, progress: undefined, error: explain(label, r.out) });
      }
    }
    const installer = newestInstaller(join(info.sourceDir, 'dist'));
    if (!installer) return this.set({ state: 'error', step: undefined, progress: undefined, error: "The build finished but no installer was found in the dist folder." });
    this.set({ state: 'updating', step: 'Installing and restarting Ghost', progress: steps.length / (steps.length + 1) });
    this.log(`--- Installing ${installer}`);
    this.o.install(installer);
    return this.current;
  }

  private set(patch: Partial<UpdateStatus>): UpdateStatus {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.current);
    return this.current;
  }

  private log(text: string): void { try { appendFileSync(this.o.logFile, `${text}\n`); } catch { /* best effort */ } }
}

/** The most recent "… Setup ….exe" electron-builder produced. */
export function newestInstaller(distDir: string): string | null {
  try {
    const exes = readdirSync(distDir).filter(f => /setup.*\.exe$/i.test(f)).map(f => join(distDir, f));
    return exes.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  } catch { return null; }
}

/** A plain-language reason for a failed step, with the useful end of the output. */
export function explain(step: string, out: string): string {
  const text = out.trim();
  if (/not a git repository/i.test(text)) return `${step} failed: the Ghost folder it was built from is gone or moved. Rebuild once from its new location.`;
  if (/local changes|would be overwritten|not possible to fast-forward|diverged/i.test(text)) return `${step} failed: your Ghost folder has changes of its own. Open it and run "git status" to see them.`;
  if (/could not resolve host|unable to access|network|ENOTFOUND|ETIMEDOUT/i.test(text)) return `${step} failed: no connection to GitHub or npm. Check your internet and try again.`;
  if (/is not recognized|command not found|ENOENT/i.test(text)) return `${step} failed: git or Node.js isn't available to Ghost. Reinstall them, or restart the PC so Ghost sees them.`;
  const tail = text.split('\n').filter(Boolean).slice(-3).join(' · ');
  return `${step} failed${tail ? `: ${tail.slice(0, 300)}` : '.'}`;
}
