#!/usr/bin/env node
// Stands in for `claude -p --input-format stream-json`: answers each user message with its text
// echoed back, handles set_model and interrupt control requests, and logs each launch.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
let model = arg('--model') ?? 'default';
const session = arg('--resume') ?? `s-${process.pid}`;
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `launch ${arg('--resume') ?? '-'}\n`);
const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
let pending = null; // a slow reply that can be interrupted

createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_request') {
    if (msg.request.subtype === 'set_model') model = msg.request.model;
    if (msg.request.subtype === 'interrupt' && pending) {
      clearTimeout(pending);
      pending = null;
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session });
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    return;
  }
  const text = String(msg.message.content);
  out({ type: 'system', subtype: 'init', session_id: session, model });
  if (text === 'die') process.exit(1);
  const reply = () => {
    pending = null;
    const answer = `[${model}] ${text}`;
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: answer } }, session_id: session });
    out({ type: 'result', subtype: 'success', result: answer, session_id: session });
  };
  if (text.startsWith('slow')) pending = setTimeout(reply, 3000);
  else reply();
});
