import { existsSync, rmSync } from 'node:fs';
import { agyModelLabel, agyPaths, parseAgyCatalog, pickAgyModel, type AgyPaths } from './agyPlugin';
import { commandExists, runCli, spawnLive, type LiveCli } from './spawnCli';
import type { ModelOption, Provider, ProviderEvent, SendRequest } from './types';
import { classifyError } from './types';

// Ghost's Google brain: the Antigravity CLI (`agy`), signed in with Aaron's Google AI Pro account.
// (Google retired Gemini CLI sign-in for personal accounts in June 2026.)
//
// Like the Claude session, one agy process is kept running per conversation: messages go in as
// JSON lines (`--input-format stream-json`) and replies stream back as `step_update` events. agy
// takes 5-6 s to start, so this saves that wait on every message after the first. There's no way
// to interrupt a reply other than ending the process; the next message resumes the conversation
// with `--conversation <id>`. Tools and permissions come from Ghost's plugin (see agyPlugin.ts).

interface AgyLine {
  event?: string;
  conversation_id?: string;
  step_update?: {
    step_index?: number; state?: string; step_type?: string; text_delta?: string; tool_name?: string;
    tool_info?: { parameters?: Record<string, unknown> };
  };
  result?: { status?: string; response?: string; error?: string; conversation_id?: string };
}

const INIT_TIMEOUT_MS = 45_000;
const IDLE_CLOSE_MS = 15 * 60_000;
// Ghost's labels for agy's tools ("Searching the web" while it looks something up).
const TOOL_NAMES: Record<string, string> = { search_web: 'WebSearch', read_url_content: 'WebFetch', view_file: 'Read', list_dir: 'Glob', grep_search: 'Grep', find_by_name: 'Glob' };

export class AntigravityProvider implements Provider {
  readonly id = 'gemini' as const;
  private readonly paths: AgyPaths;
  private readonly command: string;
  private readonly idleCloseMs: number;
  private proc: LiveCli | null = null;
  private model = '';
  private conversationId: string | undefined; // the conversation to continue
  private fresh = true; // the running conversation has none of Ghost's history yet
  private hooksVerified = false;
  private keepWarm = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private init: Promise<boolean> | null = null;
  private handlers: ((line: AgyLine) => void)[] = [];
  private models: Promise<string[]> | null = null;

  constructor(opts: { dir: string; command?: string; idleCloseMs?: number }) {
    this.paths = agyPaths(opts.dir);
    this.command = opts.command ?? 'agy';
    this.idleCloseMs = opts.idleCloseMs ?? IDLE_CLOSE_MS;
  }

  isAvailable(): Promise<boolean> { return commandExists(this.command); }

  /** Start agy ahead of the first message (only when Google is the primary brain). */
  warm(req: Pick<SendRequest, 'model'>): void {
    this.keepWarm = true;
    void this.resolveModel(req.model).then(model => { if (!this.proc) this.start(model); }).catch(() => {});
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.proc?.kill();
    this.proc = null;
    this.init = null;
    this.handlers = [];
  }

  /** A new Ghost conversation: the next message starts a new agy conversation. */
  resetHistory(): void {
    this.stop();
    this.conversationId = undefined;
  }

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    if (req.oneShot) { yield* this.oneShot(req); return; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const model = await this.resolveModel(req.model);
    if (this.proc?.alive() && model !== this.model) this.stop(); // switching model: resume in a new process
    if (!this.proc?.alive()) this.start(model);
    const proc = this.proc!;
    if (!(await this.init)) {
      const message = proc.stderr().trim() || 'Antigravity did not start';
      proc.kill();
      if (this.proc === proc) this.proc = null;
      yield { type: 'error', message, kind: classifyError(message) };
      return;
    }

    // Bring agy up to date when its conversation doesn't hold what's been said (new, or Claude answered meanwhile).
    const history = req.history && (this.fresh || !req.history.inSync) && req.history.lines.length
      ? `<recent_conversation>\n${req.history.lines.join('\n')}\n</recent_conversation>\n\n` : '';
    this.fresh = false;

    const buffered: AgyLine[] = [];
    let wake: (() => void) | null = null;
    let open = true;
    this.handlers.push(line => { if (open) { buffered.push(line); wake?.(); } });
    const onAbort = () => { if (this.proc === proc) this.stop(); else proc.kill(); wake?.(); };
    req.signal.addEventListener('abort', onAbort, { once: true });
    proc.write({ event: 'user', message: { role: 'user', content: history + req.prompt } });

    let text = '';
    let textStep = -1;
    try {
      for (;;) {
        if (req.signal.aborted) return;
        if (!buffered.length) {
          if (!proc.alive()) {
            const message = proc.stderr().trim() || 'Antigravity stopped unexpectedly';
            yield { type: 'error', message, kind: classifyError(message) };
            return;
          }
          await new Promise<void>(r => { wake = r; setTimeout(r, 1000); });
          wake = null;
          continue;
        }
        const line = buffered.shift()!;
        if (line.event === 'result') {
          const r = line.result ?? {};
          if (r.status === 'SUCCESS') yield { type: 'done', text: text || (r.response ?? '').trim(), sessionId: r.conversation_id ?? this.conversationId };
          else {
            const message = [r.error, proc.stderr().trim().split('\n').slice(-3).join('\n')].filter(Boolean).join('\n') || 'Antigravity returned an error';
            yield { type: 'error', message, kind: classifyError(message) };
          }
          return;
        }
        const s = line.step_update;
        if (line.event !== 'step_update' || !s || s.step_type === 'user_input' || s.step_type === 'system_message') continue;
        // Nothing may act unless Ghost's permission hook is in place.
        if (!this.hooksVerified) {
          if (!existsSync(this.paths.marker)) {
            this.stop();
            yield { type: 'error', message: "Antigravity's safety hook didn't load, so Ghost stopped it before it could act.", kind: 'other' };
            return;
          }
          this.hooksVerified = true;
        }
        if (s.step_type === 'agent_response' && s.text_delta) {
          let delta = s.text_delta;
          // A new response after a tool call: keep the paragraphs apart.
          if (text && s.step_index !== textStep && !/\s$/.test(text)) delta = `\n\n${delta}`;
          textStep = s.step_index ?? textStep;
          text += delta;
          yield { type: 'text_delta', text: delta };
        } else if (s.step_type === 'tool') {
          const inner = s.tool_name === 'call_mcp_tool' ? `mcp__ghost__${String(s.tool_info?.parameters?.ToolName ?? 'tool')}` : TOOL_NAMES[s.tool_name ?? ''] ?? String(s.tool_name ?? 'tool');
          yield s.state === 'ACTIVE' ? { type: 'tool_start', name: inner } : { type: 'tool_end', name: inner };
        }
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      open = false;
      if (!this.keepWarm && this.proc) this.idleTimer = setTimeout(() => this.stop(), this.idleCloseMs);
    }
  }

  /**
   * A standalone call (e.g. filing a conversation into Obsidian) in its own short-lived agy process,
   * so it never enters the running conversation. No plugin: it needs no tools.
   */
  private async *oneShot(req: SendRequest): AsyncIterable<ProviderEvent> {
    const model = await this.resolveModel(req.model);
    const args = ['--output-format', 'stream-json', '--input-format', 'stream-json', '--print', ''];
    if (model) args.push('--model', model);
    const proc = spawnLive(this.command, args, { cwd: this.paths.workspace });
    const onAbort = () => proc.kill();
    req.signal.addEventListener('abort', onAbort, { once: true });
    try {
      proc.write({ event: 'user', message: { role: 'user', content: req.prompt } });
      let text = '';
      for await (const raw of proc.lines) {
        let line: AgyLine;
        try { line = JSON.parse(raw); } catch { continue; }
        if (line.event === 'step_update' && line.step_update?.step_type === 'agent_response' && line.step_update.text_delta) text += line.step_update.text_delta;
        if (line.event === 'result') {
          const r = line.result ?? {};
          if (r.status === 'SUCCESS') yield { type: 'done', text: text || r.response || '' };
          else { const message = r.error || proc.stderr().trim() || 'Antigravity returned an error'; yield { type: 'error', message, kind: classifyError(message) }; }
          return;
        }
      }
      if (!req.signal.aborted) { const message = proc.stderr().trim() || 'Antigravity stopped unexpectedly'; yield { type: 'error', message, kind: classifyError(message) }; }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      proc.kill();
    }
  }

  private start(model: string): void {
    this.stop();
    rmSync(this.paths.marker, { force: true });
    this.hooksVerified = false;
    const args = ['--output-format', 'stream-json', '--input-format', 'stream-json', '--print', '',
      '--dangerously-skip-permissions', '--add-dir', this.paths.root];
    if (model) args.push('--model', model);
    const resume = this.conversationId;
    if (resume) args.push('--conversation', resume);
    const proc = spawnLive(this.command, args, { cwd: this.paths.workspace });
    this.proc = proc;
    this.model = model;
    let settle: (ok: boolean) => void = () => {};
    this.init = new Promise(resolve => {
      settle = resolve;
      setTimeout(() => resolve(false), INIT_TIMEOUT_MS);
      void proc.exit.then(() => resolve(false));
    });
    proc.lines.on('line', (raw: string) => {
      let line: AgyLine;
      try { line = JSON.parse(raw); } catch { return; }
      if (this.proc !== proc) return;
      if (line.event === 'init') {
        // An unknown id silently starts a new conversation, so check we really resumed.
        this.fresh = !resume || line.conversation_id !== resume;
        this.conversationId = line.conversation_id ?? this.conversationId;
        settle(true);
        return;
      }
      this.handlers[0]?.(line);
      if (line.event === 'result') this.handlers.shift();
    });
    void proc.exit.then(() => { if (this.proc === proc) { this.proc = null; this.init = null; } });
  }

  /** Everything agy offers (Gemini, and Claude / GPT-OSS models on the same plan), newest-first automatic picks on top. */
  async listModels(): Promise<ModelOption[]> {
    this.models ??= this.catalog();
    const ids = await this.models;
    return [
      { id: 'flash', label: `Automatic: newest Gemini Flash${pickAgyModel(ids, 'flash') ? ` (${agyModelLabel(pickAgyModel(ids, 'flash'))})` : ''}` },
      { id: 'pro', label: `Automatic: newest Gemini Pro${pickAgyModel(ids, 'pro') ? ` (${agyModelLabel(pickAgyModel(ids, 'pro'))})` : ''}` },
      ...ids.map(id => ({ id, label: agyModelLabel(id) })),
    ];
  }

  /** `flash` / `pro` become the newest matching id from `agy models`; any other id is used as it is. */
  private async resolveModel(hint: string): Promise<string> {
    if (hint !== 'flash' && hint !== 'pro') return hint;
    this.models ??= this.catalog();
    return pickAgyModel(await this.models, hint);
  }

  private async catalog(): Promise<string[]> {
    try {
      const run = runCli(this.command, ['models'], { stdin: '', cwd: this.paths.workspace, signal: AbortSignal.timeout(30_000) });
      let out = '';
      for await (const line of run.lines) out += `${line}\n`;
      await run.exit;
      const ids = parseAgyCatalog(out + run.stderr());
      if (!ids.length) this.models = null; // try again next time
      return ids;
    } catch {
      this.models = null;
      return [];
    }
  }
}
