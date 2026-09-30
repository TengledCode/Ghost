// Telling a quick command ("open notepad", "remind me in 10") from a real exchange, so only real
// conversations become notes in Obsidian. Commands are still kept for the day, as a line in the
// Daily Note ("Opened Spotify, set a reminder: stretch").

/** Ghost tools that act or answer at a glance, rather than start a discussion. */
const QUICK_TOOLS = new Set([
  'open_app', 'open_path_or_url', 'focus_window', 'close_app', 'list_windows',
  'set_reminder', 'list_reminders', 'cancel_reminder', 'remember', 'forget', 'get_datetime',
]);

const SMALL_TALK = /^(hi|hey|hello|yo|thanks|thank you|cheers|ok|okay|cool|great|nice|good (morning|afternoon|evening|night)|bye|goodnight)\b[\s!.,]*(ghost)?[\s!.,]*$/i;

/** A turn that is only an instruction carried out, or small talk, with a short reply. */
export function isCommandTurn(message: string, tools: string[], actions: string[], reply: string): boolean {
  const words = reply.trim().split(/\s+/).filter(Boolean).length;
  if (words > 25 || reply.includes('?')) return false;
  if (SMALL_TALK.test(message.trim())) return true;
  const bare = tools.map(t => t.replace(/^mcp__ghost__/, ''));
  return actions.length > 0 && bare.length > 0 && bare.every(t => QUICK_TOOLS.has(t));
}

/** How an action reads in the Daily Note, or null for tools that don't change anything. */
export function actionLabel(tool: string, args: Record<string, unknown>): string | null {
  const a = (k: string) => String(args[k] ?? '').trim();
  switch (tool) {
    case 'open_app': return `opened ${a('name')}`;
    case 'open_path_or_url': return `opened ${a('target')}`;
    case 'focus_window': return `switched to ${a('title')}`;
    case 'close_app': return `closed ${a('name')}`;
    case 'set_reminder': return `set a reminder: ${a('text')}`;
    case 'cancel_reminder': return 'cancelled a reminder';
    case 'remember': return `noted "${a('fact')}"`;
    case 'forget': return `forgot "${a('match')}"`;
    case 'run_command': return `ran \`${a('command').slice(0, 60)}\``;
    case 'write_file': return `wrote ${a('path')}`;
    case 'delete_path': return `deleted ${a('path')}`;
    case 'vault_write': return `${{ create: 'created', append: 'added to', replace: 'replaced' }[a('mode')] ?? 'wrote'} [[${a('path').replace(/\.md$/, '')}]]`;
    default: return null;
  }
}
