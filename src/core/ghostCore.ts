import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ClientRole, CoreMessage, GhostState } from '../shared/protocol';
import { parseMessage } from '../shared/protocol';
import type { ProviderId, Settings } from '../shared/settings';
import { AckPicker, allAckLines, classifyAck, withName, type AckPool } from '../shared/acks';
import { classify, describe } from './approvals/classify';
import { pickGreeting } from './greeting';
import { isPureCommand, parseScreenCommand } from './liveScreen';
import { ConversationLog } from './memory/conversations';
import { MemoryStore } from './memory/store';
import { buildPersona, buildTurnPrompt } from './persona';
import { PresenceStore } from './presence';
import type { Provider, ProviderEvent } from './providers/types';
import { ReminderScheduler } from './reminders/scheduler';
import { modelFor, routeTier } from './router';
import { SentenceSplitter, type Segment } from './sentenceSplitter';
import { TOOL_DEFS, type ToolName } from './tools/definitions';
import { CLAUDE_BUILTIN_TOOLS } from './providers/claude';
import { ToolExecutor, type Host } from './tools/executor';
import { AckAudioCache } from './tts/ackCache';
import type { TtsService } from './tts/service';

export interface CoreOptions {
  dataDir: string;
  personaPath: string;
  mcpServerPath: string; // compiled out/main/mcpServer.js
  nodeExecPath: string; // Electron binary (run as node) or node itself
  providers: Partial<Record<ProviderId, Provider>>;
  tts: TtsService;
  host: Host;
  settings: () => Settings;
  port?: number;
  approvalTimeoutMs?: number;
  /** Snapshot of the monitor under the cursor (Electron desktopCapturer); absent in tests or browsers. */
  captureScreen?: () => Promise<{ path: string; width: number; height: number; takenAt: string }>;
  /** Told when live screen view switches (e.g. to update the tray tooltip). */
  onLiveScreen?: (on: boolean) => void;
  /** Speak a short greeting when the overlay first connects (off in tests). */
  greetOnStart?: boolean;
  /** How long a reply may keep Aaron waiting before Ghost acknowledges it (ms). */
  ackDelayMs?: number;
}

interface Client { ws: WebSocket; role: ClientRole | null }
interface Turn {
  id: string; abort: AbortController; spoken: number; audioSent: number; audioDone: boolean; textDone: boolean;
  startedAt: number; firstText?: number; firstAudio?: number; acked: boolean; ackTimer?: NodeJS.Timeout;
}

const PRIMARY_RETRY_MS = 15 * 60_000; // while fallen back, try the primary again at most this often
const SESSION_IDLE_MS = 2 * 3600_000; // start a fresh conversation after 2h of quiet to keep context (and usage) small
const TOOL_LABEL: Record<string, string> = { WebSearch: 'Searching the web', WebFetch: 'Reading a page', google_web_search: 'Searching the web', web_fetch: 'Reading a page' };

export class GhostCore {
  readonly token = randomBytes(24).toString('hex');
  port = 0;
  private wss: WebSocketServer | null = null;
  private clients = new Set<Client>();
  private state: GhostState = 'idle';
  private turn: Turn | null = null;
  private sessionId: string | undefined;
  readonly log: ConversationLog;
  private approvals = new Map<string, (ok: boolean) => void>();
  private idleTimer: NodeJS.Timeout | null = null;
  private liveScreen = false; // always off at start: never silently watching after a restart
  private liveTimer: NodeJS.Timeout | null = null;
  private liveOffAt: number | undefined;
  private fallback: { reason: 'limit' | 'auth' | 'missing' | 'other'; retryAt: number; active: ProviderId } | null = null;
  private speechQueue: Promise<void> = Promise.resolve();
  readonly memory: MemoryStore;
  readonly reminders: ReminderScheduler;
  private executor: ToolExecutor;
  private workspace: string;
  private personaFile: string;
  private mcpConfigPath: string;
  private presence: PresenceStore;
  private acks = new AckPicker();
  private ackAudio: AckAudioCache;
  private greeted = false;
  private presenceTimer: NodeJS.Timeout | null = null;
  private prewarmTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: CoreOptions) {
    this.workspace = join(o.dataDir, 'workspace');
    this.personaFile = join(o.dataDir, 'persona.generated.md');
    this.mcpConfigPath = join(o.dataDir, 'ghost-mcp.json');
    mkdirSync(this.workspace, { recursive: true });
    this.memory = new MemoryStore(join(o.dataDir, 'memory.json'));
    this.reminders = new ReminderScheduler(join(o.dataDir, 'reminders.json'), r => this.fireReminder(r.id, r.text));
    this.log = new ConversationLog(o.dataDir);
    this.sessionId = this.log.current.claudeSessionId; // resume the Claude conversation after a restart
    this.executor = new ToolExecutor(o.host, this.memory, this.reminders, this.log);
    this.presence = new PresenceStore(join(o.dataDir, 'presence.json'));
    this.ackAudio = new AckAudioCache(join(o.dataDir, 'ack-cache'), o.tts);
    o.tts.onFallback = reason => this.broadcast({ type: 'notice', level: 'info', text: `Voice switched to Edge (${reason}).` });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const listen = (port: number) => {
        const wss = new WebSocketServer({ host: '127.0.0.1', port });
        wss.once('listening', () => { this.wss = wss; resolve(); });
        wss.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' && port !== 0 ? listen(0) : reject(e)));
      };
      listen(this.o.port ?? 47831);
    });
    this.port = (this.wss!.address() as AddressInfo).port;
    this.wss!.on('connection', ws => this.onConnection(ws));
    this.writeCliConfig();
    this.reminders.start();
    // Pick up where we left off, or file away a conversation that went quiet while Ghost was closed.
    if (this.log.isStale(SESSION_IDLE_MS)) this.rotateConversation();
    else this.seedGemini();
    this.warmClaude();
    this.presenceTimer = setInterval(() => this.presence.update({ lastSeen: Date.now() }), 5 * 60_000);
    this.presenceTimer.unref?.();
    const s = this.o.settings();
    // Record the acknowledgements once per voice, in the background, so they play instantly.
    if (s.voiceEnabled && s.acknowledgements && this.o.greetOnStart) this.prewarmTimer = setTimeout(() => void this.ackAudio.prewarm(allAckLines(s.userName), this.voiceChoice()), 8000);
  }

  /** Start the Claude session now, so the first message doesn't wait for the CLI to boot. */
  private warmClaude(): void {
    const s = this.o.settings();
    const claude = this.o.providers.claude as { warm?: (r: object) => void } | undefined;
    if (s.provider !== 'claude' && s.fallbackProvider !== 'claude') return;
    claude?.warm?.({
      model: modelFor('claude', s.modelTier === 'auto' ? 'balanced' : s.modelTier), personaFile: this.personaFile,
      mcpConfigPath: this.mcpConfigPath, workspace: this.workspace, sessionId: this.sessionId,
    });
  }

  private voiceChoice() {
    const s = this.o.settings();
    return { engine: s.ttsEngine, elevenLabsVoiceId: s.elevenLabsVoiceId, edgeVoice: s.edgeVoice };
  }

  stop(): void {
    this.clearLiveTimer();
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.prewarmTimer) clearTimeout(this.prewarmTimer);
    this.presence.update({ lastSeen: Date.now() });
    (this.o.providers.claude as { stop?: () => void } | undefined)?.stop?.();
    this.turn?.abort.abort();
    this.reminders.stop();
    for (const c of this.clients) c.ws.close();
    this.wss?.close();
  }

  get url(): string { return `ws://127.0.0.1:${this.port}`; }

  /** Rewrite persona + CLI config files (called on start and when settings change). */
  writeCliConfig(): void {
    const s = this.o.settings();
    writeFileSync(this.personaFile, buildPersona(this.o.personaPath, s));
    const server = {
      command: this.o.nodeExecPath,
      args: [this.o.mcpServerPath],
      env: { ELECTRON_RUN_AS_NODE: '1', GHOST_CORE_URL: this.url, GHOST_TOKEN: this.token },
    };
    writeFileSync(this.mcpConfigPath, JSON.stringify({ mcpServers: { ghost: server } }, null, 2));
    // Gemini CLI reads project settings from <cwd>/.gemini/settings.json.
    mkdirSync(join(this.workspace, '.gemini'), { recursive: true });
    const geminiReadOnly = ['google_web_search', 'web_fetch', 'read_file', 'read_many_files', 'glob', 'search_file_content', 'list_directory'];
    writeFileSync(join(this.workspace, '.gemini', 'settings.json'), JSON.stringify({
      mcpServers: { ghost: { ...server, trust: true } },
      tools: { exclude: ['run_shell_command', 'write_file', 'replace', 'save_memory'], allowed: geminiReadOnly },
    }, null, 2));
    // Claude Code: keep this folder free of project instructions.
    writeFileSync(join(this.workspace, 'README.txt'), 'Ghost working folder for the Claude/Gemini CLIs. Safe to leave empty.\n');
    // A running Claude session read the old persona; the next message restarts it (same conversation).
    (this.o.providers.claude as { stop?: () => void } | undefined)?.stop?.();
  }

  // ---------------------------------------------------------------- connections

  private onConnection(ws: WebSocket): void {
    const client: Client = { ws, role: null };
    this.clients.add(client);
    const authTimer = setTimeout(() => { if (!client.role) ws.close(4001, 'auth timeout'); }, 5000);
    ws.on('close', () => { clearTimeout(authTimer); this.clients.delete(client); });
    ws.on('message', raw => {
      const msg = parseMessage<ClientMessage>(raw);
      if (!msg) return;
      if (!client.role) {
        if (msg.type !== 'hello' || msg.token !== this.token) { ws.close(4003, 'bad token'); return; }
        client.role = msg.role;
        clearTimeout(authTimer);
        if (msg.role === 'ui') {
          const s = this.o.settings();
          this.send(client, { type: 'welcome', name: s.assistantName, userName: s.userName });
          this.send(client, { type: 'state', state: this.state });
          this.send(client, { type: 'live_screen', on: this.liveScreen, offAt: this.liveOffAt });
          if (this.fallback) this.send(client, { type: 'provider', active: this.fallback.active, primary: s.provider, reason: this.fallback.reason });
          if (this.o.greetOnStart && !this.greeted) { this.greeted = true; setTimeout(() => this.greet(), 1400); }
        }
        return;
      }
      void this.handle(client, msg);
    });
  }

  private async handle(client: Client, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'user_message': return this.userMessage(msg.text);
      case 'typing':
        if (msg.active && (this.state === 'idle' || this.state === 'done')) this.setState('listening');
        else if (!msg.active && this.state === 'listening') this.setState('idle');
        return;
      case 'cancel': return this.cancel();
      case 'approval_response': this.approvals.get(msg.id)?.(msg.approved); return;
      case 'playback_finished':
        if (this.turn?.id === msg.turnId || msg.turnId.startsWith('reminder-') || msg.turnId.startsWith('preview-') || msg.turnId.startsWith('say-')) this.finishSpeaking(msg.turnId);
        return;
      case 'new_conversation': return this.newConversation();
      case 'toggle_live_screen': return this.setLiveScreen(!this.liveScreen, true);
      case 'clear_history':
        this.cancel();
        this.log.clear();
        this.memory.clearEpisodes();
        this.setSession(undefined);
        this.resetGemini();
        this.broadcast({ type: 'notice', level: 'info', text: 'Conversation history cleared. Lasting facts are kept.' });
        return;
      case 'voice_preview': return this.voicePreview(msg.engine, msg.voice, msg.text);
      case 'tool_call':
        if (client.role !== 'mcp') return;
        return this.toolCall(client, msg.id, msg.tool, msg.args);
      default: return;
    }
  }

  /** A notice for every open Ghost window (used by the main process, e.g. a hotkey conflict). */
  notify(level: 'info' | 'warn' | 'error', text: string): void { this.broadcast({ type: 'notice', level, text }); }

  private send(c: Client, m: CoreMessage): void { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(m)); }
  private broadcast(m: CoreMessage): void { for (const c of this.clients) if (c.role === 'ui') this.send(c, m); }

  private setState(state: GhostState, detail?: string): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.state = state;
    this.broadcast({ type: 'state', state, detail });
    if (state === 'done' || state === 'error') {
      this.idleTimer = setTimeout(() => { this.state = 'idle'; this.broadcast({ type: 'state', state: 'idle' }); }, state === 'done' ? 900 : 2500);
    }
  }

  // ---------------------------------------------------------------- turns

  cancel(): void {
    if (this.turn?.ackTimer) clearTimeout(this.turn.ackTimer);
    this.turn?.abort.abort();
    this.turn = null;
    this.speechQueue = Promise.resolve();
    for (const resolve of this.approvals.values()) resolve(false);
    this.setState('idle');
  }

  newConversation(): void {
    this.cancel();
    this.rotateConversation();
    this.broadcast({ type: 'notice', level: 'info', text: 'New conversation.' });
  }

  /** Close the open conversation (it's summarised in the background) and start a fresh one. */
  private rotateConversation(): void {
    const ended = this.log.rotate();
    this.setSession(undefined);
    this.resetGemini();
    void this.archiveConversation(ended);
  }

  private setSession(id: string | undefined): void {
    this.sessionId = id;
    this.log.setClaudeSession(id);
  }

  private resetGemini(): void { (this.o.providers.gemini as { resetHistory?: () => void } | undefined)?.resetHistory?.(); }

  /** Gemini has no resumable sessions, so after a restart it gets the recent lines of the conversation. */
  private seedGemini(): void {
    const s = this.o.settings();
    const recent = this.log.lines().slice(-12).map(l => `${l.role === 'user' ? s.userName : s.assistantName}: ${l.text}`);
    (this.o.providers.gemini as { seedHistory?: (h: string[]) => void } | undefined)?.seedHistory?.(recent);
  }

  async userMessage(text: string): Promise<void> {
    const message = text.trim();
    if (!message) return;
    if (/^\/(new|reset)$/i.test(message)) return this.newConversation();
    const screenCmd = parseScreenCommand(message);
    if (isPureCommand(message, screenCmd)) return this.setLiveScreen(screenCmd === 'on', true);
    this.cancel();
    const s = this.o.settings();
    if (this.log.isStale(SESSION_IDLE_MS)) this.rotateConversation();
    if (screenCmd === 'on' && !this.liveScreen) this.setLiveScreen(true, false);
    if (this.liveScreen) this.armLiveTimer(); // the auto-off timer counts quiet time, so a message resets it

    const turn: Turn = { id: randomUUID(), abort: new AbortController(), spoken: 0, audioSent: 0, audioDone: false, textDone: false, startedAt: Date.now(), acked: false };
    this.turn = turn;
    this.setState('thinking');
    this.presence.update({ lastSeen: Date.now() });

    // Live view, or a one-off "what's on my screen?": snapshot the monitor under the cursor first.
    let screen: { path: string } | { error: string } | undefined;
    if ((this.liveScreen || screenCmd === 'once') && this.o.captureScreen) {
      try { screen = { path: (await this.o.captureScreen()).path }; } catch (e) {
        screen = { error: String((e as Error).message ?? e).slice(0, 120) };
        this.broadcast({ type: 'notice', level: 'warn', text: `Couldn't capture the screen: ${screen.error}` });
      }
      if (this.turn !== turn) return;
    }
    let tier = routeTier(message, s.modelTier);
    if (screen && 'path' in screen && tier === 'fast' && s.modelTier === 'auto') tier = 'balanced'; // reading a screen deserves more than the quick tier
    // A quick "Noted." when the reply will take a moment: straight away for deep thinking or a screen
    // read, otherwise only if nothing has arrived after a short wait.
    const ackPool = classifyAck(message, tier, !!screen && 'path' in screen);
    if (ackPool === 'deep' || ackPool === 'screen') this.acknowledge(turn, ackPool);
    else turn.ackTimer = setTimeout(() => this.acknowledge(turn, ackPool), this.o.ackDelayMs ?? 1200);
    const prompt = buildTurnPrompt(message, { now: new Date(), memories: this.memory.contextFor(message), userName: s.userName, screen });
    let order = [s.provider, s.fallbackProvider].filter((p, i, a): p is ProviderId => !!p && a.indexOf(p) === i);
    // While fallen back, don't pay for a failing call to the primary on every message.
    if (this.fallback && Date.now() < this.fallback.retryAt && order.length > 1) order = order.slice(1);
    const splitter = new SentenceSplitter(true);
    let reply = '';

    for (const [attempt, pid] of order.entries()) {
      const provider = this.o.providers[pid];
      if (!provider) continue;
      const model = modelFor(pid, tier);
      let failed: ProviderEvent & { type: 'error' } | null = null;
      try {
        for await (const ev of provider.send({
          prompt, model, persona: buildPersona(this.o.personaPath, s), personaFile: this.personaFile,
          sessionId: pid === 'claude' ? this.sessionId : undefined,
          mcpConfigPath: this.mcpConfigPath, workspace: this.workspace, signal: turn.abort.signal,
        })) {
          if (this.turn !== turn) return;
          if (ev.type === 'session' && pid === 'claude') this.setSession(ev.sessionId);
          else if (ev.type === 'text_delta') {
            reply += ev.text;
            this.markText(turn);
            this.broadcast({ type: 'text_delta', turnId: turn.id, text: ev.text });
            if (this.state === 'searching') this.setState('thinking');
            for (const seg of splitter.push(ev.text)) this.queueSpeech(turn, seg);
          } else if (ev.type === 'tool_start') {
            if (turn.firstText === undefined) this.acknowledge(turn, 'search');
            this.setState('searching', TOOL_LABEL[ev.name] ?? prettyTool(ev.name));
          } else if (ev.type === 'tool_end') {
            if (this.state === 'searching') this.setState('thinking');
          } else if (ev.type === 'done') {
            if (ev.sessionId && pid === 'claude') this.setSession(ev.sessionId);
            if (!reply && ev.text) { reply = ev.text; this.markText(turn); this.broadcast({ type: 'text_delta', turnId: turn.id, text: ev.text }); for (const seg of splitter.push(ev.text)) this.queueSpeech(turn, seg); }
          } else if (ev.type === 'error') {
            failed = ev;
          }
        }
      } catch (e) {
        failed = { type: 'error', message: String(e), kind: 'other' };
      }
      if (turn.abort.signal.aborted || this.turn !== turn) return;
      if (!failed) {
        if (pid === s.provider && this.fallback) {
          this.fallback = null;
          this.broadcast({ type: 'provider', active: pid, primary: s.provider, reason: null });
          this.broadcast({ type: 'notice', level: 'info', text: `Back on ${brainName(pid)}.` });
        }
        for (const seg of splitter.flush()) this.queueSpeech(turn, seg);
        this.log.append('user', message);
        this.log.append('assistant', reply, { provider: pid, model: model || 'default' });
        this.broadcast({ type: 'turn_end', turnId: turn.id, text: reply, provider: pid, model: model || 'default' });
        turn.textDone = true;
        this.markText(turn);
        this.maybeFinish(turn);
        return;
      }
      // Fall back to the next provider only if nothing has been said yet.
      if (reply || attempt === order.length - 1) {
        this.reportError(turn, pid, failed);
        return;
      }
      // Keep the Claude conversation for when it comes back, unless the session itself failed.
      if (pid === 'claude' && failed.kind === 'other') this.setSession(undefined);
      const next = order[attempt + 1];
      const reason = failed.kind ?? 'other';
      if (pid === s.provider) {
        const firstTime = !this.fallback;
        this.fallback = { reason, retryAt: Date.now() + PRIMARY_RETRY_MS, active: next };
        this.broadcast({ type: 'provider', active: next, primary: pid, reason });
        // Say it once per outage, before the fallback's answer (speech is queued in order).
        if (firstTime) { const line = switchLine(pid, next, reason, s.userName); this.queueSpeech(turn, { display: `${line}\n\n`, speech: line }); }
      }
    }
  }

  private reportError(turn: Turn, pid: string, err: { message: string; kind?: string }): void {
    const s = this.o.settings();
    const line = {
      limit: `Apologies, ${s.userName}. I've reached the usage limit on your ${pid} plan for now.`,
      auth: `${s.userName}, I'm signed out of ${pid}. Please run "${pid}" in a terminal and log in again.`,
      missing: `I can't find the ${pid} command-line tool on this PC, ${s.userName}. It needs installing first.`,
      other: `Something went wrong on my side, ${s.userName}. The details are in the transcript.`,
    }[err.kind ?? 'other'] ?? '';
    this.broadcast({ type: 'text_delta', turnId: turn.id, text: line });
    this.broadcast({ type: 'turn_end', turnId: turn.id, text: line, provider: pid, model: '' });
    this.broadcast({ type: 'notice', level: 'error', text: err.message.slice(0, 400) });
    turn.textDone = true;
    this.markText(turn);
    this.setState('error');
    this.queueSpeech(turn, { display: line, speech: line });
  }

  /**
   * Queue one segment of the reply. Its audio and its display text travel together, so the overlay
   * can reveal the words as they are spoken. Segments with nothing to say (a code block) still take
   * their place in the order, with empty audio.
   */
  private queueSpeech(turn: Turn, seg: Segment, ack = false): void {
    const s = this.o.settings();
    if (!s.voiceEnabled) return;
    const seq = turn.spoken++;
    const display = seg.display;
    const synth = !seg.speech ? Promise.resolve(null) : (ack ? this.ackAudio.get(seg.speech, this.voiceChoice()) : this.o.tts
      .speak(seg.speech, this.voiceChoice(), turn.abort.signal))
      .catch(e => { if (!ack) this.broadcast({ type: 'notice', level: 'warn', text: `Voice unavailable: ${String(e.message ?? e)}` }); return null; });
    // Synthesis runs in parallel, but delivery keeps sentence order.
    this.speechQueue = this.speechQueue.then(async () => {
      const audio = await synth;
      if (this.turn !== turn || turn.abort.signal.aborted) return;
      if (audio) {
        // An acknowledgement plays while Ghost is still thinking; the reply itself switches to speaking.
        if (!ack && this.state !== 'speaking' && this.state !== 'error') this.setState('speaking');
        if (!ack && turn.firstAudio === undefined) turn.firstAudio = Date.now() - turn.startedAt;
        turn.audioSent++;
        this.broadcast({ type: 'audio', turnId: turn.id, seq, mime: audio.mime, data: audio.audio.toString('base64'), engine: audio.engine, last: false, display });
      } else {
        // Keep the sequence contiguous so the player doesn't wait for a sentence that will never come.
        this.broadcast({ type: 'audio', turnId: turn.id, seq, mime: 'audio/mpeg', data: '', engine: 'none', last: false, display });
      }
      if (seq === turn.spoken - 1 && turn.textDone) this.maybeFinish(turn);
    });
  }

  /** The reply has started: an acknowledgement would only get in its way now. */
  private markText(turn: Turn): void {
    if (turn.firstText === undefined) turn.firstText = Date.now() - turn.startedAt;
    if (turn.ackTimer) { clearTimeout(turn.ackTimer); turn.ackTimer = undefined; }
  }

  /** Speak one acknowledgement for this turn, if the reply hasn't started and voice is on. */
  private acknowledge(turn: Turn, pool: AckPool): void {
    if (turn.ackTimer) { clearTimeout(turn.ackTimer); turn.ackTimer = undefined; }
    const s = this.o.settings();
    if (turn.acked || turn.firstText !== undefined || turn.spoken > 0 || this.turn !== turn || !s.voiceEnabled || !s.acknowledgements) return;
    turn.acked = true;
    // No display text: the bubble keeps its "…" until the reply itself is spoken.
    this.queueSpeech(turn, { display: '', speech: withName(this.acks.next(pool), s.userName) }, true);
  }

  /** When all text is in and every sentence is synthesised, tell clients the last chunk has gone. */
  private maybeFinish(turn: Turn): void {
    void this.speechQueue.then(() => {
      if (this.turn !== turn || turn.audioDone) return;
      if (!turn.textDone) return;
      turn.audioDone = true;
      this.broadcast({ type: 'timing', turnId: turn.id, firstTextMs: turn.firstText, firstAudioMs: turn.firstAudio, acked: turn.acked });
      if (turn.audioSent === 0) { if (this.state !== 'error') this.setState('done'); return; }
      this.broadcast({ type: 'audio', turnId: turn.id, seq: turn.spoken, mime: 'audio/mpeg', data: '', engine: 'none', last: true });
    });
  }

  private finishSpeaking(turnId: string): void {
    if (this.state === 'speaking' || this.state === 'error') this.setState(this.state === 'error' ? 'error' : 'done');
    if (this.turn?.id === turnId) this.turn = null;
  }

  // ---------------------------------------------------------------- tools & approvals

  private async toolCall(client: Client, id: string, tool: string, args: Record<string, unknown>): Promise<void> {
    const reply = (ok: boolean, result: string) => this.send(client, { type: 'tool_result', id, ok, result });
    if (!(tool in TOOL_DEFS)) return reply(false, `Unknown tool ${tool}`);
    const previous = this.state;
    if (classify(tool, args) === 'confirm') {
      const approved = await this.requestApproval(tool, args);
      if (!approved) { this.setState(previous === 'approval' ? 'thinking' : previous); return reply(false, `${this.o.settings().userName} declined this action. Do not retry it; ask what he would prefer instead.`); }
    }
    this.setState('searching', prettyTool(tool));
    try {
      const result = await this.executor.run(tool as ToolName, args);
      reply(true, result);
    } catch (e) {
      reply(false, `Failed: ${String((e as Error).message ?? e)}`);
    } finally {
      if (this.state === 'searching') this.setState('thinking');
    }
  }

  private requestApproval(tool: string, args: Record<string, unknown>): Promise<boolean> {
    const id = randomUUID();
    this.setState('approval', describe(tool, args));
    this.broadcast({ type: 'approval_request', id, tool, summary: describe(tool, args), args });
    return new Promise(resolve => {
      const timer = setTimeout(() => done(false), this.o.approvalTimeoutMs ?? 60_000);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        if (!this.approvals.delete(id)) return;
        this.broadcast({ type: 'approval_resolved', id, approved: ok });
        resolve(ok);
      };
      this.approvals.set(id, done);
    });
  }

  // ---------------------------------------------------------------- reminders, previews, memory

  private fireReminder(id: string, text: string): void {
    const s = this.o.settings();
    const line = `${s.userName}, a reminder: ${text}`;
    this.broadcast({ type: 'reminder', id, text: line });
    void this.speakStandalone(`reminder-${id}`, line);
  }

  private async voicePreview(engine: 'elevenlabs' | 'edge' | 'none', voice: string, text?: string): Promise<void> {
    const s = this.o.settings();
    this.o.tts.resetBackoff();
    const line = text ?? `Good evening, ${s.userName}. Your jacket is pressed, your calendar is clear, and I am at your service.`;
    await this.speakStandalone(`preview-${randomUUID()}`, line, {
      engine: engine === 'none' ? 'edge' : engine,
      elevenLabsVoiceId: engine === 'elevenlabs' ? voice : s.elevenLabsVoiceId,
      edgeVoice: engine === 'edge' ? voice : s.edgeVoice,
    });
  }

  // ---------------------------------------------------------------- live screen view

  /** Switch live view; `announce` speaks and shows a short confirmation. */
  setLiveScreen(on: boolean, announce: boolean): void {
    const s = this.o.settings();
    const changed = on !== this.liveScreen;
    this.liveScreen = on;
    if (on) this.armLiveTimer(); else this.clearLiveTimer();
    this.broadcast({ type: 'live_screen', on, offAt: this.liveOffAt });
    if (changed) this.o.onLiveScreen?.(on);
    if (!announce) return;
    const line = on
      ? (changed ? `Very well, ${s.userName}. I'm watching your screen.` : `I'm already watching your screen, ${s.userName}.`)
      : (changed ? `Understood. I've stopped watching your screen.` : `I wasn't watching your screen, ${s.userName}.`);
    this.say(line);
  }

  /** Settings changed: restart or clear the auto-off timer to match. */
  settingsChanged(): void { if (this.liveScreen) { this.armLiveTimer(); this.broadcast({ type: 'live_screen', on: true, offAt: this.liveOffAt }); } }

  get isLiveScreen(): boolean { return this.liveScreen; }

  private armLiveTimer(): void {
    this.clearLiveTimer();
    const s = this.o.settings();
    if (!s.liveScreenAutoOff) return;
    const ms = s.liveScreenAutoOffMinutes * 60_000;
    this.liveOffAt = Date.now() + ms;
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      this.setLiveScreen(false, false);
      this.broadcast({ type: 'notice', level: 'info', text: `Live screen view switched off after ${s.liveScreenAutoOffMinutes} quiet minutes.` });
      this.say(`I've stopped watching your screen, ${this.o.settings().userName}.`);
    }, ms);
  }

  private clearLiveTimer(): void {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    this.liveOffAt = undefined;
  }

  /** A short line from Ghost itself (no model call): shown in the bubble and spoken. */
  private say(text: string): void {
    const turnId = `say-${randomUUID()}`;
    this.broadcast({ type: 'text_delta', turnId, text });
    this.broadcast({ type: 'turn_end', turnId, text, provider: 'ghost', model: '' });
    void this.speakStandalone(turnId, text);
  }

  private async speakStandalone(turnId: string, text: string, choice?: Parameters<TtsService['speak']>[1]): Promise<void> {
    const s = this.o.settings();
    if (!s.voiceEnabled && !turnId.startsWith('preview-')) return;
    try {
      const audio = await this.o.tts.speak(text, choice ?? { engine: s.ttsEngine, elevenLabsVoiceId: s.elevenLabsVoiceId, edgeVoice: s.edgeVoice });
      this.setState('speaking');
      this.broadcast({ type: 'audio', turnId, seq: 0, mime: audio.mime, data: audio.audio.toString('base64'), engine: audio.engine, last: false, display: text });
      this.broadcast({ type: 'audio', turnId, seq: 1, mime: audio.mime, data: '', engine: 'none', last: true });
    } catch (e) {
      this.broadcast({ type: 'notice', level: 'warn', text: `Voice unavailable: ${String((e as Error).message ?? e)}` });
    }
  }

  /** Let Aaron know Ghost is around, once per launch, as the overlay finishes materialising. */
  private greet(): void {
    const s = this.o.settings();
    const p = this.presence.get();
    const line = pickGreeting({
      now: new Date(), lastSeen: p.lastSeen, lastGreeting: p.lastGreeting,
      facts: this.memory.list().map(f => f.text), userName: s.userName, assistantName: s.assistantName,
    });
    this.presence.update({ lastGreeting: line, lastSeen: Date.now() });
    if (this.turn) return; // Aaron is already talking to Ghost
    this.say(line);
  }

  /** Condense a finished conversation into a short episode for long-term memory, using the cheapest tier. */
  private async archiveConversation(conversationId: string): Promise<void> {
    const s = this.o.settings();
    const lines = this.log.lines(conversationId).map(l => `${l.role === 'user' ? s.userName : s.assistantName}: ${l.text}`);
    if (lines.length < 6) return;
    const provider = this.o.providers[s.provider];
    if (!provider || s.provider === 'mock') return;
    let summary = '';
    try {
      for await (const ev of provider.send({
        prompt: `Summarise this conversation in 2-3 sentences for your long-term memory. Note decisions, plans and facts about ${s.userName}. Reply with the summary only.\n\n${lines.join('\n').slice(-12_000)}`,
        model: modelFor(s.provider, 'fast'), persona: '', personaFile: this.personaFile, mcpConfigPath: this.mcpConfigPath,
        workspace: this.workspace, signal: new AbortController().signal, oneShot: true,
      })) if (ev.type === 'done') summary = ev.text;
    } catch { /* memory is best effort */ }
    if (summary.trim()) this.memory.addEpisode(summary);
  }
}

function brainName(id: string): string {
  return ({ claude: 'Claude', gemini: 'Gemini', mock: 'the test brain' } as Record<string, string>)[id] ?? id;
}

/** What Ghost says, once, when it has to switch brains. */
export function switchLine(from: string, to: string, reason: string, user: string): string {
  const a = brainName(from), b = brainName(to);
  if (reason === 'limit') return `${a}'s limit is reached for now, ${user}. I'll carry on with ${b}.`;
  if (reason === 'auth') return `I'm signed out of ${a}, ${user}, so I'll use ${b} until you sign back in.`;
  if (reason === 'missing') return `I can't find ${a} on this PC, ${user}. ${b} will take it from here.`;
  return `${a} isn't answering, ${user}. I'll carry on with ${b}.`;
}

function prettyTool(name: string): string {
  const bare = name.replace(/^mcp__ghost__/, '');
  const map: Record<string, string> = {
    open_app: 'Opening an app', open_path_or_url: 'Opening', list_windows: 'Checking windows', focus_window: 'Switching windows',
    close_app: 'Closing an app', run_command: 'Running a command', write_file: 'Writing a file', delete_path: 'Deleting',
    set_reminder: 'Setting a reminder', list_reminders: 'Checking reminders', cancel_reminder: 'Cancelling a reminder',
    remember: 'Committing to memory', recall: 'Recalling', forget: 'Forgetting', get_datetime: 'Checking the time',
    Read: 'Reading a file', Glob: 'Looking for files', Grep: 'Searching files',
  };
  return map[bare] ?? (CLAUDE_BUILTIN_TOOLS.includes(bare) ? bare : 'Working');
}
