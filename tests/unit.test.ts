import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { classify } from '../src/core/approvals/classify';
import { MemoryStore } from '../src/core/memory/store';
import { buildTurnPrompt } from '../src/core/persona';
import { ClaudeStreamParser, claudeArgs } from '../src/core/providers/claude';
import { quoteWin } from '../src/core/providers/spawnCli';
import { classifyError, type ProviderEvent } from '../src/core/providers/types';
import { ReminderScheduler } from '../src/core/reminders/scheduler';
import { modelFor, routeTier } from '../src/core/router';
import { SentenceSplitter } from '../src/core/sentenceSplitter';
import { TtsService } from '../src/core/tts/service';
import { TtsError, type TtsEngine } from '../src/core/tts/types';
import { cornerPosition, MARGIN, nearestCorner, windowSize } from '../src/main/placement';
import { mergeSettings } from '../src/shared/settings';
import { shouldHide } from '../src/main/fullscreenWatcher';

const tmp = () => mkdtempSync(join(tmpdir(), 'ghost-'));
const lines = (f: string) => readFileSync(join(__dirname, 'fixtures', f), 'utf8').trim().split('\n');

describe('SentenceSplitter', () => {
  const speech = (segs: { speech: string }[]) => segs.map(x => x.speech);
  it('emits complete sentences as text streams in', () => {
    const s = new SentenceSplitter();
    const out = [...s.push('Very good, Aaron. I have opened'), ...s.push(' Spotify for you! Anything else'), ...s.push('?')];
    expect(speech(out)).toEqual(['Very good, Aaron.', 'I have opened Spotify for you!']);
    expect(speech(s.flush())).toEqual(['Anything else?']);
  });
  it('does not split on abbreviations or decimals', () => {
    const s = new SentenceSplitter();
    expect(speech(s.push('Dr. Smith says pi is 3.14 roughly, e.g. close enough. Next'))).toEqual(['Dr. Smith says pi is 3.14 roughly, e.g. close enough.']);
  });
  it('strips markdown and replaces code blocks in speech, but keeps the text exactly for display', () => {
    const s = new SentenceSplitter();
    const text = 'Here is **the** script:\n```ps1\nGet-Process\n```\nRun it with `pwsh`. ';
    const out = [...s.push(text), ...s.flush()];
    expect(speech(out).join(' ')).toContain('the code is in the transcript');
    expect(speech(out).join(' ')).not.toMatch(/[*`]/);
    expect(out.map(x => x.display).join('').trimEnd()).toBe(text.trimEnd()); // only trailing whitespace is dropped
  });
  it('keeps a code-only segment in order with nothing to say', () => {
    const s = new SentenceSplitter();
    const out = [...s.push('Right then, here it is.\n\n'), ...s.push('```\nx = 1\n```\n\n'), ...s.push('That should do it. '), ...s.flush()];
    expect(out.map(x => x.display.trim())).toEqual(['Right then, here it is.', '```\nx = 1\n```', 'That should do it.']);
    expect(out[1].speech).toBe('(the code is in the transcript)');
  });
});

describe('router', () => {
  it('routes by effort', () => {
    expect(routeTier('hi ghost', 'auto')).toBe('fast');
    expect(routeTier('open spotify', 'auto')).toBe('fast');
    expect(routeTier('remind me in 10 minutes to stretch', 'auto')).toBe('fast');
    expect(routeTier('Can you summarise the main arguments for and against remote work?', 'auto')).toBe('balanced');
    expect(routeTier('think hard about how I should structure my savings', 'auto')).toBe('deep');
    expect(routeTier('hi', 'deep')).toBe('deep');
  });
  it('maps tiers to CLI models', () => {
    expect(modelFor('claude', 'fast')).toBe('haiku');
    expect(modelFor('claude', 'deep')).toBe('opus');
    expect(modelFor('gemini', 'balanced')).toBe('flash'); // resolved against `agy models` by the provider
    expect(modelFor('gemini', 'deep')).toBe('pro');
  });
  it("uses the model Aaron picked for each brain's slot", () => {
    const s = mergeSettings({ brainModels: { gemini: { fast: 'gemini-3.8-flash-low' } } as never });
    expect(modelFor('gemini', 'fast', s.brainModels)).toBe('gemini-3.8-flash-low');
    expect(modelFor('gemini', 'deep', s.brainModels)).toBe('pro'); // untouched slots keep their defaults
    expect(modelFor('claude', 'balanced', s.brainModels)).toBe('sonnet');
  });
  it("won't let a brain be its own backup", () => {
    expect(mergeSettings({ provider: 'gemini', fallbackProvider: 'gemini' }).fallbackProvider).toBeNull();
    expect(mergeSettings({ provider: 'gemini', fallbackProvider: 'claude' }).fallbackProvider).toBe('claude');
  });
  it('drops settings that no longer exist', () => {
    expect('compatibleDrawing' in mergeSettings({ compatibleDrawing: true } as never)).toBe(false);
  });
  it('carries the old fullscreen checkbox over to the new choice', () => {
    expect(mergeSettings({}).fullscreenHide).toBe('all');
    expect(mergeSettings({ hideOnFullscreen: false } as never).fullscreenHide).toBe('never');
    expect(mergeSettings({ hideOnFullscreen: true } as never).fullscreenHide).toBe('all');
    expect(mergeSettings({ hideOnFullscreen: false, fullscreenHide: 'games' } as never).fullscreenHide).toBe('games');
    expect('hideOnFullscreen' in mergeSettings({ hideOnFullscreen: true } as never)).toBe(false);
  });
  it('hides only for the fullscreen states the chosen mode covers', () => {
    expect(shouldHide('all', 2)).toBe(true); // a fullscreen app (some screen recorders report this)
    expect(shouldHide('games', 2)).toBe(false);
    expect(shouldHide('games', 3)).toBe(true);
    expect(shouldHide('never', 3)).toBe(false);
    expect(shouldHide('all', 5)).toBe(false);
  });
});

describe('approval policy', () => {
  it('confirms risky actions only', () => {
    expect(classify('open_app', { name: 'notepad' })).toBe('safe');
    expect(classify('set_reminder', { text: 'x', in_minutes: 5 })).toBe('safe');
    expect(classify('open_path_or_url', { target: 'https://example.com' })).toBe('safe');
    expect(classify('open_path_or_url', { target: 'C:\\Users\\Aaron\\Documents\\notes.txt' })).toBe('safe');
    expect(classify('open_path_or_url', { target: 'C:\\Users\\Aaron\\Downloads\\setup.exe' })).toBe('confirm');
    expect(classify('open_path_or_url', { target: 'ms-settings:privacy' })).toBe('confirm');
    expect(classify('run_command', { command: 'dir' })).toBe('confirm');
    expect(classify('write_file', { path: 'C:\\x.txt', content: '' })).toBe('confirm');
    expect(classify('delete_path', { path: 'C:\\x.txt' })).toBe('confirm');
  });
});

describe('Claude CLI provider', () => {
  it('parses stream-json into Ghost events without duplicating text', () => {
    const p = new ClaudeStreamParser();
    const events: ProviderEvent[] = lines('claude-stream.ndjson').flatMap(l => p.parse(l));
    expect(events[0]).toEqual({ type: 'session', sessionId: 'sess-123' });
    const text = events.filter(e => e.type === 'text_delta').map(e => (e as { text: string }).text).join('');
    expect(text).toBe('One moment, Aaron.\n\nIt is sunny today.');
    expect(events.filter(e => e.type === 'tool_start')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'sess-123' });
  });
  it('reports usage-limit errors', () => {
    const p = new ClaudeStreamParser();
    const [ev] = p.parse(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude usage limit reached. Resets at 5pm' }));
    expect(ev).toMatchObject({ type: 'error', kind: 'limit' });
  });
  it('builds a locked-down argv with no free text in it', () => {
    const args = claudeArgs({ model: 'haiku', personaFile: 'C:\\g\\persona.md', sessionId: 's1', mcpConfigPath: 'C:\\g\\mcp.json' });
    expect(args).toContain('--strict-mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch,Read,Glob,Grep');
    expect(args[args.indexOf('--resume') + 1]).toBe('s1');
    expect(args).not.toContain('Bash');
  });
  it('classifies CLI failures', () => {
    expect(classifyError("'claude' is not recognized as an internal or external command")).toBe('missing');
    expect(classifyError('Invalid API key · Please run /login')).toBe('auth');
  });
});

describe('Windows argument quoting', () => {
  it('quotes paths with spaces and escapes quotes', () => {
    expect(quoteWin('haiku')).toBe('haiku');
    expect(quoteWin('C:\\Users\\Aaron Tan\\AppData\\ghost-mcp.json')).toBe('"C:\\Users\\Aaron Tan\\AppData\\ghost-mcp.json"');
    expect(quoteWin('a"b')).toBe('"a\\"b"');
    expect(quoteWin('')).toBe('""');
  });
});

describe('memory', () => {
  it('remembers, recalls and forgets', () => {
    const file = join(tmp(), 'memory.json');
    const m = new MemoryStore(file);
    m.remember('Aaron prefers his coffee black');
    m.remember('Aaron plays Destiny 2 on Tuesday nights');
    m.remember('Aaron prefers his coffee black'); // duplicate
    expect(m.list()).toHaveLength(2);
    expect(m.recall('what coffee do I like')[0]).toMatch(/coffee/);
    const reloaded = new MemoryStore(file);
    expect(reloaded.contextFor('anything')).toHaveLength(2);
    expect(reloaded.forget('coffee')).toBe(1);
  });
  it('puts per-turn context in the user prompt', () => {
    const p = buildTurnPrompt('hello', { now: new Date('2026-09-27T09:00:00Z'), memories: ['likes tea'], userName: 'Aaron' });
    expect(p).toMatch(/<context>[\s\S]*likes tea[\s\S]*<\/context>\n\nhello$/);
  });
});

describe('reminders', () => {
  it('fires due reminders once and persists the rest', () => {
    let now = Date.parse('2026-09-27T10:00:00Z');
    const fired: string[] = [];
    const file = join(tmp(), 'r.json');
    const s = new ReminderScheduler(file, r => fired.push(r.text), () => now);
    s.add('stretch', { inMinutes: 10 });
    s.add('call mum', { at: '2026-09-27T12:00:00Z' });
    expect(() => s.add('late', { at: '2020-01-01T00:00:00Z' })).toThrow();
    now += 11 * 60_000;
    s.tick();
    s.tick();
    expect(fired).toEqual(['stretch']);
    expect(new ReminderScheduler(file, () => {}).list().map(r => r.text)).toEqual(['call mum']);
  });
});

describe('TTS fallback', () => {
  const edge: TtsEngine = { id: 'edge', synthesize: vi.fn(async () => ({ audio: Buffer.from('edge'), mime: 'audio/mpeg' })) };
  const choice = { engine: 'elevenlabs' as const, elevenLabsVoiceId: 'v', edgeVoice: 'e' };

  it('falls back to Edge when the ElevenLabs quota runs out, then backs off', async () => {
    let now = 0;
    const eleven: TtsEngine = { id: 'elevenlabs', synthesize: vi.fn(async () => { throw new TtsError('quota', 'quota'); }) };
    const svc = new TtsService(eleven, edge, () => now);
    const reasons: string[] = [];
    svc.onFallback = r => reasons.push(r);
    expect((await svc.speak('hi', choice)).engine).toBe('edge');
    expect((await svc.speak('hi', choice)).engine).toBe('edge');
    expect(eleven.synthesize).toHaveBeenCalledTimes(1); // backed off
    now += 7 * 3600_000;
    await svc.speak('hi', choice);
    expect(eleven.synthesize).toHaveBeenCalledTimes(2);
    expect(reasons).toHaveLength(2);
  });
  it('uses ElevenLabs when healthy', async () => {
    const eleven: TtsEngine = { id: 'elevenlabs', synthesize: async () => ({ audio: Buffer.from('11'), mime: 'audio/mpeg' }) };
    expect((await new TtsService(eleven, edge).speak('hi', choice)).engine).toBe('elevenlabs');
  });
});

describe('placement', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  it('places and snaps to corners', () => {
    const size = windowSize(180);
    const br = cornerPosition('bottom-right', work, size);
    expect(br.x + size.width).toBe(1920 - MARGIN);
    expect(nearestCorner(br.x - 30, br.y - 20, work, size)).toEqual({ corner: 'bottom-right', snap: true });
    expect(nearestCorner(800, 300, work, size).snap).toBe(false);
  });
  it('clamps settings', () => {
    expect(mergeSettings({ size: 5000, idleOpacity: 0 }).size).toBe(420);
    expect(mergeSettings({ idleOpacity: 0 }).idleOpacity).toBe(0.2);
  });
});

describe('overlay window sizing', () => {
  it('leaves room around the shell for unfolded shards and glow', () => {
    const { width, height } = windowSize(200);
    expect(width).toBeGreaterThanOrEqual(200 * 1.6);
    expect(height).toBeGreaterThanOrEqual(200 * 1.6 + 250); // plus bubble and input bar
  });
});

import { cornerWindowPosition, EDGE_MARGIN, orientationForShell, snapShell } from '../src/main/placement';

describe('snapping by the shell', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  const shell = { x: 240, y: 330, width: 180, height: 180 }; // shell rect inside the window
  const abs = (p: { x: number; y: number }) => ({ x: p.x + shell.x, y: p.y + shell.y });

  it('sticks the shell (not the window) to a nearby edge and keeps it fully on-screen', () => {
    // Dropped with the shell 30 px from the right edge, mid-height.
    const p = snapShell({ x: 1920 - 180 - 30 - shell.x, y: 400 - shell.y }, shell, work);
    expect(abs(p).x).toBe(1920 - 180 - EDGE_MARGIN);
    expect(abs(p).y).toBe(400);
    expect(p.corner).toBeNull();
  });
  it('snaps into a corner when near two edges', () => {
    const p = snapShell({ x: 1920 - 180 - 20 - shell.x, y: 1040 - 180 - 25 - shell.y }, shell, work);
    expect(p.corner).toBe('bottom-right');
    expect(p).toEqual({ ...cornerWindowPosition('bottom-right', shell, work), corner: 'bottom-right' });
  });
  it('never lets the shell be dragged off-screen ("shoots outward")', () => {
    const p = snapShell({ x: 2600, y: -500 }, shell, work);
    const s = abs(p);
    expect(s.x + shell.width).toBeLessThanOrEqual(1920 - EDGE_MARGIN);
    expect(s.y).toBeGreaterThanOrEqual(EDGE_MARGIN);
  });
  it('works on a second monitor to the left with its own work area', () => {
    const left = { x: -2560, y: 0, width: 2560, height: 1400 };
    const p = snapShell({ x: -2560 + 10 - shell.x, y: 10 - shell.y }, shell, left);
    expect(p.corner).toBe('top-left');
    expect(abs(p)).toEqual({ x: -2560 + EDGE_MARGIN, y: EDGE_MARGIN });
  });
  it('orients the chat stack towards the screen centre', () => {
    expect(orientationForShell({ x: 1700, y: 850, width: 180, height: 180 }, work)).toBe('bottom-right');
    expect(orientationForShell({ x: 20, y: 20, width: 180, height: 180 }, work)).toBe('top-left');
  });
});

import { elevenLabsBody } from '../src/core/tts/elevenlabs';
import { CHARACTERS, saturationCurve } from '../src/renderer/overlay/audio/ghostFilter';

describe('voice settings', () => {
  it('sends the chosen ElevenLabs model and delivery', () => {
    expect(elevenLabsBody('Hi.', { model: 'eleven_multilingual_v2', stability: 0.3, style: 0.6 })).toEqual({
      text: 'Hi.', model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.3, similarity_boost: 0.75, style: 0.6, use_speaker_boost: true },
    });
    // v3 only takes stability, in three steps.
    expect(elevenLabsBody('Hi.', { model: 'eleven_v3', stability: 0.3, style: 0.6 })).toEqual({ text: 'Hi.', model_id: 'eleven_v3', voice_settings: { stability: 0.5 } });
    expect(elevenLabsBody('Hi.').model_id).toBe('eleven_flash_v2_5');
  });

  it('trims a pasted voice ID and falls back to the default when empty', () => {
    expect(mergeSettings({ elevenLabsVoiceId: '  abc123 \n' }).elevenLabsVoiceId).toBe('abc123');
    expect(mergeSettings({ elevenLabsVoiceId: ' ' }).elevenLabsVoiceId).toBe('TX3LPaxmHKxFdv7VOQHJ');
  });

  it('makes each character progressively more synthetic', () => {
    const [n, c, d] = [CHARACTERS.natural, CHARACTERS.companion, CHARACTERS.drone];
    expect(n.rate).toBeLessThan(c.rate);
    expect(c.rate).toBeLessThan(d.rate);
    expect(d.rate).toBeLessThanOrEqual(1.08); // a small speaker, not a chipmunk
    expect(n.ring).toBeLessThan(d.ring);
    const curve = saturationCurve(0.5);
    expect(curve[0]).toBeCloseTo(-1);
    expect(curve[curve.length - 1]).toBeCloseTo(1);
    expect(saturationCurve(0)[256]).toBeCloseTo(256 / 1023 * 2 - 1);
  });
});

import { softClipCurve } from '../src/renderer/overlay/audio/ghostFilter';
describe('output soft clipper', () => {
  it('leaves normal levels alone and rounds off peaks below full scale', () => {
    const c = softClipCurve(2001); // index i ↔ input (i / 1000) - 1
    expect(c[1000 + 500]).toBeCloseTo(0.5); // -6 dBFS passes unchanged
    expect(c[2000]).toBeLessThan(0.98);
    expect(c[2000]).toBeGreaterThan(0.85);
    expect(c[0]).toBeCloseTo(-c[2000]);
  });
});
