import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agyHookDecision, agyPaths, parseAgyModels, pickAgyModel, writeAgyPlugin } from '../src/core/providers/agyPlugin';
import { AntigravityProvider } from '../src/core/providers/antigravity';
import type { ProviderEvent, SendRequest } from '../src/core/providers/types';

const FAKE = join(__dirname, 'fixtures', 'fake-agy.mjs');
let provider: AntigravityProvider | null = null;
afterEach(() => { provider?.stop(); delete process.env.FAKE_AGY_LOGGED_OUT; });

function setup(opts: { hooks?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-agy-'));
  const paths = agyPaths(join(dir, 'agy'));
  writeAgyPlugin(paths, { nodeExecPath: process.execPath, mcpServerPath: '/nowhere/mcpServer.js', env: { GHOST_TOKEN: 't' }, windows: false });
  if (opts.hooks === false) rmSync(join(paths.plugin, 'hooks.json'));
  process.env.FAKE_AGY_LOG = join(dir, 'launches.log');
  process.env.FAKE_AGY_STATE = join(dir, 'conversations');
  provider = new AntigravityProvider({ dir: join(dir, 'agy'), command: FAKE });
  const req = (prompt: string, extra: Partial<SendRequest> = {}): SendRequest => ({
    prompt, model: 'flash', persona: '', personaFile: '', mcpConfigPath: '', workspace: dir, signal: new AbortController().signal, ...extra,
  });
  const launches = () => (existsSync(process.env.FAKE_AGY_LOG!) ? readFileSync(process.env.FAKE_AGY_LOG!, 'utf8').trim().split('\n') : []);
  return { dir, req, launches, state: process.env.FAKE_AGY_STATE };
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}
const reply = (evs: ProviderEvent[]) => (evs.find(e => e.type === 'done') as { text: string } | undefined)?.text;
const streamed = (evs: ProviderEvent[]) => evs.filter(e => e.type === 'text_delta').map(e => (e as { text: string }).text).join('');

describe('AntigravityProvider (Gemini on a Google AI Pro subscription)', () => {
  it('streams replies from one running agy, on the newest Flash model', async () => {
    const { req, launches } = setup();
    const first = await collect(provider!.send(req('hello')));
    expect(streamed(first)).toBe('[gemini-3.8-flash-high] hello');
    expect(reply(first)).toBe('[gemini-3.8-flash-high] hello');
    expect(reply(await collect(provider!.send(req('again'))))).toBe('[gemini-3.8-flash-high] again');
    expect(launches()).toEqual(['launch model=gemini-3.8-flash-high conversation=-']);
  });

  it('switches to Pro for deep questions by resuming the same conversation', async () => {
    const { req, launches } = setup();
    const first = await collect(provider!.send(req('hello')));
    const id = (first.find(e => e.type === 'done') as { sessionId: string }).sessionId;
    expect(reply(await collect(provider!.send(req('think hard', { model: 'pro' }))))).toBe('[gemini-3.8-pro-high] think hard');
    expect(launches()[1]).toBe(`launch model=gemini-3.8-pro-high conversation=${id}`);
  });

  it('stops a reply by ending agy, then carries on in the same conversation', async () => {
    const { req, launches } = setup();
    const ctl = new AbortController();
    const slow = collect(provider!.send(req('slow one', { signal: ctl.signal })));
    setTimeout(() => ctl.abort(), 300);
    expect((await slow).some(e => e.type === 'error')).toBe(false);
    const next = await collect(provider!.send(req('next', { history: { lines: ['Aaron: hi'], inSync: true } })));
    expect(reply(next)).toBe('[gemini-3.8-flash-high] next'); // resumed: no history needed
    expect(launches()[1]).toMatch(/conversation=[0-9a-f-]{36}$/);
  });

  it('brings a new or lost conversation up to date with the recent history', async () => {
    const { req, state } = setup();
    const first = await collect(provider!.send(req('hello', { history: { lines: ['Aaron: earlier', 'Ghost: yes'], inSync: false } })));
    expect(reply(first)).toContain('<recent_conversation>\nAaron: earlier\nGhost: yes\n</recent_conversation>');
    // agy forgets the conversation (e.g. deleted); the next process starts afresh and gets the history again.
    rmSync(state!, { recursive: true, force: true });
    provider!.stop();
    const again = await collect(provider!.send(req('where were we', { history: { lines: ['Aaron: earlier'], inSync: true } })));
    expect(reply(again)).toContain('<recent_conversation>');
  });

  it("lets agy use Ghost's tools but nothing that acts on the PC by itself", async () => {
    const { req } = setup();
    const ghost = await collect(provider!.send(req('tool:call_mcp_tool:ghost_ghost')));
    expect(ghost).toContainEqual({ type: 'tool_start', name: 'mcp__ghost__open_app' });
    expect(reply(ghost)).toBe('call_mcp_tool allowed.');
    expect(reply(await collect(provider!.send(req('tool:run_command'))))).toBe('run_command denied.');
    expect(reply(await collect(provider!.send(req('tool:call_mcp_tool:someone_else'))))).toBe('call_mcp_tool denied.');
    expect(reply(await collect(provider!.send(req('tool:view_file'))))).toBe('view_file allowed.');
  });

  it("refuses to run if the safety hooks didn't load", async () => {
    const { req } = setup({ hooks: false });
    const evs = await collect(provider!.send(req('tool:run_command')));
    expect(evs.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/safety hook/) });
    expect(evs.some(e => e.type === 'tool_start')).toBe(false);
  });

  it('reports a signed-out account as an auth problem', async () => {
    const { req } = setup();
    process.env.FAKE_AGY_LOGGED_OUT = '1';
    const evs = await collect(provider!.send(req('hello')));
    expect(evs.at(-1)).toMatchObject({ type: 'error', kind: 'auth' });
  });
});

describe('Antigravity plugin rules', () => {
  it('allows reading, web lookups and Ghost tools; denies everything else', () => {
    for (const name of ['view_file', 'search_web', 'read_url_content', 'grep_search']) expect(agyHookDecision({ name }).decision).toBe('allow');
    expect(agyHookDecision({ name: 'call_mcp_tool', args: { ServerName: 'ghost_ghost' } }).decision).toBe('allow');
    for (const name of ['run_command', 'write_to_file', 'replace_file_content', 'browser_click_element', 'generate_image']) expect(agyHookDecision({ name }).decision).toBe('deny');
    expect(agyHookDecision({ name: 'call_mcp_tool', args: { ServerName: 'other_server' } }).decision).toBe('deny');
    expect(agyHookDecision({}).decision).toBe('deny');
  });

  it('picks the newest model of a family', () => {
    const ids = parseAgyModels('Fetching...\ngemini-3.8-flash-high\tx\ngemini-3.8-flash-low\ngemini-3.1-pro-high\ngemini-3.8-pro-medium\ngemini-3.8-pro-high\ngemini-3.8-flash-lite-low\nclaude-opus-4-6');
    expect(pickAgyModel(ids, 'flash')).toBe('gemini-3.8-flash-high');
    expect(pickAgyModel(ids, 'pro')).toBe('gemini-3.8-pro-high');
    expect(pickAgyModel([], 'pro')).toBe('');
  });

  it('writes Windows hook wrappers that agy can run through cmd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-agy-win-'));
    const paths = agyPaths(dir);
    writeAgyPlugin(paths, { nodeExecPath: 'C:\\Program Files\\Ghost\\Ghost.exe', mcpServerPath: 'C:\\x\\mcpServer.js', env: {}, windows: true });
    const hooks = JSON.parse(readFileSync(join(paths.plugin, 'hooks.json'), 'utf8'))['ghost-permissions'];
    expect(hooks.PreToolUse[0].hooks[0].command).toBe(join(paths.plugin, 'hook.cmd'));
    expect(readFileSync(join(paths.plugin, 'hook.cmd'), 'utf8')).toBe('@set ELECTRON_RUN_AS_NODE=1\r\n@"C:\\Program Files\\Ghost\\Ghost.exe" "%~dp0hook.js"\r\n');
  });
});
