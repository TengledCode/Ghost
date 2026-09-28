import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { GhostCore } from '../src/core/ghostCore';
import { MockProvider } from '../src/core/providers/mock';
import { TtsService } from '../src/core/tts/service';
import type { TtsEngine } from '../src/core/tts/types';
import type { ClientMessage, CoreMessage } from '../src/shared/protocol';
import { mergeSettings } from '../src/shared/settings';

const fakeTts: TtsEngine = { id: 'edge', synthesize: async t => ({ audio: Buffer.from(`mp3:${t}`), mime: 'audio/mpeg' }) };

let core: GhostCore | null = null;
afterEach(() => core?.stop());

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-core-'));
  core = new GhostCore({
    dataDir: dir,
    personaPath: join(__dirname, '../config/persona.md'),
    mcpServerPath: '/out/main/mcpServer.js',
    nodeExecPath: process.execPath,
    providers: { claude: new MockProvider() as never },
    tts: new TtsService(fakeTts, fakeTts),
    host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {} },
    settings: () => mergeSettings({ provider: 'claude', fallbackProvider: null }),
    port: 0,
    approvalTimeoutMs: 2000,
  });
  await core.start();
  return { core, dir };
}

function client(url: string, token: string, role: 'ui' | 'mcp') {
  const ws = new WebSocket(url);
  const inbox: CoreMessage[] = [];
  const waiters: { pred: (m: CoreMessage) => boolean; resolve: (m: CoreMessage) => void }[] = [];
  ws.on('message', raw => {
    const m = JSON.parse(String(raw)) as CoreMessage;
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const ready = new Promise<void>(r => ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', token, role })); r(); }));
  return {
    ws, inbox, ready,
    send: (m: ClientMessage) => ws.send(JSON.stringify(m)),
    waitFor: (pred: (m: CoreMessage) => boolean, ms = 6000) => new Promise<CoreMessage>((resolve, reject) => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout waiting for message')), ms);
    }),
  };
}

describe('GhostCore', () => {
  it('rejects clients without the token', async () => {
    const { core } = await setup();
    const ws = new WebSocket(core.url);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', token: 'nope', role: 'ui' }));
    const code = await new Promise(r => ws.on('close', c => r(c)));
    expect(code).toBe(4003);
  });

  it('runs a full turn: thinking → searching → speaking → done → idle, audio in order', async () => {
    const { core } = await setup();
    const ui = client(core.url, core.token, 'ui');
    await ui.ready;
    await ui.waitFor(m => m.type === 'welcome');
    ui.send({ type: 'user_message', text: 'search the news please' });
    const last = await ui.waitFor(m => m.type === 'audio' && m.last) as Extract<CoreMessage, { type: 'audio' }>;
    const states = ui.inbox.filter(m => m.type === 'state').map(m => (m as { state: string }).state);
    expect(states).toEqual(expect.arrayContaining(['thinking', 'searching', 'speaking']));
    expect(states.indexOf('searching')).toBeGreaterThan(states.indexOf('thinking'));
    const audio = ui.inbox.filter((m): m is Extract<CoreMessage, { type: 'audio' }> => m.type === 'audio' && !m.last);
    expect(audio.map(a => a.seq)).toEqual(audio.map((_, i) => i));
    expect(last.seq).toBe(audio.length);
    expect(Buffer.from(audio[0].data, 'base64').toString()).toMatch(/^mp3:Understood, Aaron\./);
    // Each chunk carries the text it speaks, so the overlay can reveal words in step with the voice.
    const end0 = await ui.waitFor(m => m.type === 'turn_end') as Extract<CoreMessage, { type: 'turn_end' }>;
    expect(audio.map(a => a.display ?? '').join('').trimEnd()).toBe(end0.text.trimEnd());
    const end = await ui.waitFor(m => m.type === 'turn_end') as Extract<CoreMessage, { type: 'turn_end' }>;
    expect(end.text).toContain('search the news please');
    ui.send({ type: 'playback_finished', turnId: last.turnId });
    await ui.waitFor(m => m.type === 'state' && m.state === 'done');
    await ui.waitFor(m => m.type === 'state' && m.state === 'idle' && ui.inbox.findIndex(x => x.type === 'state' && x.state === 'done') < ui.inbox.indexOf(m));
    ui.ws.close();
  });

  it('runs safe tools directly and gates risky ones behind approval', async () => {
    const { core, dir } = await setup();
    const ui = client(core.url, core.token, 'ui');
    const mcp = client(core.url, core.token, 'mcp');
    await Promise.all([ui.ready, mcp.ready]);
    await ui.waitFor(m => m.type === 'welcome');

    mcp.send({ type: 'tool_call', id: 't1', tool: 'remember', args: { fact: 'Aaron likes Earl Grey' } });
    expect(await mcp.waitFor(m => m.type === 'tool_result' && m.id === 't1')).toMatchObject({ ok: true });
    expect(ui.inbox.some(m => m.type === 'approval_request')).toBe(false);
    expect(core.memory.list()[0].text).toBe('Aaron likes Earl Grey');

    const target = join(dir, 'note.txt');
    mcp.send({ type: 'tool_call', id: 't2', tool: 'write_file', args: { path: target, content: 'hello' } });
    const req = await ui.waitFor(m => m.type === 'approval_request') as Extract<CoreMessage, { type: 'approval_request' }>;
    expect(req.summary).toContain(target);
    ui.send({ type: 'approval_response', id: req.id, approved: true });
    expect(await mcp.waitFor(m => m.type === 'tool_result' && m.id === 't2')).toMatchObject({ ok: true });
    expect(readFileSync(target, 'utf8')).toBe('hello');

    const denied = join(dir, 'denied.txt');
    mcp.send({ type: 'tool_call', id: 't3', tool: 'write_file', args: { path: denied, content: 'x' } });
    const req2 = await ui.waitFor(m => m.type === 'approval_request' && m.id !== req.id) as Extract<CoreMessage, { type: 'approval_request' }>;
    ui.send({ type: 'approval_response', id: req2.id, approved: false });
    const res = await mcp.waitFor(m => m.type === 'tool_result' && m.id === 't3') as Extract<CoreMessage, { type: 'tool_result' }>;
    expect(res.ok).toBe(false);
    expect(res.result).toMatch(/declined/);
    expect(existsSync(denied)).toBe(false);

    // Unanswered approvals time out as a denial.
    mcp.send({ type: 'tool_call', id: 't4', tool: 'delete_path', args: { path: target } });
    expect(await mcp.waitFor(m => m.type === 'tool_result' && m.id === 't4', 5000)).toMatchObject({ ok: false });
    expect(existsSync(target)).toBe(true);
    ui.ws.close(); mcp.ws.close();
  });

  it('writes CLI config pointing the MCP bridge at this core', async () => {
    const { core, dir } = await setup();
    const cfg = JSON.parse(readFileSync(join(dir, 'ghost-mcp.json'), 'utf8'));
    expect(cfg.mcpServers.ghost.env).toMatchObject({ GHOST_CORE_URL: core.url, GHOST_TOKEN: core.token, ELECTRON_RUN_AS_NODE: '1' });
    const gem = JSON.parse(readFileSync(join(dir, 'workspace/.gemini/settings.json'), 'utf8'));
    expect(gem.tools.exclude).toContain('run_shell_command');
    expect(readFileSync(join(dir, 'persona.generated.md'), 'utf8')).toContain('Call him "Aaron"');
  });
});

import type { Provider, ProviderEvent } from '../src/core/providers/types';

class LimitedProvider implements Provider {
  readonly id = 'claude' as const;
  calls = 0;
  async isAvailable() { return true; }
  async *send(): AsyncIterable<ProviderEvent> { this.calls++; yield { type: 'error', message: 'Claude usage limit reached', kind: 'limit' }; }
}

describe('provider fallback alert', () => {
  it('says it once per outage, shows the fallback, and stops hammering the limited provider', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-fb-'));
    const limited = new LimitedProvider();
    core = new GhostCore({
      dataDir: dir, personaPath: join(__dirname, '../config/persona.md'), mcpServerPath: '/x.js', nodeExecPath: process.execPath,
      providers: { claude: limited, gemini: new MockProvider() as never },
      tts: new TtsService(fakeTts, fakeTts), host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {} },
      settings: () => mergeSettings({ provider: 'claude', fallbackProvider: 'gemini' }), port: 0,
    });
    await core.start();
    const ui = client(core.url, core.token, 'ui');
    await ui.ready;
    await ui.waitFor(m => m.type === 'welcome');

    ui.send({ type: 'user_message', text: 'hello there' });
    const end1 = await ui.waitFor(m => m.type === 'turn_end') as Extract<CoreMessage, { type: 'turn_end' }>;
    expect(end1.provider).toBe('gemini'); // the fallback answered
    expect(ui.inbox).toContainEqual({ type: 'provider', active: 'gemini', primary: 'claude', reason: 'limit' });
    await ui.waitFor(m => m.type === 'audio' && m.last);
    const said = ui.inbox.filter((m): m is Extract<CoreMessage, { type: 'audio' }> => m.type === 'audio' && !!m.data)
      .map(a => Buffer.from(a.data, 'base64').toString());
    expect(said[0]).toBe("mp3:Claude's limit is reached for now, Aaron. I'll carry on with Gemini.");

    const before = ui.inbox.length;
    ui.send({ type: 'user_message', text: 'and again' });
    await ui.waitFor(m => m.type === 'turn_end' && ui.inbox.indexOf(m) >= before);
    await ui.waitFor(m => m.type === 'audio' && m.last && ui.inbox.indexOf(m) >= before);
    const second = ui.inbox.slice(before).filter((m): m is Extract<CoreMessage, { type: 'audio' }> => m.type === 'audio' && !!m.data)
      .map(a => Buffer.from(a.data, 'base64').toString());
    expect(second.some(t => t.includes('limit is reached'))).toBe(false); // not announced again
    expect(limited.calls).toBe(1); // skipped during the retry window
    ui.ws.close();
  }, 20_000);
});

describe('conversation memory across restarts', () => {
  it('resumes the same conversation and Claude session after the core restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-restart-'));
    const make = () => new GhostCore({
      dataDir: dir, personaPath: join(__dirname, '../config/persona.md'), mcpServerPath: '/x.js', nodeExecPath: process.execPath,
      providers: { claude: new MockProvider() as never }, tts: new TtsService(fakeTts, fakeTts),
      host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {} },
      settings: () => mergeSettings({ provider: 'claude', fallbackProvider: null, voiceEnabled: false }), port: 0,
    });
    const first = make();
    await first.start();
    await first.userMessage('remember the blue tie for Saturday');
    const id = first.log.current.conversationId;
    expect(first.log.current.claudeSessionId).toBe('mock-session');
    first.stop();

    core = make(); // Ghost restarted
    await core.start();
    expect(core.log.current.conversationId).toBe(id);
    expect(core.log.current.claudeSessionId).toBe('mock-session');
    expect(core.log.lines().map(l => l.text)[0]).toBe('remember the blue tie for Saturday');
  }, 20_000);
});
