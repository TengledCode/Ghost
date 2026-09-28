import type { Provider, ProviderEvent, SendRequest } from './types';
import { classifyError } from './types';
import { commandExists, runCli } from './spawnCli';

// Drives the official Gemini CLI, logged in with Aaron's Google account ("Login with Google").
// Ghost's MCP server and the tool allow-list live in <workspace>/.gemini/settings.json (written by the core).

export function geminiArgs(req: Pick<SendRequest, 'model'>): string[] {
  const args = ['--output-format', 'stream-json'];
  if (req.model) args.push('-m', req.model);
  return args;
}

/** The Gemini CLI has no appendable system prompt and no resumable session id in headless mode,
 *  so the persona and a short rolling transcript go in the prompt itself. */
export function geminiPrompt(persona: string, history: string, prompt: string): string {
  return [`<instructions>\n${persona}\n</instructions>`, history && `<recent_conversation>\n${history}\n</recent_conversation>`, prompt]
    .filter(Boolean)
    .join('\n\n');
}

export class GeminiStreamParser {
  private text = '';
  private tools = new Map<string, string>();

  parse(line: string): ProviderEvent[] {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return []; }
    switch (msg.type) {
      case 'init':
        return msg.session_id ? [{ type: 'session', sessionId: String(msg.session_id) }] : [];
      case 'message':
        if (msg.role !== 'assistant' || typeof msg.content !== 'string') return [];
        this.text += msg.content;
        return [{ type: 'text_delta', text: msg.content }];
      case 'tool_use': {
        const name = String(msg.tool_name ?? 'tool');
        this.tools.set(String(msg.tool_id), name);
        return [{ type: 'tool_start', name }];
      }
      case 'tool_result':
        return [{ type: 'tool_end', name: this.tools.get(String(msg.tool_id)) ?? 'tool' }];
      case 'error': {
        const message = String(msg.message ?? 'Gemini error');
        return msg.severity === 'warning' ? [] : [{ type: 'error', message, kind: classifyError(message) }];
      }
      case 'result':
        if (msg.status && msg.status !== 'success') {
          const message = String(msg.error?.message ?? msg.status);
          return [{ type: 'error', message, kind: classifyError(message) }];
        }
        return [{ type: 'done', text: this.text }];
      default:
        return [];
    }
  }
}

export class GeminiCliProvider implements Provider {
  readonly id = 'gemini' as const;
  private history: string[] = [];
  constructor(private readonly command = 'gemini') {}

  isAvailable(): Promise<boolean> { return commandExists(this.command); }

  resetHistory(): void { this.history = []; }

  /** Restore recent context after a restart (lines like "Aaron: …" / "Ghost: …"). */
  seedHistory(lines: string[]): void { this.history = lines.slice(-12); }

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    const stdin = geminiPrompt(req.persona, this.history.join('\n'), req.prompt);
    const run = runCli(this.command, geminiArgs(req), { stdin, cwd: req.workspace, signal: req.signal });
    const parser = new GeminiStreamParser();
    let finished = false;
    let reply = '';
    for await (const line of run.lines) {
      for (const ev of parser.parse(line)) {
        if (ev.type === 'done') { finished = true; reply = ev.text; }
        if (ev.type === 'error') finished = true;
        yield ev;
      }
    }
    const code = await run.exit;
    if (!finished && !req.signal.aborted) {
      const message = run.stderr().trim() || `gemini exited with code ${code}`;
      yield { type: 'error', message, kind: classifyError(message) };
    }
    if (reply) {
      const userLine = req.prompt.split('</context>').pop()!.trim();
      this.history.push(`Aaron: ${userLine}`, `Ghost: ${reply}`);
      this.history = this.history.slice(-12);
    }
  }
}
