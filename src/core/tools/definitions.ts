import { z } from 'zod';

// Everything Ghost can do on the PC. The MCP bridge advertises these to the model, and the core
// executes them after the approval gate (see approvals/classify.ts).
export const TOOL_DEFS = {
  get_datetime: { description: "Get the current local date, time and time zone of Aaron's PC.", shape: {} },
  open_app: {
    description: 'Launch an installed application by its common name (e.g. "notepad", "spotify", "discord", "steam").',
    shape: { name: z.string().describe('Application name as it appears in the Start menu') },
  },
  open_path_or_url: {
    description: 'Open a web URL in the default browser, or a file/folder with its default app.',
    shape: { target: z.string().describe('An https:// URL or an absolute Windows path') },
  },
  list_windows: { description: 'List the visible application windows (process name and title).', shape: {} },
  focus_window: {
    description: 'Bring a window to the front by (part of) its title.',
    shape: { title: z.string() },
  },
  close_app: {
    description: 'Politely close an application (asks it to close its main window). Requires confirmation.',
    shape: { name: z.string().describe('Process name, e.g. "notepad"') },
  },
  run_command: {
    description: 'Run a PowerShell command and return its output. Always requires Aaron\'s confirmation. Prefer the specific tools when one fits.',
    shape: { command: z.string(), reason: z.string().describe('One short line explaining why, shown on the confirm card') },
  },
  write_file: {
    description: 'Create, overwrite or append to a text file. Requires confirmation.',
    shape: { path: z.string().describe('Absolute path'), content: z.string(), append: z.boolean().optional() },
  },
  delete_path: {
    description: 'Move a file or folder to the Recycle Bin. Requires confirmation.',
    shape: { path: z.string().describe('Absolute path') },
  },
  set_reminder: {
    description: 'Schedule a spoken reminder. Give in_minutes for relative times, or at as an ISO 8601 local timestamp with offset.',
    shape: { text: z.string().describe('What to say when it fires'), in_minutes: z.number().optional(), at: z.string().optional() },
  },
  list_reminders: { description: 'List pending reminders.', shape: {} },
  cancel_reminder: { description: 'Cancel a reminder by id.', shape: { id: z.string() } },
  remember: {
    description: 'Store a lasting fact about Aaron (preferences, people, plans, routines). Keep it short and self-contained.',
    shape: { fact: z.string() },
  },
  recall: { description: 'Search long-term memory.', shape: { query: z.string() } },
  forget: { description: 'Delete memories by id or matching text.', shape: { match: z.string() } },
} as const;

export type ToolName = keyof typeof TOOL_DEFS;
export const TOOL_NAMES = Object.keys(TOOL_DEFS) as ToolName[];
