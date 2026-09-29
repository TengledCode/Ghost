import { ClaudeCliProvider, ClaudeStreamParser, claudeArgs } from './claude';
import { spawnLive, type LiveCli } from './spawnCli';
import type { ModelOption, Provider, ProviderEvent, SendRequest } from './types';
import { classifyError } from './types';

// Keeps one Claude Code session running between messages instead of starting the CLI for every
// reply, which costs a couple of seconds each time. Messages go in as JSON lines (the CLI's
// `--input-format stream-json` mode); the model is switched per message with a control request, and
// the conversation carries on in the same process. It's warmed up when Ghost starts, and restarted
// only when the conversation or configuration changes (or the process dies).
//
// Summaries of old conversations use a separate one-shot run so they never enter this session.

interface Waiter { resolve: (ok: boolean) => void }

export class ClaudeLiveProvider implements Provider {
  readonly id = 'claude' as const;
  private proc: LiveCli | null = null;
  private key = ''; // config the running process was started with (persona, MCP, workspace)
  private sessionId: string | undefined; // the conversation the running process holds
  private startedWith: string | undefined; // the session it was started (resumed) with
  private used = false; // whether any message has gone to the running process yet
  private model = '';
  // One handler per message written, in order: the CLI answers them one after another, so events
  // belong to the oldest unfinished message (an interrupted one keeps its slot until its result).
  private handlers: ((ev: ProviderEvent | 'result') => void)[] = [];
  private controls = new Map<string, Waiter>();
  private nextId = 1;
  private readonly oneShot: ClaudeCliProvider;

  constructor(private readonly command = 'claude') { this.oneShot = new ClaudeCliProvider(command); }

  isAvailable(): Promise<boolean> { return this.oneShot.isAvailable(); }

  /** Claude Code's aliases always point at the newest model of each family. */
  async listModels(): Promise<ModelOption[]> {
    return [
      { id: 'haiku', label: 'Haiku (newest)' },
      { id: 'sonnet', label: 'Sonnet (newest)' },
      { id: 'opus', label: 'Opus (newest)' },
    ];
  }

  /** Start the session ahead of the first message (called at launch). */
  warm(req: Pick<SendRequest, 'model' | 'personaFile' | 'mcpConfigPath' | 'workspace' | 'sessionId'>): void {
    try { this.ensure(req); } catch { /* the first real message will retry and report errors */ }
  }

  stop(): void { this.proc?.kill(); this.proc = null; }

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    if (req.oneShot) { yield* this.oneShot.send(req); return; }
    const proc = this.ensure(req);
    if (req.model && req.model !== this.model) {
      const ok = await this.control({ subtype: 'set_model', model: req.model });
      if (ok) this.model = req.model;
    }

    // Events for this turn arrive through `queue` from the reader loop.
    const buffered: (ProviderEvent | 'result')[] = [];
    let wake: (() => void) | null = null;
    let open = true;
    this.handlers.push(ev => { if (open) { buffered.push(ev); wake?.(); } });
    this.used = true;
    const onAbort = () => { void this.control({ subtype: 'interrupt' }); };
    req.signal.addEventListener('abort', onAbort, { once: true });
    proc.write({ type: 'user', message: { role: 'user', content: req.prompt } });

    try {
      for (;;) {
        if (!buffered.length) {
          if (!proc.alive()) {
            const message = proc.stderr().trim() || 'Claude stopped unexpectedly';
            if (!req.signal.aborted) yield { type: 'error', message, kind: classifyError(message) };
            return;
          }
          await new Promise<void>(r => { wake = r; setTimeout(r, 1000); });
          wake = null;
          continue;
        }
        let ev = buffered.shift()!;
        if (ev === 'result') return;
        if (ev.type === 'done' && !ev.sessionId && this.sessionId) ev = { ...ev, sessionId: this.sessionId };
        if (req.signal.aborted && ev.type === 'error') return; // the interrupt's own error result
        yield ev;
        if (ev.type === 'done' || ev.type === 'error') return;
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      open = false;
    }
  }

  /** Make sure a process is running for this conversation and configuration. */
  private ensure(req: Pick<SendRequest, 'model' | 'personaFile' | 'mcpConfigPath' | 'workspace' | 'sessionId'>): LiveCli {
    const key = `${req.personaFile}|${req.mcpConfigPath}|${req.workspace}`;
    // A fresh process started for this conversation hasn't reported its session id to the core yet.
    const sameConversation = req.sessionId === undefined
      ? !this.used && this.startedWith === undefined
      : req.sessionId === this.sessionId || (!this.used && req.sessionId === this.startedWith);
    if (this.proc?.alive() && key === this.key && sameConversation) return this.proc;
    this.stop();
    const args = claudeArgs({ model: req.model, personaFile: req.personaFile, mcpConfigPath: req.mcpConfigPath, sessionId: req.sessionId })
      .filter(a => a !== '-p');
    const proc = spawnLive(this.command, ['-p', '--input-format', 'stream-json', ...args], { cwd: req.workspace });
    this.proc = proc;
    this.key = key;
    this.model = req.model;
    this.sessionId = req.sessionId;
    this.startedWith = req.sessionId;
    this.used = false;
    this.handlers = [];
    this.read(proc);
    return proc;
  }

  private read(proc: LiveCli): void {
    let parser = new ClaudeStreamParser();
    proc.lines.on('line', (line: string) => {
      let msg: { type?: string; session_id?: string; response?: { subtype?: string; request_id?: string } };
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'control_response') {
        const id = msg.response?.request_id ?? '';
        this.controls.get(id)?.resolve(msg.response?.subtype === 'success');
        this.controls.delete(id);
        return;
      }
      if (msg.session_id) this.sessionId = msg.session_id;
      if (this.proc !== proc) return;
      for (const ev of parser.parse(line)) this.handlers[0]?.(ev);
      if (msg.type === 'result') { this.handlers.shift()?.('result'); parser = new ClaudeStreamParser(); }
    });
    void proc.exit.then(() => {
      if (this.proc === proc) this.proc = null;
      for (const w of this.controls.values()) w.resolve(false);
      this.controls.clear();
    });
  }

  private control(request: Record<string, unknown>): Promise<boolean> {
    const proc = this.proc;
    if (!proc?.alive()) return Promise.resolve(false);
    const request_id = `g${this.nextId++}`;
    return new Promise(resolve => {
      this.controls.set(request_id, { resolve });
      proc.write({ type: 'control_request', request_id, request });
      setTimeout(() => { if (this.controls.delete(request_id)) resolve(false); }, 5000);
    });
  }
}
