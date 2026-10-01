// Decides which Ghost tool calls run straight away and which need Aaron's one-click confirmation.
import { extname, isAbsolute, win32 } from 'node:path';
import { isInside } from '../tools/fileAccess';

export type Risk = 'safe' | 'confirm';

export interface RiskContext {
  /** Folders Ghost may read without asking (see tools/fileAccess.ts). */
  safeReadRoots: string[];
}

const ALWAYS_CONFIRM = new Set(['run_command', 'write_file', 'delete_path', 'close_app', 'vault_write']);
const SAFE_SCHEMES = /^(https?:|mailto:)/i;
// Files that open as a document, picture, video or archive in their default app. Anything else
// (programs, scripts, shortcuts, installers, Office files with macros, disk images…) asks first.
const SAFE_TO_OPEN = new Set([
  '.txt', '.md', '.pdf', '.csv', '.log', '.json', '.rtf', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.svg', '.tif', '.tiff',
  '.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.mp4', '.mov', '.mkv', '.webm', '.avi', '.wmv',
  '.zip', '.7z', '.rar',
]);

export function classify(tool: string, args: Record<string, unknown>, ctx: RiskContext = { safeReadRoots: [] }): Risk {
  if (ALWAYS_CONFIRM.has(tool)) return 'confirm';
  switch (tool) {
    case 'open_path_or_url': {
      const target = String(args.target ?? '').trim();
      if (SAFE_SCHEMES.test(target)) return 'safe';
      if (/^\\\\|^\/\//.test(target) || !(isAbsolute(target) || win32.isAbsolute(target))) return 'confirm'; // network shares, other protocols
      const ext = extname(target).toLowerCase();
      return ext === '' || SAFE_TO_OPEN.has(ext) ? 'safe' : 'confirm'; // no extension: a folder
    }
    case 'open_app': {
      // A plain app name ("spotify") is looked up in the Start menu. A path or protocol could start anything.
      const name = String(args.name ?? '').trim();
      return /[\\/:]|\.(exe|bat|cmd|ps1|vbs|js|msi|lnk|scr|com|hta)$/i.test(name) ? 'confirm' : 'safe';
    }
    case 'read_file':
    case 'list_folder':
      return isInside(String(args.path ?? ''), ctx.safeReadRoots) ? 'safe' : 'confirm';
    default:
      return 'safe';
  }
}

export function describe(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'run_command': return `Run PowerShell: ${String(args.command ?? '')}`;
    case 'write_file': return `${args.append ? 'Append to' : 'Write'} file ${String(args.path ?? '')}`;
    case 'delete_path': return `Delete ${String(args.path ?? '')} (to the Recycle Bin)`;
    case 'close_app': return `Close ${String(args.name ?? '')}`;
    case 'open_path_or_url': return `Open ${String(args.target ?? '')}`;
    case 'open_app': return `Start ${String(args.name ?? '')}`;
    case 'read_file': return `Read ${String(args.path ?? '')}`;
    case 'list_folder': return `Look inside ${String(args.path ?? '')}`;
    case 'vault_write': {
      const verb = { create: 'Create note', append: 'Add to note', replace: 'Replace note' }[String(args.mode)] ?? 'Write note';
      const content = String(args.content ?? '').replace(/\s+/g, ' ').trim();
      return `${verb} ${String(args.path ?? '')}: ${content.length > 140 ? `${content.slice(0, 140)}…` : content}`;
    }
    default: return `${tool} ${JSON.stringify(args)}`;
  }
}
