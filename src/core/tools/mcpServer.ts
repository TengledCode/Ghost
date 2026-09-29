// Stdio MCP server that the Claude or Antigravity CLI launches as a child process. It holds no logic of its
// own: each tool call is relayed over the local WebSocket to the Ghost core, which applies the
// approval policy and runs it. That keeps one policy for every model backend.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { TOOL_DEFS, TOOL_NAMES } from './definitions';
import type { ClientMessage, CoreMessage } from '../../shared/protocol';
import { parseMessage } from '../../shared/protocol';

const url = process.env.GHOST_CORE_URL ?? 'ws://127.0.0.1:47831';
const token = process.env.GHOST_TOKEN ?? '';
const pending = new Map<string, (r: { ok: boolean; result: string }) => void>();
let socket: Promise<WebSocket> | null = null;

function connect(): Promise<WebSocket> {
  socket ??= new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', token, role: 'mcp' } satisfies ClientMessage)); resolve(ws); });
    ws.on('message', raw => {
      const msg = parseMessage<CoreMessage>(raw);
      if (msg?.type === 'tool_result') { pending.get(msg.id)?.(msg); pending.delete(msg.id); }
    });
    ws.on('error', e => { socket = null; reject(e); });
    ws.on('close', () => {
      socket = null;
      for (const [id, done] of pending) { done({ ok: false, result: 'Ghost core connection closed' }); pending.delete(id); }
    });
  });
  return socket;
}

async function call(tool: string, args: Record<string, unknown>) {
  try {
    const ws = await connect();
    const id = randomUUID();
    const result = await new Promise<{ ok: boolean; result: string }>(resolve => {
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: 'tool_call', id, tool, args } satisfies ClientMessage));
    });
    return { content: [{ type: 'text' as const, text: result.result }], isError: !result.ok };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: `Ghost core unreachable: ${String(e)}` }], isError: true };
  }
}

const server = new McpServer({ name: 'ghost', version: '0.1.0' });
for (const name of TOOL_NAMES) {
  const def = TOOL_DEFS[name];
  server.registerTool(name, { description: def.description, inputSchema: def.shape }, (args: Record<string, unknown>) => call(name, args ?? {}));
}
server.connect(new StdioServerTransport()).catch(e => { console.error(e); process.exit(1); });
