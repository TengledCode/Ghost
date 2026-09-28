import { describe, expect, it } from 'vitest';
import { isPureCommand, parseScreenCommand } from '../src/core/liveScreen';
import { buildTurnPrompt } from '../src/core/persona';
import { mergeSettings } from '../src/shared/settings';

describe('live screen commands', () => {
  it.each([
    ['watch my screen', 'on'], ['Watch my screen.', 'on'], ['please keep an eye on my screen', 'on'],
    ['look at my screen from now on', 'on'], ['live view on', 'on'], ['turn on live screen', 'on'], ['start watching my screen', 'on'],
    ['stop watching', 'off'], ['ok stop watching my screen', 'off'], ["don't watch my screen", 'off'], ['live view off', 'off'], ['stop looking at the screen', 'off'],
    ["what's on my screen?", 'once'], ['can you look at my screen and tell me which one is cheaper', 'once'], ['what is this error', 'once'],
    ["I'm watching a film tonight", null], ['I stopped watching that show', null], ['open spotify', null], ['my screen protector cracked lol', null],
  ])('%s → %s', (text, want) => {
    expect(parseScreenCommand(text)).toBe(want);
  });
  it('treats short on/off instructions as commands, not questions', () => {
    expect(isPureCommand('watch my screen', 'on')).toBe(true);
    expect(isPureCommand("what's on my screen?", 'once')).toBe(false);
  });
});

describe('screen context in the prompt', () => {
  const now = new Date('2026-09-28T09:00:00Z');
  it('includes the snapshot path only when there is one', () => {
    expect(buildTurnPrompt('hi', { now, memories: [], userName: 'Aaron' })).not.toMatch(/screen/i);
    const p = buildTurnPrompt('what is this?', { now, memories: [], userName: 'Aaron', screen: { path: 'C:\\g\\screens\\s.png' } });
    expect(p).toMatch(/Aaron's screen right now.*C:\\g\\screens\\s\.png.*Read tool/s);
    expect(buildTurnPrompt('x', { now, memories: [], userName: 'Aaron', screen: { error: 'denied' } })).toMatch(/could not be captured/);
  });
  it('clamps the auto-off minutes', () => {
    expect(mergeSettings({ liveScreenAutoOffMinutes: 1 }).liveScreenAutoOffMinutes).toBe(5);
    expect(mergeSettings({ liveScreenAutoOffMinutes: 999 }).liveScreenAutoOffMinutes).toBe(240);
    expect(mergeSettings({}).liveScreenAutoOff).toBe(false);
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import { GhostCore } from '../src/core/ghostCore';
import type { Provider, ProviderEvent, SendRequest } from '../src/core/providers/types';
import { TtsService } from '../src/core/tts/service';
import type { TtsEngine } from '../src/core/tts/types';
import type { CoreMessage } from '../src/shared/protocol';
import type { Settings } from '../src/shared/settings';

const silent: TtsEngine = { id: 'edge', synthesize: async () => ({ audio: Buffer.from('x'), mime: 'audio/mpeg' }) };

/** Answers instantly and remembers the prompts it was sent. */
class RecordingProvider implements Provider {
  readonly id = 'claude' as const;
  prompts: string[] = [];
  async isAvailable() { return true; }
  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    this.prompts.push(req.prompt);
    yield { type: 'text_delta', text: 'Noted.' };
    yield { type: 'done', text: 'Noted.' };
  }
}

function makeCore(over: Partial<Settings> = {}, capture?: () => Promise<{ path: string; width: number; height: number; takenAt: string }>) {
  const provider = new RecordingProvider();
  let settings = mergeSettings({ provider: 'claude', fallbackProvider: null, voiceEnabled: false, ...over });
  const core = new GhostCore({
    dataDir: mkdtempSync(join(tmpdir(), 'ghost-live-')), personaPath: join(__dirname, '../config/persona.md'), mcpServerPath: '/x.js',
    nodeExecPath: process.execPath, providers: { claude: provider }, tts: new TtsService(silent, silent),
    host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {} }, settings: () => settings, captureScreen: capture,
  });
  const sent: CoreMessage[] = [];
  (core as unknown as { broadcast: (m: CoreMessage) => void }).broadcast = m => { sent.push(m); };
  return { core, provider, sent, set: (p: Partial<Settings>) => { settings = mergeSettings({ ...settings, ...p }); } };
}

afterEach(() => { vi.useRealTimers(); });

describe('live screen view in the core', () => {
  const shot = { path: 'C:\\ghost\\screens\\s1.png', width: 1568, height: 882, takenAt: '2026-09-28T10:00:00Z' };

  it('switches on from a typed command without a model call, and says so', async () => {
    const { core, provider, sent } = makeCore({}, async () => shot);
    await core.userMessage('watch my screen');
    expect(core.isLiveScreen).toBe(true);
    expect(provider.prompts).toHaveLength(0);
    expect(sent).toContainEqual({ type: 'live_screen', on: true, offAt: undefined });
    expect(sent.some(m => m.type === 'turn_end' && /watching your screen/.test(m.text))).toBe(true);
    await core.userMessage('stop watching');
    expect(core.isLiveScreen).toBe(false);
  });

  it('attaches a fresh snapshot to every message while live, and only then', async () => {
    const capture = vi.fn(async () => shot);
    const { core, provider } = makeCore({}, capture);
    await core.userMessage('which of these is cheaper?');
    expect(capture).not.toHaveBeenCalled();
    core.setLiveScreen(true, false);
    await core.userMessage('which of these is cheaper?');
    await core.userMessage('and the second one?');
    expect(capture).toHaveBeenCalledTimes(2);
    expect(provider.prompts[1]).toContain(shot.path);
    expect(provider.prompts[0]).not.toContain('screen right now');
  });

  it('takes a one-off look when asked, without switching the mode on', async () => {
    const capture = vi.fn(async () => shot);
    const { core, provider } = makeCore({}, capture);
    await core.userMessage("what's on my screen?");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(provider.prompts[0]).toContain(shot.path);
    expect(core.isLiveScreen).toBe(false);
  });

  it('still answers when the capture fails', async () => {
    const { core, provider, sent } = makeCore({}, async () => { throw new Error('capture denied'); });
    core.setLiveScreen(true, false);
    await core.userMessage('what is this?');
    expect(provider.prompts[0]).toMatch(/could not be captured this time \(capture denied\)/);
    expect(sent.some(m => m.type === 'turn_end' && m.text === 'Noted.')).toBe(true);
  });

  it('auto-off: fires after the quiet minutes, resets on messages, and never fires when disabled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { core, sent, set } = makeCore({ liveScreenAutoOff: true, liveScreenAutoOffMinutes: 10 }, async () => shot);
    core.setLiveScreen(true, false);
    const on = sent.find(m => m.type === 'live_screen' && m.on) as Extract<CoreMessage, { type: 'live_screen' }>;
    expect(on.offAt).toBe(Date.now() + 10 * 60_000);
    vi.advanceTimersByTime(8 * 60_000);
    await core.userMessage('still there?'); // resets the quiet timer
    vi.advanceTimersByTime(8 * 60_000);
    expect(core.isLiveScreen).toBe(true);
    vi.advanceTimersByTime(3 * 60_000);
    expect(core.isLiveScreen).toBe(false);
    expect(sent.some(m => m.type === 'notice' && /switched off after 10 quiet minutes/.test(m.text))).toBe(true);

    set({ liveScreenAutoOff: false });
    core.setLiveScreen(true, false);
    vi.advanceTimersByTime(300 * 60_000);
    expect(core.isLiveScreen).toBe(true);
    // Turning the option on while live starts the countdown immediately.
    set({ liveScreenAutoOff: true, liveScreenAutoOffMinutes: 5 });
    core.settingsChanged();
    vi.advanceTimersByTime(5 * 60_000 + 10);
    expect(core.isLiveScreen).toBe(false);
    core.stop();
  });
});
