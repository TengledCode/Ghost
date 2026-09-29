#!/usr/bin/env node
// Stands in for Antigravity's `agy` in stream-json mode, speaking the event shapes recorded from
// agy 1.2.7 on Windows (init / step_update / result). It runs the plugin's hooks the way agy does:
// PreInvocation before each model call, PreToolUse before each tool.
//   message "slow…"           → answers after 3 s (so it can be interrupted)
//   message "tool:<name>[:<server>]" → attempts that tool, then reports whether the hook allowed it
//   anything else             → "[<model>] <message>"
// Env: FAKE_AGY_LOG (launch log), FAKE_AGY_STATE (dir of known conversations), FAKE_AGY_LOGGED_OUT.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === 'models') {
  console.log('Fetching available models...\nMODEL\tDESCRIPTION\ngemini-3.8-flash-high\tFast\ngemini-3.8-flash-low\tFaster\ngemini-3.8-pro-high\tDeep\ngemini-3.1-pro-high\tOlder\nclaude-opus-4-6-thinking\tAnthropic');
  process.exit(0);
}
if (process.env.FAKE_AGY_LOGGED_OUT) {
  process.stderr.write('Print mode: not logged in and no controlling terminal; cannot complete interactive login\n');
  process.exit(1);
}
const model = arg('--model') ?? 'default';
const state = process.env.FAKE_AGY_STATE;
if (state) mkdirSync(state, { recursive: true });
const wanted = arg('--conversation');
let id = randomUUID();
if (wanted && state && existsSync(join(state, wanted))) id = wanted;
else if (wanted) process.stderr.write(`warning: conversation "${wanted}" not found\n`);
if (state) writeFileSync(join(state, id), '');
if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `launch model=${model} conversation=${wanted ?? '-'}\n`);

// The plugin's hooks, found under --add-dir like agy does.
const root = arg('--add-dir');
const hooks = { PreToolUse: [], PreInvocation: [] };
if (root && existsSync(join(root, '.agents', 'plugins'))) {
  for (const p of readdirSync(join(root, '.agents', 'plugins'))) {
    const file = join(root, '.agents', 'plugins', p, 'hooks.json');
    if (!existsSync(file)) continue;
    for (const group of Object.values(JSON.parse(readFileSync(file, 'utf8')))) {
      for (const h of group.PreToolUse ?? []) hooks.PreToolUse.push(...h.hooks.map(x => x.command));
      for (const h of group.PreInvocation ?? []) hooks.PreInvocation.push(h.command);
    }
  }
}
const runHook = (command, input) => {
  const r = spawnSync('sh', ['-c', `"${command}"`], { input: JSON.stringify(input), encoding: 'utf8' });
  if (r.status !== 0) return { decision: 'deny', reason: `hook failed: ${r.stderr}` };
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
};

const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
out({ event: 'init', conversation_id: id, init: { cwd: process.cwd(), tools: ['view_file', 'run_command', 'call_mcp_tool'], permission_mode: args.includes('--dangerously-skip-permissions') ? 'always-proceed' : 'request-review', ...(arg('--model') ? { model } : {}) } });

let step = 0;
let pending = null;
const step_update = s => out({ event: 'step_update', step_update: { conversation_id: id, ...s } });
const say = text => {
  const i = step++;
  const parts = text.match(/.{1,6}/gs);
  parts.forEach((p, k) => step_update({ step_index: i, state: k === parts.length - 1 ? 'DONE' : 'ACTIVE', step_type: 'agent_response', text_delta: p }));
  out({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: text, num_turns: 1 } });
};

createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.event !== 'user') { process.stderr.write('error: stream input message is missing the "event" field\n'); process.exit(1); }
  const text = String(msg.message.content);
  step_update({ step_index: step++, state: 'DONE', step_type: 'user_input' });
  for (const h of hooks.PreInvocation) runHook(h, { conversationId: id });
  const tool = text.split('\n').pop().match(/^tool:(\w+)(?::(\w+))?$/);
  if (tool) {
    const [, name, server] = tool;
    const params = server ? { ServerName: server, ToolName: 'open_app', Arguments: {} } : { CommandLine: 'Get-Date' };
    const i = step++;
    step_update({ step_index: i, state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: { name, parameters: params } });
    let verdict = { decision: 'allow' };
    for (const h of hooks.PreToolUse) { verdict = runHook(h, { toolCall: { name, args: params }, conversationId: id }); if (verdict.decision !== 'allow') break; }
    const ok = verdict.decision === 'allow';
    step_update({ step_index: i, state: ok ? 'DONE' : 'ERROR', step_type: 'tool', tool_name: name, tool_info: ok ? { name, output: 'done' } : { name, error: { type: 'TOOL_ERROR', message: `tool call denied by pre-tool hook: ${verdict.reason}` } } });
    say(ok ? `${name} allowed.` : `${name} denied.`);
  } else if (text.includes('slow')) {
    pending = setTimeout(() => say(`[${model}] ${text}`), 3000);
  } else {
    say(`[${model}] ${text}`);
  }
});
