import { spawn } from 'node:child_process';
import { appendFile, mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import type { HistoryStore } from '../memory/conversations';
import type { FactStore, MemoryTopic } from '../memory/store';
import type { VaultTools } from '../obsidian/vaultTools';
import type { ReminderScheduler } from '../reminders/scheduler';
import type { ToolName } from './definitions';
import { duration } from '../captureCommands';

/** Host hooks, injected so the executor can be tested without Electron. */
export interface Host {
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<string>; // returns '' on success, error text otherwise
  trash(path: string): Promise<void>;
  /** An image file, scaled down to a size a model reads well (Electron's nativeImage). */
  loadImage?(path: string): Promise<{ data: Buffer; mime: string }>;
  /** Screenshots and screen recordings (absent in tests and the browser preview). */
  capture?: CaptureHost;
}

export interface RecordingState { on: boolean; startedAt?: number; mic: boolean; micError?: string }
export interface CaptureHost {
  screenshot(): Promise<{ path: string }>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<string>; // the saved file
  setRecordingMic(on: boolean): void;
  recording(): RecordingState;
}

/** What a tool hands back to the model: text, and for read_file on a picture, the picture itself. */
export type ToolResult = string | { text: string; image: { data: string; mime: string } };

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const MAX_TEXT = 20_000; // characters of a text file given to the model
const MAX_RAW_IMAGE = 5_000_000; // bytes, when the host can't scale the image down

const isWin = process.platform === 'win32';
const NO_VAULT = "Obsidian isn't connected. Aaron can choose his vault in Settings → Obsidian.";
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function runPowerShell(script: string, timeoutMs = 60_000): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => {
    const exe = isWin ? 'powershell.exe' : 'pwsh';
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let out = '';
    const add = (d: Buffer) => { out = (out + d.toString('utf8')).slice(-12_000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => { child.kill(); out += '\n[timed out]'; }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: `${exe} unavailable: ${e.message}` }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
  });
}

async function findStartMenuShortcut(name: string): Promise<string | null> {
  const roots = [
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft/Windows/Start Menu/Programs'),
    join(process.env.APPDATA ?? '', 'Microsoft/Windows/Start Menu/Programs'),
  ];
  const needle = name.toLowerCase().replace(/\.exe$/, '');
  const hits: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (/\.(lnk|url)$/i.test(e.name) && basename(e.name, extname(e.name)).toLowerCase().includes(needle)) hits.push(full);
    }
  };
  for (const r of roots) await walk(r, 0);
  // Prefer the shortest name ("Spotify" over "Spotify Uninstall").
  hits.sort((a, b) => basename(a).length - basename(b).length);
  return hits.find(h => !/uninstall/i.test(h)) ?? null;
}

export class ToolExecutor {
  constructor(
    private readonly host: Host,
    private readonly memory: FactStore,
    private readonly reminders: ReminderScheduler,
    private readonly history?: Pick<HistoryStore, 'search'>,
    private readonly vault?: VaultTools,
  ) {}

  async run(tool: ToolName, a: Record<string, any>): Promise<ToolResult> {
    switch (tool) {
      case 'get_datetime': {
        const now = new Date();
        return `${now.toString()} (ISO ${now.toISOString()}, zone ${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
      }
      case 'open_app': {
        const name = String(a.name).trim();
        const shortcut = isWin ? await findStartMenuShortcut(name) : null;
        if (shortcut) {
          const err = await this.host.openPath(shortcut);
          if (!err) return `Opened ${basename(shortcut, extname(shortcut))}.`;
        }
        const r = await runPowerShell(`Start-Process ${psQuote(name)}`, 15_000);
        return r.code === 0 ? `Started ${name}.` : `Could not find an app called "${name}". ${r.out}`;
      }
      case 'open_path_or_url': {
        const target = String(a.target).trim();
        if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) { await this.host.openExternal(target); return `Opened ${target}.`; }
        if (!isAbsolute(target)) return 'Please give an absolute path or a full URL.';
        const err = await this.host.openPath(target);
        return err ? `Could not open ${target}: ${err}` : `Opened ${target}.`;
      }
      case 'list_windows': {
        const r = await runPowerShell('Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json -Compress', 15_000);
        return r.out || 'No visible windows.';
      }
      case 'focus_window': {
        const r = await runPowerShell(`(New-Object -ComObject WScript.Shell).AppActivate(${psQuote(String(a.title))})`, 10_000);
        return /True/.test(r.out) ? `Brought "${a.title}" to the front.` : `No window matching "${a.title}".`;
      }
      case 'close_app': {
        const r = await runPowerShell(`$p = Get-Process -Name ${psQuote(String(a.name).replace(/\.exe$/i, ''))} -ErrorAction SilentlyContinue; if ($p) { $p | ForEach-Object { [void]$_.CloseMainWindow() }; 'closed' } else { 'not running' }`, 15_000);
        return r.out.includes('closed') ? `Asked ${a.name} to close.` : `${a.name} isn't running.`;
      }
      case 'run_command': {
        const r = await runPowerShell(String(a.command));
        return `exit ${r.code}\n${r.out || '(no output)'}`;
      }
      case 'take_screenshot': {
        if (!this.host.capture) return "Screenshots aren't available here.";
        const shot = await this.host.capture.screenshot();
        return `Saved the screenshot to ${shot.path} and copied it to the clipboard.`;
      }
      case 'start_recording': {
        if (!this.host.capture) return "Screen recording isn't available here.";
        if (this.host.capture.recording().on) return 'Already recording the screen.';
        await this.host.capture.startRecording();
        return 'Recording the screen with the PC sound (Ghost stays out of the video). It stops when Aaron says "stop recording" or presses stop on the REC tag.';
      }
      case 'stop_recording': {
        if (!this.host.capture?.recording().on) return "Ghost isn't recording.";
        const started = this.host.capture.recording().startedAt ?? Date.now();
        const path = await this.host.capture.stopRecording();
        return `Saved the recording (${duration(Date.now() - started)}) to ${path}.`;
      }
      case 'read_file': return this.readFile(String(a.path ?? ''));
      case 'list_folder': return this.listFolder(String(a.path ?? ''));
      case 'write_file': {
        const path = String(a.path);
        if (!isAbsolute(path)) return 'Path must be absolute.';
        await mkdir(dirname(path), { recursive: true });
        await (a.append ? appendFile : writeFile)(path, String(a.content), 'utf8');
        return `${a.append ? 'Appended to' : 'Wrote'} ${path}.`;
      }
      case 'delete_path': {
        const path = String(a.path);
        if (!isAbsolute(path)) return 'Path must be absolute.';
        await this.host.trash(path);
        return `Moved ${path} to the Recycle Bin.`;
      }
      case 'set_reminder': {
        const r = this.reminders.add(String(a.text), { at: a.at, inMinutes: a.in_minutes });
        return `Reminder ${r.id} set for ${new Date(r.due).toLocaleString('en-GB')}.`;
      }
      case 'list_reminders': {
        const list = this.reminders.list();
        return list.length ? list.map(r => `${r.id}: ${new Date(r.due).toLocaleString('en-GB')}: ${r.text}`).join('\n') : 'No reminders pending.';
      }
      case 'cancel_reminder':
        return this.reminders.cancel(String(a.id)) ? 'Cancelled.' : 'No reminder with that id.';
      case 'remember': {
        const f = this.memory.remember(String(a.fact), a.topic as MemoryTopic | undefined);
        return `Remembered (${f.id}).`;
      }
      case 'recall': {
        // Facts and conversation summaries first, then matching lines from past conversations.
        const facts = this.memory.recall(String(a.query), 8);
        const said = this.history?.search(String(a.query), 8) ?? [];
        const parts = [facts.length && `Memory:\n${facts.join('\n')}`, said.length && `From past conversations:\n${said.join('\n')}`].filter(Boolean);
        return parts.length ? parts.join('\n\n') : 'Nothing relevant in memory or past conversations.';
      }
      case 'forget': {
        // A short or empty match would wipe everything that contains it.
        const match = String(a.match ?? '').trim();
        if (match.length < 3) return 'Give the memory id or a few words of the fact to forget.';
        const hits = this.memory.list().filter(f => f.id === match || f.text.toLowerCase().includes(match.toLowerCase()));
        if (hits.length > 5) return `That matches ${hits.length} memories. Use a memory id or more of the fact's words.`;
        const n = this.memory.forget(match);
        return n ? `Forgot ${n} item(s).` : 'Nothing matched.';
      }
      case 'vault_search': return this.vault ? this.vault.search(String(a.query)) : NO_VAULT;
      case 'vault_read': return this.vault ? this.vault.read(String(a.path)) : NO_VAULT;
      case 'vault_write': {
        if (!this.vault) return NO_VAULT;
        const mode = ['create', 'append', 'replace'].includes(String(a.mode)) ? a.mode as 'create' | 'append' | 'replace' : 'append';
        return this.vault.write(String(a.path), String(a.content), mode);
      }
    }
  }

  private async readFile(path: string): Promise<ToolResult> {
    if (!isAbsolute(path)) return 'Path must be absolute.';
    const info = await stat(path).catch(() => null);
    if (!info) return `There's no file at ${path}.`;
    if (info.isDirectory()) return `${path} is a folder; use list_folder.`;
    const mime = IMAGE_TYPES[extname(path).toLowerCase()];
    if (mime) {
      if (this.host.loadImage) {
        const img = await this.host.loadImage(path);
        return { text: `Image ${basename(path)}`, image: { data: img.data.toString('base64'), mime: img.mime } };
      }
      if (info.size > MAX_RAW_IMAGE) return `${basename(path)} is too large to look at (${Math.round(info.size / 1e6)} MB).`;
      return { text: `Image ${basename(path)}`, image: { data: (await readFile(path)).toString('base64'), mime } };
    }
    // Text only: a binary file (a program, an archive…) has NUL bytes near the start.
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(info.size, MAX_TEXT * 4));
      await handle.read(buf, 0, buf.length, 0);
      if (buf.subarray(0, 8000).includes(0)) return `${basename(path)} isn't a text file, so it can't be read here.`;
      const text = buf.toString('utf8');
      return text.length > MAX_TEXT || info.size > buf.length ? `${text.slice(0, MAX_TEXT)}\n…(truncated; the file is ${Math.round(info.size / 1000)} KB)` : text;
    } finally { await handle.close(); }
  }

  private async listFolder(path: string): Promise<string> {
    if (!isAbsolute(path)) return 'Path must be absolute.';
    const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
    if (!entries) return `There's no folder at ${path}.`;
    if (!entries.length) return `${path} is empty.`;
    const rows = await Promise.all(entries.slice(0, 200).map(async e => {
      if (e.isDirectory()) return `${e.name}/`;
      const s = await stat(join(path, e.name)).catch(() => null);
      return s ? `${e.name}  (${s.size < 1000 ? `${s.size} B` : `${Math.round(s.size / 1000)} KB`}, ${s.mtime.toISOString().slice(0, 10)})` : e.name;
    }));
    return `${rows.join('\n')}${entries.length > 200 ? `\n…and ${entries.length - 200} more` : ''}`;
  }
}
