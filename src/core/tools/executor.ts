import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import type { ConversationLog } from '../memory/conversations';
import type { MemoryStore } from '../memory/store';
import type { ReminderScheduler } from '../reminders/scheduler';
import type { ToolName } from './definitions';

/** Host hooks, injected so the executor can be tested without Electron. */
export interface Host {
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<string>; // returns '' on success, error text otherwise
  trash(path: string): Promise<void>;
}

const isWin = process.platform === 'win32';
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
    private readonly memory: MemoryStore,
    private readonly reminders: ReminderScheduler,
    private readonly history?: Pick<ConversationLog, 'search'>,
  ) {}

  async run(tool: ToolName, a: Record<string, any>): Promise<string> {
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
        const f = this.memory.remember(String(a.fact));
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
        const n = this.memory.forget(String(a.match));
        return n ? `Forgot ${n} item(s).` : 'Nothing matched.';
      }
    }
  }
}
