import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type { ClientMessage, ClientRole, CoreMessage, GhostState } from '../shared/protocol';
import { parseMessage } from '../shared/protocol';
import type { ProviderId, Settings } from '../shared/settings';
import { classify, describe } from './approvals/classify';
import { pickGreeting } from './greeting';
import { isPureCommand, parseScreenCommand } from './liveScreen';
import { ConversationLog, type HistoryStore } from './memory/conversations';
import { MemoryStore, type FactStore } from './memory/store';
import { ObsidianConnection } from './obsidian/connection';
import { backupInfo } from './obsidian/importer';
import { detectVaults } from './obsidian/vault';
import type { ObsidianStatusInfo } from '../shared/protocol';
import { ScreenNoteFilter } from './screenNoteFilter';
import { actionLabel, isCommandTurn } from './turnKind';
import { OpenerFilter } from './openerFilter';
import { buildPersona, buildTurnPrompt } from './persona';
import { PresenceStore } from './presence';
import type { Provider, ProviderEvent } from './providers/types';
import { ReminderScheduler } from './reminders/scheduler';
import { modelFor, routeTier } from './router';
import { SentenceSplitter, type Segment } from './sentenceSplitter';
import { TOOL_DEFS, type ToolName } from './tools/definitions';
import { CLAUDE_BUILTIN_TOOLS } from './providers/claude';
import { agyPaths, writeAgyPersona, writeAgyPlugin, type AgyPaths } from './providers/agyPlugin';
import { ToolExecutor, type Host } from './tools/executor';
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
}

interface Client { ws: WebSocket; role: ClientRole | null }
interface Turn {
  id: string; abort: AbortController; spoken: number; audioSent: number; audioDone: boolean; textDone: boolean;
  startedAt: number; firstText?: number; firstAudio?: number;
  tools: string[]; actions: string[]; // tools the brain used, and what Ghost did on the PC
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
  /** Conversations: in the Obsidian vault when one is connected, otherwise on this PC. */
  log!: HistoryStore;
  private approvals = new Map<string, (ok: boolean) => void>();
  private idleTimer: NodeJS.Timeout | null = null;
  private liveScreen = false; // always off at start: never silently watching after a restart
  private liveTimer: NodeJS.Timeout | null = null;
  private liveOffAt: number | undefined;
  private fallback: { reason: 'limit' | 'auth' | 'missing' | 'other'; retryAt: number; active: ProviderId } | null = null;
  private speechQueue: Promise<void> = Promise.resolve();
  memory!: FactStore;
  readonly reminders: ReminderScheduler;
  private executor!: ToolExecutor;
  private obsidian: ObsidianConnection | null = null;
  private obsidianKey = '';
  private workspace: string;
  private personaFile: string;
  private mcpConfigPath: string;
  private presence: PresenceStore;
  private agy: AgyPaths;
  private googleInSync = false; // whether the Google brain's own conversation holds everything said so far
  private greeted = false;
  private presenceTimer: NodeJS.Timeout | null = null;

  constructor(private readonly o: CoreOptions) {
    this.workspace = join(o.dataDir, 'workspace');
    this.personaFile = join(o.dataDir, 'persona.generated.md');
    this.mcpConfigPath = join(o.dataDir, 'ghost-mcp.json');
    mkdirSync(this.workspace, { recursive: true });
    this.reminders = new ReminderScheduler(join(o.dataDir, 'reminders.json'), r => this.fireReminder(r.id, r.text));
    this.connectStores();
    this.sessionId = this.log.current.claudeSessionId; // resume the Claude conversation after a restart
    this.presence = new PresenceStore(join(o.dataDir, 'presence.json'));
    this.agy = agyPaths(join(o.dataDir, 'agy'));
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
    this.obsidian?.start();
    this.reminders.start();
    // Pick up where we left off, or file away a conversation that went quiet while Ghost was closed.
    if (this.log.isStale(SESSION_IDLE_MS)) this.rotateConversation();
    this.warmBrains();
    this.presenceTimer = setInterval(() => this.presence.update({ lastSeen: Date.now() }), 5 * 60_000);
    this.presenceTimer.unref?.();
  }

  // ---------------------------------------------------------------- Obsidian

  /** History and memory live in the Obsidian vault when one is chosen in Settings, otherwise locally. */
  private connectStores(): void {
    const s = this.o.settings();
    this.obsidian?.stop();
    this.obsidian = null;
    const buffer = new ConversationLog(this.o.dataDir);
    if (s.obsidian.vaultPath) {
      this.obsidian = new ObsidianConnection(s.obsidian.vaultPath, {
        dataDir: this.o.dataDir, buffer, settings: this.o.settings,
        ask: prompt => this.quickAsk(prompt),
        notify: (level, text) => this.notify(level, text),
        onStatus: () => this.broadcast({ type: 'obsidian_status', status: this.obsidianStatus() }),
      });
      this.log = this.obsidian.conversations;
      this.memory = this.obsidian.memory;
    } else {
      this.log = buffer;
      this.memory = new MemoryStore(join(this.o.dataDir, 'memory.json'));
    }
    this.obsidianKey = `${s.obsidian.vaultPath}|${s.obsidian.folder}`;
    this.executor = new ToolExecutor(this.o.host, this.memory, this.reminders, this.log, this.obsidian?.tools);
  }

  /** Settings → Obsidian changed: switch vault or folder, and refresh the persona's Obsidian section. */
  obsidianChanged(): void {
    const s = this.o.settings();
    if (`${s.obsidian.vaultPath}|${s.obsidian.folder}` !== this.obsidianKey) {
      this.connectStores();
      this.obsidian?.start();
    }
    this.writeCliConfig();
    this.broadcast({ type: 'obsidian_status', status: this.obsidianStatus() });
  }

  private obsidianStatus(): ObsidianStatusInfo {
    return this.obsidian?.status() ?? { vaults: detectVaults(), connected: null, import: null, backupBytes: backupInfo(this.o.dataDir)?.bytes ?? null };
  }

  /** One short model call for housekeeping (filing notes), on the fast slot of whichever brain answers. */
  private async quickAsk(prompt: string): Promise<string> {
    const s = this.o.settings();
    const order = [s.provider, s.fallbackProvider].filter((p, i, a): p is ProviderId => !!p && a.indexOf(p) === i);
    let lastError = 'no brain available';
    for (const pid of order) {
      const provider = this.o.providers[pid];
      if (!provider) continue;
      let text = '';
      let failed = false;
      try {
        for await (const ev of provider.send({
          prompt, model: modelFor(pid, 'fast', s.brainModels), persona: '', personaFile: this.personaFile, mcpConfigPath: this.mcpConfigPath,
          workspace: this.workspace, signal: AbortSignal.timeout(180_000), oneShot: true,
        })) {
          if (ev.type === 'done') text = ev.text;
          if (ev.type === 'error') { failed = true; lastError = ev.message; }
        }
      } catch (e) { failed = true; lastError = String((e as Error).message ?? e); }
      if (!failed && text.trim()) return text;
    }
    throw new Error(lastError);
  }

  /** Start the brains' CLIs now, so the first message doesn't wait for them to boot. */
  private warmBrains(): void {
    const s = this.o.settings();
    const tier = s.modelTier === 'auto' ? 'balanced' : s.modelTier;
    const claude = this.o.providers.claude as { warm?: (r: object) => void } | undefined;
    if (s.provider === 'claude' || s.fallbackProvider === 'claude') {
      claude?.warm?.({
        model: modelFor('claude', tier, s.brainModels), personaFile: this.personaFile,
        mcpConfigPath: this.mcpConfigPath, workspace: this.workspace, sessionId: this.sessionId,
      });
    }
    // Antigravity is heavy (a large process plus a helper), so it's kept running only as the primary brain.
    if (s.provider === 'gemini') (this.o.providers.gemini as { warm?: (r: object) => void } | undefined)?.warm?.({ model: modelFor('gemini', tier, s.brainModels) });
  }

  private stopBrains(): void {
    for (const p of Object.values(this.o.providers)) (p as { stop?: () => void } | undefined)?.stop?.();
  }

  private voiceChoice() {
    const s = this.o.settings();
    return { engine: s.ttsEngine, elevenLabsVoiceId: s.elevenLabsVoiceId, edgeVoice: s.edgeVoice, elevenLabsModel: s.elevenLabsModel, stability: s.voiceStability, style: s.voiceStyle };
  }

  stop(): void {
    this.clearLiveTimer();
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presence.update({ lastSeen: Date.now() });
    this.obsidian?.stop();
    this.stopBrains();
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
    // Antigravity: Ghost's tools and permission hooks as a plugin, and the persona as GEMINI.md.
    writeAgyPlugin(this.agy, { nodeExecPath: this.o.nodeExecPath, mcpServerPath: this.o.mcpServerPath, env: { GHOST_CORE_URL: this.url, GHOST_TOKEN: this.token } });
    writeAgyPersona(this.agy, buildPersona(this.o.personaPath, s));
    // Claude Code: keep this folder free of project instructions.
    writeFileSync(join(this.workspace, 'README.txt'), 'Ghost working folder for the Claude CLI. Safe to leave empty.\n');
    // Running sessions read the old persona; the next message restarts them (same conversation).
    this.stopBrains();
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
        this.broadcast({ type: 'notice', level: 'info', text: this.obsidian
          ? "Conversation notes moved to Obsidian's trash. Your Memory notes are kept."
          : 'Conversation history cleared. Lasting facts are kept.' });
        return;
      case 'obsidian_status': this.send(client, { type: 'obsidian_status', status: this.obsidianStatus() }); return;
      case 'obsidian_import': void this.obsidian?.importHistory(); return;
      case 'obsidian_starter': void this.obsidian?.setupStarter().then(() => this.broadcast({ type: 'obsidian_status', status: this.obsidianStatus() })); return;
      case 'obsidian_starter_dismiss': this.obsidian?.dismissStarter(); return;
      case 'obsidian_delete_backup': this.obsidian?.deleteBackup(); this.broadcast({ type: 'obsidian_status', status: this.obsidianStatus() }); return;
      case 'voice_preview': return this.voicePreview(msg.engine, msg.voice, msg.text);
      case 'list_models': {
        const provider = this.o.providers[msg.provider as ProviderId];
        try {
          const models = (await provider?.listModels?.()) ?? [];
          this.send(client, { type: 'models', provider: msg.provider, models });
        } catch (e) {
          this.send(client, { type: 'models', provider: msg.provider, models: [], error: String((e as Error).message ?? e) });
        }
        return;
      }
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

  /** A new conversation for the Google brain too. */
  private resetGemini(): void {
    this.googleInSync = false;
    (this.o.providers.gemini as { resetHistory?: () => void } | undefined)?.resetHistory?.();
  }

  /** The last lines of the conversation, for a brain that may not have seen them. */
  private recentLines(): string[] {
    const s = this.o.settings();
    return this.log.lines().slice(-12).map(l => `${l.role === 'user' ? s.userName : s.assistantName}: ${l.text}`);
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

    const turn: Turn = { id: randomUUID(), abort: new AbortController(), spoken: 0, audioSent: 0, audioDone: false, textDone: false, startedAt: Date.now(), tools: [], actions: [] };
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
    const prompt = buildTurnPrompt(message, { now: new Date(), memories: this.memory.contextFor(message), userName: s.userName, screen });
    let order = [s.provider, s.fallbackProvider].filter((p, i, a): p is ProviderId => !!p && a.indexOf(p) === i);
    // While fallen back, don't pay for a failing call to the primary on every message.
    if (this.fallback && Date.now() < this.fallback.retryAt && order.length > 1) order = order.slice(1);
    const splitter = new SentenceSplitter(true);
    const opener = new OpenerFilter(s.userName); // no "Certainly, Aaron." before the answer
    const screenNote = new ScreenNoteFilter(); // "<screen>…</screen>" goes to the Obsidian transcript, not the bubble
    const clean = (t: string) => screenNote.push(opener.push(t));
    const flushText = () => { const rest = screenNote.push(opener.flush()); return rest + screenNote.flush(); };
    let reply = '';
    let sawText = false;
    const emit = (text: string) => {
      if (!text) return;
      reply += text;
      this.broadcast({ type: 'text_delta', turnId: turn.id, text });
      for (const seg of splitter.push(text)) this.queueSpeech(turn, seg);
    };

    for (const [attempt, pid] of order.entries()) {
      const provider = this.o.providers[pid];
      if (!provider) continue;
      const model = modelFor(pid, tier, s.brainModels);
      let failed: ProviderEvent & { type: 'error' } | null = null;
      try {
        for await (const ev of provider.send({
          prompt, model, persona: buildPersona(this.o.personaPath, s), personaFile: this.personaFile,
          sessionId: pid === 'claude' ? this.sessionId : undefined,
          history: pid === 'gemini' ? { lines: this.recentLines(), inSync: this.googleInSync } : undefined,
          mcpConfigPath: this.mcpConfigPath, workspace: this.workspace, signal: turn.abort.signal,
        })) {
          if (this.turn !== turn) return;
          if (ev.type === 'session' && pid === 'claude') this.setSession(ev.sessionId);
          else if (ev.type === 'text_delta') {
            sawText = true;
            this.markText(turn);
            if (this.state === 'searching') this.setState('thinking');
            emit(clean(ev.text));
          } else if (ev.type === 'tool_start') {
            turn.tools.push(ev.name);
            this.setState('searching', TOOL_LABEL[ev.name] ?? prettyTool(ev.name));
          } else if (ev.type === 'tool_end') {
            if (this.state === 'searching') this.setState('thinking');
          } else if (ev.type === 'done') {
            if (ev.sessionId && pid === 'claude') this.setSession(ev.sessionId);
            if (!sawText && ev.text) { sawText = true; this.markText(turn); emit(clean(ev.text)); }
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
        emit(flushText());
        for (const seg of splitter.flush()) this.queueSpeech(turn, seg);
        this.googleInSync = pid === 'gemini';
        const command = isCommandTurn(message, turn.tools, turn.actions, reply);
        this.log.append('user', message, { command });
        this.log.append('assistant', reply, { provider: pid, model: model || 'default', command, actions: turn.actions, screen: screenNote.screen });
        this.broadcast({ type: 'turn_end', turnId: turn.id, text: reply, provider: pid, model: model || 'default' });
        turn.textDone = true;
        this.markText(turn);
        this.maybeFinish(turn);
        return;
      }
      // Fall back to the next provider only if nothing has been said yet.
      if (sawText || attempt === order.length - 1) {
        emit(flushText());
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
      limit: `I've reached the usage limit on your ${pid} plan for now.`,
      auth: `I'm signed out of ${brainName(pid)}. Please run "${cliName(pid)}" in a terminal and sign in again.`,
      missing: `I can't find the ${cliName(pid)} command-line tool on this PC. It needs installing first.`,
      other: `Something went wrong on my side. The details are in the transcript.`,
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
  private queueSpeech(turn: Turn, seg: Segment): void {
    const s = this.o.settings();
    if (!s.voiceEnabled) return;
    const seq = turn.spoken++;
    const display = seg.display;
    const synth = !seg.speech ? Promise.resolve(null) : this.o.tts
      .speak(seg.speech, this.voiceChoice(), turn.abort.signal)
      .catch(e => { this.broadcast({ type: 'notice', level: 'warn', text: `Voice unavailable: ${String(e.message ?? e)}` }); return null; });
    // Synthesis runs in parallel, but delivery keeps sentence order.
    this.speechQueue = this.speechQueue.then(async () => {
      const audio = await synth;
      if (this.turn !== turn || turn.abort.signal.aborted) return;
      if (audio) {
        if (this.state !== 'speaking' && this.state !== 'error') this.setState('speaking');
        if (turn.firstAudio === undefined) turn.firstAudio = Date.now() - turn.startedAt;
        turn.audioSent++;
        this.broadcast({ type: 'audio', turnId: turn.id, seq, mime: audio.mime, data: audio.audio.toString('base64'), engine: audio.engine, last: false, display });
      } else {
        // Keep the sequence contiguous so the player doesn't wait for a sentence that will never come.
        this.broadcast({ type: 'audio', turnId: turn.id, seq, mime: 'audio/mpeg', data: '', engine: 'none', last: false, display });
      }
      if (seq === turn.spoken - 1 && turn.textDone) this.maybeFinish(turn);
    });
  }

  /** Note when the reply's first text arrived (for the timings readout). */
  private markText(turn: Turn): void {
    if (turn.firstText === undefined) turn.firstText = Date.now() - turn.startedAt;
  }

  /** When all text is in and every sentence is synthesised, tell clients the last chunk has gone. */
  private maybeFinish(turn: Turn): void {
    void this.speechQueue.then(() => {
      if (this.turn !== turn || turn.audioDone) return;
      if (!turn.textDone) return;
      turn.audioDone = true;
      this.broadcast({ type: 'timing', turnId: turn.id, firstTextMs: turn.firstText, firstAudioMs: turn.firstAudio });
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
      const label = actionLabel(tool, args);
      if (label && this.turn) this.turn.actions.push(label);
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
    const line = text ?? `Good evening, ${s.userName}. Your calendar is clear, the weather is holding, and I've kept an eye on things while you were away.`;
    await this.speakStandalone(`preview-${randomUUID()}`, line, {
      ...this.voiceChoice(),
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
      ? (changed ? `Watching your screen.` : `Already watching your screen.`)
      : (changed ? `Stopped watching your screen.` : `I wasn't watching your screen.`);
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
      this.say('Stopped watching your screen.');
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
      const audio = await this.o.tts.speak(text, choice ?? this.voiceChoice());
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

  /** File a finished conversation: as a note in Obsidian, or (locally) as a short episode summary. */
  private async archiveConversation(conversationId: string): Promise<void> {
    if (this.obsidian) { await this.obsidian.close(conversationId); return; }
    const s = this.o.settings();
    const lines = this.log.lines(conversationId).map(l => `${l.role === 'user' ? s.userName : s.assistantName}: ${l.text}`);
    if (lines.length < 6) return;
    const provider = this.o.providers[s.provider];
    if (!provider || s.provider === 'mock') return;
    let summary = '';
    try {
      for await (const ev of provider.send({
        prompt: `Summarise this conversation in 2-3 sentences for your long-term memory. Note decisions, plans and facts about ${s.userName}. Reply with the summary only.\n\n${lines.join('\n').slice(-12_000)}`,
        model: modelFor(s.provider, 'fast', s.brainModels), persona: '', personaFile: this.personaFile, mcpConfigPath: this.mcpConfigPath,
        workspace: this.workspace, signal: new AbortController().signal, oneShot: true,
      })) if (ev.type === 'done') summary = ev.text;
    } catch { /* memory is best effort */ }
    if (summary.trim()) this.memory.addEpisode(summary);
  }
}

/** The command Aaron runs to sign a brain back in. */
function cliName(id: string): string { return ({ claude: 'claude', gemini: 'agy' } as Record<string, string>)[id] ?? id; }

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
