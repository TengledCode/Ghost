import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// On Windows, npm-installed CLIs are .cmd shims that can only start through a shell. Every argument
// is therefore quoted, and free text (prompts, personas) never goes in argv: it goes through stdin or a file.
const isWin = process.platform === 'win32';

export function quoteWin(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%!()]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/%/g, '"%"')}"`;
}

export interface CliRun {
  lines: AsyncIterable<string>;
  stderr: () => string;
  exit: Promise<number | null>;
}

export function runCli(cmd: string, args: string[], opts: { stdin: string; cwd: string; env?: NodeJS.ProcessEnv; signal: AbortSignal }): CliRun {
  const child = spawn(isWin ? [cmd, ...args].map(quoteWin).join(' ') : cmd, isWin ? [] : args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    shell: isWin,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => { err = (err + d).slice(-8000); });
  const exit = new Promise<number | null>(resolve => {
    child.on('error', e => { err += String(e); resolve(-1); });
    child.on('close', code => resolve(code));
  });
  const kill = () => {
    if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    else child.kill('SIGTERM');
  };
  opts.signal.addEventListener('abort', kill, { once: true });
  child.stdin.on('error', () => { /* child exited early; surfaced via exit code */ });
  child.stdin.end(opts.stdin);
  return { lines: createInterface({ input: child.stdout, crlfDelay: Infinity }), stderr: () => err, exit };
}

export interface LiveCli {
  lines: AsyncIterable<string> & NodeJS.EventEmitter;
  write(obj: unknown): boolean;
  stderr: () => string;
  exit: Promise<number | null>;
  alive: () => boolean;
  kill: () => void;
}

/** A long-running CLI process that takes JSON lines on stdin (used to keep Claude warm between messages). */
export function spawnLive(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): LiveCli {
  const child = spawn(isWin ? [cmd, ...args].map(quoteWin).join(' ') : cmd, isWin ? [] : args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    shell: isWin,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  let running = true;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => { err = (err + d).slice(-8000); });
  const exit = new Promise<number | null>(resolve => {
    child.on('error', e => { err += String(e); running = false; resolve(-1); });
    child.on('close', code => { running = false; resolve(code); });
  });
  child.stdin.on('error', () => { running = false; });
  return {
    lines: createInterface({ input: child.stdout, crlfDelay: Infinity }),
    write: obj => running && child.stdin.write(JSON.stringify(obj) + '\n'),
    stderr: () => err,
    exit,
    alive: () => running,
    kill: () => {
      running = false;
      if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
      else child.kill('SIGTERM');
    },
  };
}

export async function commandExists(cmd: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = spawn(isWin ? 'where' : 'which', [cmd], { windowsHide: true });
    probe.on('error', () => resolve(false));
    probe.on('close', code => resolve(code === 0));
  });
}
