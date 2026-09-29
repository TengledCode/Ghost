import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Antigravity (`agy`) gets Ghost's tools, and its safety rules, from a plugin in a folder passed with
// `--add-dir`: <root>/.agents/plugins/ghost/{plugin.json, mcp_config.json, hooks.json}.
//
// In headless mode agy can't ask permission, so it runs with --dangerously-skip-permissions and a
// PreToolUse hook decides every tool call instead: reading, web lookups and Ghost's own MCP tools
// (which apply Ghost's confirm-risky policy) are allowed; running commands, writing files, the
// browser and everything else are refused. A hook that fails to run is a tool error, so it fails
// closed, and a PreInvocation hook leaves a marker file that proves the hooks are loaded.

export const PLUGIN = 'ghost';
/** agy names plugin MCP servers `<plugin>_<server>`. */
export const GHOST_SERVER = `${PLUGIN}_ghost`;

export interface AgyPaths {
  root: string; // passed with --add-dir
  plugin: string;
  workspace: string; // agy's working folder, holding GEMINI.md (the persona)
  marker: string; // written by the PreInvocation hook
}

export function agyPaths(dir: string): AgyPaths {
  const root = join(dir, 'root');
  const plugin = join(root, '.agents', 'plugins', PLUGIN);
  return { root, plugin, workspace: join(dir, 'workspace'), marker: join(plugin, 'hooks.loaded') };
}

/**
 * The PreToolUse decision. Self-contained (it is copied into hook.js as source), so no imports or
 * outside names.
 */
export function agyHookDecision(call: { name?: unknown; args?: Record<string, unknown> }): { decision: 'allow' | 'deny'; reason?: string } {
  const allowed = ['view_file', 'list_dir', 'grep_search', 'find_by_name', 'read_resource', 'list_resources', 'search_web', 'read_url_content', 'finish', 'wait', 'wait_5_seconds'];
  const name = String(call.name ?? '');
  const server = String((call.args ?? {}).ServerName ?? '');
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
  windows?: boolean;
}

/** Write (or refresh) the plugin: Ghost's MCP server plus the permission hooks. */
export function writeAgyPlugin(paths: AgyPaths, o: AgyPluginOptions): void {
  const win = o.windows ?? process.platform === 'win32';
  mkdirSync(paths.plugin, { recursive: true });
  mkdirSync(paths.workspace, { recursive: true });
  const file = (name: string, content: string) => writeFileSync(join(paths.plugin, name), content);

  file('plugin.json', JSON.stringify({ name: PLUGIN }, null, 2));
  file('mcp_config.json', JSON.stringify({
    mcpServers: { ghost: { command: o.nodeExecPath, args: [o.mcpServerPath], env: { ELECTRON_RUN_AS_NODE: '1', ...o.env } } },
  }, null, 2));

  file('hook.js', `// Ghost's permission hook for Antigravity (generated; see src/core/providers/agyPlugin.ts).
const decide = ${agyHookDecision.toString()};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => (input += c));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(input); } catch {}
  process.stdout.write(JSON.stringify(decide(payload.toolCall || {})));
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
      const path = join(paths.plugin, `${script}.cmd`);
      writeFileSync(path, `@set ELECTRON_RUN_AS_NODE=1\r\n@"${o.nodeExecPath}" "%~dp0${script}.js"\r\n`);
      return path;
    }
    const path = join(paths.plugin, `${script}.sh`);
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
- You may read files and images (view_file), search the web (search_web) and read pages (read_url_content).
`);
}

/** Pick a model id from `agy models` for a family hint ('flash' / 'pro'). Empty when none matches. */
export function pickAgyModel(ids: string[], hint: string): string {
  if (!hint) return '';
  const version = (id: string) => Number(id.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const effortRank = (id: string) => {
    const order = hint === 'pro' ? ['high', 'medium', 'low'] : ['medium', 'high', 'low'];
    const i = order.findIndex(e => id.endsWith(`-${e}`));
    return i < 0 ? order.length : i;
  };
  const candidates = [...new Set(ids)].filter(id => id.startsWith('gemini-') && id.includes(`-${hint}`) && !/lite|image|tts|embed/.test(id));
  candidates.sort((a, b) => version(b) - version(a) || effortRank(a) - effortRank(b));
  return candidates[0] ?? '';
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

/** "gemini-3.8-flash-high" → "Gemini 3.8 Flash (high)", "claude-opus-4-6-thinking" → "Claude Opus 4.6 (thinking)". */
export function agyModelLabel(id: string): string {
  const parts = id.split('-');
  const suffix = /^(low|medium|high|thinking|max|minimal)$/.test(parts.at(-1) ?? '') ? parts.pop() : undefined;
  const words: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    // Claude's versions come as separate numbers ("4-6" → "4.6").
    if (/^\d+$/.test(p) && /^\d+$/.test(parts[i + 1] ?? '')) { words.push(`${p}.${parts[++i]}`); continue; }
    words.push(p === 'gpt' || p === 'oss' ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1));
  }
  const name = words.join(' ').replace('GPT OSS', 'GPT-OSS');
  return suffix ? `${name} (${suffix})` : name;
}
