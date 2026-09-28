import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeLiveProvider } from '../src/core/providers/claudeLive';
import type { ProviderEvent, SendRequest } from '../src/core/providers/types';

const FAKE = join(__dirname, 'fixtures', 'fake-claude-live.mjs');
let provider: ClaudeLiveProvider | null = null;
afterEach(() => provider?.stop());

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ghost-live-'));
  const log = join(dir, 'launches.log');
  process.env.FAKE_CLAUDE_LOG = log;
  provider = new ClaudeLiveProvider(FAKE);
  const req = (prompt: string, extra: Partial<SendRequest> = {}): SendRequest => ({
    prompt, model: 'sonnet', persona: '', personaFile: join(dir, 'p.md'), mcpConfigPath: join(dir, 'm.json'), workspace: dir,
    signal: new AbortController().signal, ...extra,
  });
  const launches = () => readFileSync(log, 'utf8').trim().split('\n');
  return { req, launches };
}

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}
const reply = (evs: ProviderEvent[]) => (evs.find(e => e.type === 'done') as { text: string } | undefined)?.text;

describe('ClaudeLiveProvider (one Claude process kept running)', () => {
  it('answers several messages from one process and switches models without restarting', async () => {
    const { req, launches } = setup();
    provider!.warm(req(''));
    const first = await collect(provider!.send(req('hello')));
    expect(reply(first)).toBe('[sonnet] hello');
    const sessionId = (first.find(e => e.type === 'session') as { sessionId: string }).sessionId;
    expect(reply(await collect(provider!.send(req('again', { model: 'haiku', sessionId }))))).toBe('[haiku] again');
    expect(launches()).toEqual(['launch -']);
  });

  it('interrupts a reply on cancel, and the next message still works', async () => {
    const { req } = setup();
    const ctl = new AbortController();
    const slow = collect(provider!.send(req('slow one', { signal: ctl.signal })));
    setTimeout(() => ctl.abort(), 200);
    const evs = await slow;
    expect(evs.some(e => e.type === 'error')).toBe(false);
    const sessionId = (evs.find(e => e.type === 'session') as { sessionId: string }).sessionId;
    expect(reply(await collect(provider!.send(req('next', { sessionId }))))).toBe('[sonnet] next');
  });

  it('starts afresh for a new conversation, and after the process dies', async () => {
    const { req, launches } = setup();
    const first = await collect(provider!.send(req('hello')));
    const sessionId = (first.find(e => e.type === 'session') as { sessionId: string }).sessionId;
    await collect(provider!.send(req('new chat'))); // no session: a new conversation
    expect(launches()).toHaveLength(2);
    const died = await collect(provider!.send(req('die', { sessionId: 'abc' })));
    expect(died.some(e => e.type === 'error')).toBe(true);
    expect(reply(await collect(provider!.send(req('back', { sessionId }))))).toBe('[sonnet] back');
    expect(launches().at(-1)).toBe(`launch ${sessionId}`);
  });

  it('runs one-shot requests (conversation summaries) outside the live session', async () => {
    const { req, launches } = setup();
    const first = await collect(provider!.send(req('hello')));
    const sessionId = (first.find(e => e.type === 'session') as { sessionId: string }).sessionId;
    // A separate `claude -p` run (this fake gives it no answer); the live session carries on untouched.
    await collect(provider!.send(req('summary', { oneShot: true, signal: AbortSignal.timeout(2000) }))).catch(() => []);
    expect(reply(await collect(provider!.send(req('still here', { sessionId }))))).toBe('[sonnet] still here');
    expect(launches()).toEqual(['launch -', 'launch -']);
  });
});
