import type { Provider, ProviderEvent, SendRequest } from './types';
import { classifyError } from './types';
import { commandExists, runCli } from './spawnCli';

// Drives the official Claude Code CLI, logged in with Aaron's Pro/Max subscription (`claude` then /login).
// No API key is involved: usage counts against the same plan limits as claude.ai.

export const CLAUDE_BUILTIN_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'];

export function claudeArgs(req: Pick<SendRequest, 'model' | 'personaFile' | 'sessionId' | 'mcpConfigPath'>): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt-file', req.personaFile,
    '--mcp-config', req.mcpConfigPath,
    '--strict-mcp-config',
    // Built-ins are limited to read-only and web tools. Every side effect goes through Ghost's own MCP
    // tools, which enforce the confirm-risky policy.
    '--tools', CLAUDE_BUILTIN_TOOLS.join(','),
    '--allowedTools', [...CLAUDE_BUILTIN_TOOLS, 'mcp__ghost'].join(','),
  ];
  if (req.model) args.push('--model', req.model);
  if (req.sessionId) args.push('--resume', req.sessionId);
  return args;
}

/** Stateful parser for `claude -p --output-format stream-json` NDJSON lines. */
export class ClaudeStreamParser {
  private sawPartial = false;
  private openTools = new Map<number, string>();
  private text = '';

  parse(line: string): ProviderEvent[] {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return []; }
    const out: ProviderEvent[] = [];
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) out.push({ type: 'session', sessionId: msg.session_id });
        break;
      case 'stream_event': {
        const ev = msg.event ?? {};
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.sawPartial = true;
          this.text += ev.delta.text;
          out.push({ type: 'text_delta', text: ev.delta.text });
        } else if (ev.type === 'content_block_start' && ev.content_block?.type?.endsWith('tool_use')) {
          const name = String(ev.content_block.name ?? 'tool');
          this.openTools.set(ev.index, name);
          out.push({ type: 'tool_start', name });
        } else if (ev.type === 'message_start' && this.text && !/\s$/.test(this.text)) {
          // A new assistant message after a tool call: keep the sentences apart.
          this.text += '\n\n';
          out.push({ type: 'text_delta', text: '\n\n' });
        }
        break;
      }
      case 'assistant': {
        const blocks: any[] = msg.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === 'text' && !this.sawPartial) {
            const sep = this.text && !/\s$/.test(this.text) ? '\n\n' : '';
            this.text += sep + b.text;
            out.push({ type: 'text_delta', text: sep + b.text });
          } else if (b.type === 'tool_use' && !this.sawPartial) {
            out.push({ type: 'tool_start', name: String(b.name) });
          }
        }
        break;
      }
      case 'user': {
        const blocks: any[] = msg.message?.content ?? [];
        for (const b of blocks) if (b.type === 'tool_result') out.push({ type: 'tool_end', name: String(b.tool_use_id ?? 'tool') });
        break;
      }
      case 'result':
        if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
          const message = String(msg.result ?? msg.error ?? msg.subtype ?? 'Claude returned an error');
          out.push({ type: 'error', message, kind: classifyError(message) });
        } else {
          out.push({ type: 'done', text: this.text || String(msg.result ?? ''), sessionId: msg.session_id });
        }
        break;
    }
    return out;
  }
}

export class ClaudeCliProvider implements Provider {
  readonly id = 'claude' as const;
  constructor(private readonly command = 'claude') {}

  isAvailable(): Promise<boolean> { return commandExists(this.command); }

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    const run = runCli(this.command, claudeArgs(req), { stdin: req.prompt, cwd: req.workspace, signal: req.signal });
    const parser = new ClaudeStreamParser();
    let finished = false;
    for await (const line of run.lines) {
      for (const ev of parser.parse(line)) {
        if (ev.type === 'done' || ev.type === 'error') finished = true;
        yield ev;
      }
    }
    const code = await run.exit;
    if (!finished && !req.signal.aborted) {
      const message = run.stderr().trim() || `claude exited with code ${code}`;
      yield { type: 'error', message, kind: classifyError(message) };
    }
  }
}
