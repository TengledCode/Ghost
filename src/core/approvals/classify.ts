// Decides which Ghost tool calls run straight away and which need Aaron's one-click confirmation.

export type Risk = 'safe' | 'confirm';

const ALWAYS_CONFIRM = new Set(['run_command', 'write_file', 'delete_path', 'close_app', 'vault_write']);
const EXECUTABLE = /\.(exe|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|msi|msix|appx|scr|com|lnk|reg|jar|py)$/i;
const SAFE_SCHEMES = /^(https?:|mailto:)/i;

export function classify(tool: string, args: Record<string, unknown>): Risk {
  if (ALWAYS_CONFIRM.has(tool)) return 'confirm';
  if (tool === 'open_path_or_url') {
    const target = String(args.target ?? '').trim();
    if (SAFE_SCHEMES.test(target)) return 'safe';
    if (/^[a-z][a-z0-9+.-]*:(?!\\|\/\/)/i.test(target) && !/^[a-z]:/i.test(target)) return 'confirm'; // odd protocol handlers
    return EXECUTABLE.test(target) ? 'confirm' : 'safe';
  }
  return 'safe';
}

export function describe(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'run_command': return `Run PowerShell: ${String(args.command ?? '')}`;
    case 'write_file': return `${args.append ? 'Append to' : 'Write'} file ${String(args.path ?? '')}`;
    case 'delete_path': return `Delete ${String(args.path ?? '')} (to the Recycle Bin)`;
    case 'close_app': return `Close ${String(args.name ?? '')}`;
    case 'open_path_or_url': return `Open ${String(args.target ?? '')}`;
    case 'vault_write': {
      const verb = { create: 'Create note', append: 'Add to note', replace: 'Replace note' }[String(args.mode)] ?? 'Write note';
      const content = String(args.content ?? '').replace(/\s+/g, ' ').trim();
      return `${verb} ${String(args.path ?? '')}: ${content.length > 140 ? `${content.slice(0, 140)}…` : content}`;
    }
    default: return `${tool} ${JSON.stringify(args)}`;
  }
}
