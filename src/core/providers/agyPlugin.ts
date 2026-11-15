import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SENSITIVE, type SensitiveLists } from '../tools/fileAccess';

// Antigravity (`agy`) gets Ghost's tools, and its safety rules, from a plugin in a folder passed with
// `--add-dir`: <root>/.agents/plugins/ghost/{plugin.json, mcp_config.json, hooks.json}.
//
// In headless mode agy can't ask permission, so it runs with --dangerously-skip-permissions and a
// PreToolUse hook decides every tool call instead: reading, web lookups and Ghost's own MCP tools
// (which apply Ghost's confirm-risky policy) are allowed; running commands, writing files, the
// browser and everything else are refused. A hook that fails to run is a tool error, so it fails
// closed, and a PreInvocation hook leaves a marker file that proves the hooks are loaded.
//
// One-shot calls (filing a conversation, researching models) get a plugin folder of their own with
// the same hook in a stricter mode: no tools at all, or web search only.

export const PLUGIN = 'ghost';
/** agy names plugin MCP servers `<plugin>_<server>`. */
export const GHOST_SERVER = `${PLUGIN}_ghost`;

/** What a call may use: Ghost's tools and agy's reading tools, nothing at all, or web search only. */
export type AgyHookMode = 'full' | 'none' | 'web';

export interface AgyPluginDir {
  root: string; // passed with --add-dir
  plugin: string;
  marker: string; // written by the PreInvocation hook
}

export interface AgyPaths extends AgyPluginDir {
  workspace: string; // agy's working folder, holding GEMINI.md (the persona)
  noTools: AgyPluginDir; // for one-shot calls: every tool refused
  webOnly: AgyPluginDir; // for one-shot research: web search only
}

function pluginDir(root: string): AgyPluginDir {
  const plugin = join(root, '.agents', 'plugins', PLUGIN);
  return { root, plugin, marker: join(plugin, 'hooks.loaded') };
}

export function agyPaths(dir: string): AgyPaths {
  return { ...pluginDir(join(dir, 'root')), workspace: join(dir, 'workspace'), noTools: pluginDir(join(dir, 'root-no-tools')), webOnly: pluginDir(join(dir, 'root-web')) };
}

/**
 * The PreToolUse decision. Self-contained (it is copied into hook.js as source), so no imports or
 * outside names. agy's own file tools may only look inside `safeRoots` (Ghost's folders, the vault,
 * Desktop, Documents, Downloads); anywhere else the model must use Ghost's read_file, which asks Aaron.
 *
 * Anything not named here is refused, so a tool agy adds or renames stops working rather than
 * slipping through. (Its 11 Nov 2026 update replaced view_file / list_dir / grep_search /
 * find_by_name with read_file, dropped read_url_content, and added subagents, schedules and more.)
 */
export function agyHookDecision(
  call: { name?: unknown; args?: Record<string, unknown> }, safeRoots: string[] = [], ownDir?: unknown, mode: AgyHookMode = 'full',
  // Folders that always ask even inside a safe one, and the names and types that look private (see tools/fileAccess.ts).
  extra: { cardRoots?: string[]; sensitive?: SensitiveLists } = {},
): { decision: 'allow' | 'deny'; reason?: string } {
  const name = String(call.name ?? '');
  // One-shot calls: no tools (filing a conversation), or web search only (researching models).
  if (mode === 'none') return { decision: 'deny', reason: 'this call has no tools. Answer from the text you were given.' };
  if (mode === 'web') return name === 'search_web' ? { decision: 'allow' } : { decision: 'deny', reason: `${name} is not available in this call: only search_web is.` };
  const allowed = ['read_resource', 'list_resources', 'search_web', 'read_url_content', 'finish', 'wait', 'wait_5_seconds'];
  const fileTools = ['read_file', 'view_file', 'list_dir', 'grep_search', 'find_by_name']; // read_file: agy today; the rest: before its 11 Nov 2026 update
  const args = call.args ?? {};
  const server = String(args.ServerName ?? '');
  if (fileTools.includes(name)) {
    // agy keeps long tool results in the current conversation's own folder (…/antigravity-cli/brain/<id>,
    // given to the hook as artifactDirectoryPath) and reads them back: that folder only, never older
    // conversations' ones.
    const own = typeof ownDir === 'string' && /[\\/]antigravity-cli[\\/]brain[\\/][0-9a-f-]{36}[\\/]?$/i.test(ownDir) ? [ownDir] : [];
    // Paths compared with forward slashes, drive paths in lower case. (No named helper functions in
    // here: the bundler would wrap them in a helper that doesn't exist once this is copied to hook.js.)
    const roots = [...safeRoots, ...own].map(r => r.replace(/\\/g, '/').replace(/\/+$/, '')).map(r => (/^[a-zA-Z]:/.test(r) ? r.toLowerCase() : r));
    const cards = (extra.cardRoots ?? []).map(r => r.replace(/\\/g, '/').replace(/\/+$/, '')).map(r => (/^[a-zA-Z]:/.test(r) ? r.toLowerCase() : r));
    const lists = extra.sensitive;
    const values = Object.values(args).flatMap(v => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string');
    for (const v of values) {
      const slashed = v.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      const p = /^[a-zA-Z]:/.test(slashed) ? slashed.toLowerCase() : slashed;
      const looksLikePath = /^[a-zA-Z]:/.test(p) || p.startsWith('/'); // C:\…, a bare C:, /…, \\server
      const climbs = /(^|\/)\.\.(\/|$)/.test(p);
      // A path that would only become one later (~, %USERPROFILE%, $HOME, file://…) can't be checked here.
      const indirect = /^(~|file:|%[^%/]+%|\$(env:|\{|[a-z_]))/i.test(p);
      // Inside a folder that always asks (the vault while reading notes is off), unless a safe folder within it holds the path.
      const asks = cards.some(c => (p === c || p.startsWith(`${c}/`)) && !roots.some(r => (r === c || r.startsWith(`${c}/`)) && (p === r || p.startsWith(`${r}/`))));
      if (climbs || indirect || asks || (looksLikePath && !roots.some(r => p === r || p.startsWith(`${r}/`)))) {
        return { decision: 'deny', reason: `${v} is outside the folders Ghost reads freely. Use read_file or list_folder on the ghost_ghost MCP server (call_mcp_tool); Aaron confirms those.` };
      }
      // A private-looking name or type (the same lists as Ghost's own read_file: looksSensitive in tools/fileAccess.ts).
      const looksPrivate = !!lists && looksLikePath && p.toLowerCase().split('/').some(part => {
        if (!part) return false;
        if (lists.names.includes(part) || part.startsWith('.env')) return true;
        if (part.includes('.') && lists.types.includes(part.slice(part.lastIndexOf('.') + 1))) return true;
        const squeezed = part.replace(/[^a-z0-9]+/g, '');
        if (lists.anywhere.some(w => squeezed.includes(w))) return true;
        const words = part.split(/[^a-z0-9]+/).filter(Boolean);
        return words.some((w, i) => lists.words.includes(w) || lists.words.includes(w + (words[i + 1] ?? '')));
      });
      if (looksPrivate) return { decision: 'deny', reason: `${v} looks private by its name. Use read_file or list_folder on the ghost_ghost MCP server (call_mcp_tool); Aaron confirms those.` };
    }
    return { decision: 'allow' };
  }
  // Resources: Ghost's own server only (it has none today), never another MCP server's.
  if ((name === 'read_resource' || name === 'list_resources') && server && server !== 'ghost_ghost') return { decision: 'deny', reason: `only Ghost's own MCP server (ghost_ghost) may be used, not ${server}.` };
  if (allowed.includes(name)) return { decision: 'allow' };
  if (name === 'call_mcp_tool' && server === 'ghost_ghost') return { decision: 'allow' };
  const why = name === 'call_mcp_tool'
    ? `only Ghost's own tools (MCP server ghost_ghost) may be used, not ${server || 'this server'}.`
    : `${name} is not available to Ghost. Use Ghost's tools on the ghost_ghost MCP server (call_mcp_tool) for any action on the PC.`;
  return { decision: 'deny', reason: why };
}

export interface AgyPluginOptions {
  nodeExecPath: string; // Electron (run as node) or node
  mcpServerPath: string;
  env: Record<string, string>; // GHOST_CORE_URL, GHOST_TOKEN
  safeReadRoots?: string[]; // where agy's own file tools may look (see agyHookDecision)
  cardRoots?: string[]; // folders that always ask, even inside a safe one
  windows?: boolean;
}

/** Write (or refresh) the plugins: Ghost's MCP server plus the permission hooks, and the two stricter ones for one-shot calls. */
export function writeAgyPlugin(paths: AgyPaths, o: AgyPluginOptions): void {
  mkdirSync(paths.workspace, { recursive: true });
  writePluginDir(paths, o, 'full');
  writePluginDir(paths.noTools, o, 'none');
  writePluginDir(paths.webOnly, o, 'web');
}

function writePluginDir(dir: AgyPluginDir, o: AgyPluginOptions, mode: AgyHookMode): void {
  const win = o.windows ?? process.platform === 'win32';
  mkdirSync(dir.plugin, { recursive: true });
  const file = (name: string, content: string) => writeFileSync(join(dir.plugin, name), content);

  file('plugin.json', JSON.stringify({ name: PLUGIN }, null, 2));
  // Ghost's tools go to the conversation itself, never to a one-shot call.
  if (mode === 'full') {
    file('mcp_config.json', JSON.stringify({
      mcpServers: { ghost: { command: o.nodeExecPath, args: [o.mcpServerPath], env: { ELECTRON_RUN_AS_NODE: '1', ...o.env } } },
    }, null, 2));
  }

  file('hook.js', `// Ghost's permission hook for Antigravity (generated; see src/core/providers/agyPlugin.ts).
const decide = ${agyHookDecision.toString()};
const SAFE_ROOTS = ${JSON.stringify(mode === 'full' ? o.safeReadRoots ?? [] : [])};
const MODE = ${JSON.stringify(mode)};
const EXTRA = ${JSON.stringify(mode === 'full' ? { cardRoots: o.cardRoots ?? [], sensitive: SENSITIVE } : {})};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (input += c));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(input); } catch {}
  process.stdout.write(JSON.stringify(decide(payload.toolCall || {}, SAFE_ROOTS, payload.artifactDirectoryPath, MODE, EXTRA)));
});
`);
  file('preinvoke.js', `// Proves to Ghost that its hooks are loaded (generated).
require('node:fs').writeFileSync(require('node:path').join(__dirname, 'hooks.loaded'), new Date().toISOString());
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('{}'));
`);

  // agy runs hook commands through cmd /c on Windows, which mangles a quoted exe path, so each hook
  // command is the absolute path of a small wrapper script.
  const wrapper = (script: string) => {
    if (win) {
      const path = join(dir.plugin, `${script}.cmd`);
      writeFileSync(path, `@set ELECTRON_RUN_AS_NODE=1\r\n@"${o.nodeExecPath}" "%~dp0${script}.js"\r\n`);
      return path;
    }
    const path = join(dir.plugin, `${script}.sh`);
    writeFileSync(path, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${o.nodeExecPath}" "$(dirname "$0")/${script}.js"\n`);
    chmodSync(path, 0o755);
    return path;
  };
  file('hooks.json', JSON.stringify({
    'ghost-permissions': {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: wrapper('hook'), timeout: 10 }] }],
      PreInvocation: [{ type: 'command', command: wrapper('preinvoke'), timeout: 10 }],
    },
  }, null, 2));
}

/** agy has no system-prompt flag: it reads GEMINI.md from its working folder. */
export function writeAgyPersona(paths: AgyPaths, persona: string): void {
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'GEMINI.md'), `${persona}

## Your tools in this app

- Everything you do on the PC goes through the MCP server \`${GHOST_SERVER}\` (call it with call_mcp_tool). It holds open_app, set_reminder, remember, recall, run_command and the rest.
- Your own command, file-writing and browser tools are switched off here. Don't try them; use the \`${GHOST_SERVER}\` tools instead.
- You may search the web (search_web).
- Your own file tool (read_file) works in Ghost's folders, the Obsidian vault, Desktop, Documents and Downloads. For anywhere else, and to list a folder, use read_file or list_folder on \`${GHOST_SERVER}\`; Aaron confirms those outside these folders.
`);
}

/** Gemini model ids mentioned in `agy models` output. */
export function parseAgyModels(output: string): string[] {
  return parseAgyCatalog(output).filter(id => id.startsWith('gemini-'));
}

/**
 * Every model id in `agy models` output: the first column of each table row that looks like an id
 * (lowercase words joined by dashes, e.g. gemini-3.8-flash-high, claude-opus-4-6-thinking, gpt-oss-120b-medium).
 */
export function parseAgyCatalog(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const first = line.trim().split(/\s+/)[0] ?? '';
    for (const id of first.includes('-') ? [first] : line.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9.]+)+\b/g) ?? []) {
      if (/^[a-z][a-z0-9]*(?:-[a-z0-9.]+)+$/.test(id) && /\d/.test(id) && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export { modelLabel as agyModelLabel } from '../../shared/modelLabel';
