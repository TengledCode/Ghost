import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { duration, folderName, parseCaptureCommand, when } from '../src/core/captureCommands';
import { GhostCore } from '../src/core/ghostCore';
import { MockProvider } from '../src/core/providers/mock';
import type { CaptureHost, RecordingState } from '../src/core/tools/executor';
import type { Provider, ProviderEvent } from '../src/core/providers/types';
import { TtsService } from '../src/core/tts/service';
import type { TtsEngine } from '../src/core/tts/types';
import type { CoreMessage } from '../src/shared/protocol';
import { mergeSettings } from '../src/shared/settings';
import { isCaptureFile, latestCapture, SCREENSHOT_TYPES } from '../src/main/captureFiles';

describe('capture commands', () => {
  it('recognises screenshot, record and stop said plainly', () => {
    for (const t of ['take a screenshot', 'Take a screenshot please', 'screenshot', 'ghost, grab a screenshot of my screen', 'can you take a screen shot?', 'screenshot my screen'])
      expect(parseCaptureCommand(t), t).toBe('screenshot');
    for (const t of ['record my screen', 'start recording', 'Start recording my screen please', 'screen record', 'begin a screen recording', 'record the screen',
      'please record my current screen', 'record my whole screen', 'start a recording of my screen'])
      expect(parseCaptureCommand(t), t).toBe('record');
    for (const t of ['stop recording', 'Stop the recording.', 'ok, stop recording now', 'end screen recording', 'save the recording'])
      expect(parseCaptureCommand(t), t).toBe('stop');
  });
  it('recognises asking for the last screenshot or recording', () => {
    for (const t of ['show me my last screenshot', 'previous screenshot', "where's my latest screenshot?", 'open the last screenshot please', 'show my previous screenshot again',
      'whats my last screenshot?', "what's the previous screenshot", 'show me the screenshot I just took', 'the last screenshot you took'])
      expect(parseCaptureCommand(t), t).toBe('last-screenshot');
    for (const t of ['show my last recording', 'previous screen recording', 'where did you save my last recording?', 'whats my latest recording'])
      expect(parseCaptureCommand(t), t).toBe('last-recording');
  });
  it('names the folder and the time the way Aaron reads them', () => {
    expect(folderName('C:\\Users\\Aaron\\Pictures\\Ghost\\Screenshot 1.png')).toBe('Pictures\\Ghost');
    expect(when(new Date(2026, 10, 3, 21, 42).getTime())).toBe('3 Nov, 9:42 pm');
    expect(when(new Date(2026, 10, 3, 0, 5).getTime())).toBe('3 Nov, 12:05 am');
  });
  it('leaves real questions to the brain', () => {
    for (const t of ['how do I take a screenshot on Windows?', 'record a reminder to call mum', 'what is screen recording', 'stop', 'take a screenshot and send it to Sam', 'what was in my last screenshot?', 'delete my last screenshot', 'record my current screen and the webcam'])
      expect(parseCaptureCommand(t), t).toBeNull();
  });
  it('says how long a recording ran', () => {
    expect(duration(48_200)).toBe('48 s');
    expect(duration(134_000)).toBe('2 min 14 s');
  });
});

const fakeTts: TtsEngine = { id: 'edge', synthesize: async t => ({ audio: Buffer.from(`mp3:${t}`), mime: 'audio/mpeg' }) };
let core: GhostCore | null = null;
afterEach(() => core?.stop());

function fakeCapture() {
  const calls: string[] = [];
  let state: RecordingState = { on: false, mic: false };
  let notify: (s: RecordingState) => void = () => {};
  const host: CaptureHost = {
    screenshot: async () => { calls.push('screenshot'); return { path: 'C:\\Users\\Aaron\\Pictures\\Ghost\\Screenshot 1.png' }; },
    startRecording: async () => { calls.push('start'); state = { on: true, startedAt: Date.now() - 65_000, mic: false }; notify(state); },
    stopRecording: async () => { calls.push('stop'); state = { on: false, mic: false }; notify(state); return 'C:\\Users\\Aaron\\Videos\\Ghost\\Ghost recording.mp4'; },
    setRecordingMic: on => { calls.push(`mic:${on}`); state = { ...state, mic: false, micError: on ? 'No microphone found' : undefined }; notify(state); },
    recording: () => state,
    latest: async kind => { calls.push(`latest:${kind}`); return kind === 'screenshot' ? { path: 'C:\\Users\\Aaron\\Pictures\\Ghost\\Screenshot 0.png', at: new Date(2026, 10, 3, 21, 42).getTime() } : null; },
  };
  return { host, calls, onChange: (f: (s: RecordingState) => void) => { notify = f; } };
}

/** A brain that, like Gemini on "please record my current screen", uses one of Ghost's tools through the relay, then answers. */
class ToolBrain implements Provider {
  readonly id = 'claude' as const;
  relay: { url: string; token: string } | null = null;
  constructor(private readonly tool: string, private readonly args: Record<string, unknown> = {}) {}
  async isAvailable(): Promise<boolean> { return true; }
  async *send(): AsyncIterable<ProviderEvent> {
    yield { type: 'tool_start', name: `mcp__ghost__${this.tool}` };
    const ws = new WebSocket(this.relay!.url);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', token: this.relay!.token, role: 'mcp' }));
    const result = new Promise(r => ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.type === 'tool_result') r(m); }));
    ws.send(JSON.stringify({ type: 'tool_call', id: 'b1', tool: this.tool, args: this.args }));
    await result;
    ws.close();
    yield { type: 'tool_end', name: `mcp__ghost__${this.tool}` };
    const text = 'Done. Let me know when you want me to stop.';
    yield { type: 'text_delta', text };
    yield { type: 'done', text };
  }
}

async function setup(voiceEnabled = false, brain?: ToolBrain) {
  const cap = fakeCapture();
  core = new GhostCore({
    dataDir: mkdtempSync(join(tmpdir(), 'ghost-cap-')), personaPath: join(__dirname, '../config/persona.md'),
    mcpServerPath: '/out/main/mcpServer.js', nodeExecPath: process.execPath, providers: { claude: (brain ?? new MockProvider()) as never },
    tts: new TtsService(fakeTts, fakeTts),
    host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {}, capture: cap.host },
    settings: () => mergeSettings({ provider: 'claude', fallbackProvider: null, voiceEnabled }), port: 0,
  });
  const c = core;
  cap.onChange(s => c.recordingChanged(s));
  await core.start();
  if (brain) brain.relay = { url: core.url, token: core.mcpToken };
  const ws = new WebSocket(core.url);
  const inbox: CoreMessage[] = [];
  ws.on('message', raw => inbox.push(JSON.parse(String(raw))));
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', token: core.token, role: 'ui' }));
  const until = async (pred: (m: CoreMessage) => boolean) => {
    for (let i = 0; i < 100; i++) { const hit = inbox.find(pred); if (hit) return hit; await new Promise(r => setTimeout(r, 30)); }
    throw new Error('timeout');
  };
  await until(m => m.type === 'welcome'); // joined as a Ghost window
  return { core, cap, ws, inbox, until };
}

describe('screenshots and recording in the core', () => {
  it('takes a screenshot at once, without asking the brain', async () => {
    const { core, cap, until } = await setup();
    await core.userMessage('take a screenshot');
    const line = await until(m => m.type === 'turn_end' && m.provider === 'ghost');
    expect(cap.calls).toEqual(['screenshot']);
    expect(line).toMatchObject({
      text: 'Screenshot saved in Pictures\\Ghost and copied to the clipboard.',
      file: { path: 'C:\\Users\\Aaron\\Pictures\\Ghost\\Screenshot 1.png', kind: 'screenshot' }, // shown with Open / Show in folder
    });
    expect(core.log.lines()).toHaveLength(0); // a command, not a conversation
  });

  it('brings back the previous screenshot, and says when there is no recording yet', async () => {
    const { core, until, inbox } = await setup();
    await core.userMessage('show me my last screenshot');
    expect(await until(m => m.type === 'turn_end')).toMatchObject({
      text: 'Previous screenshot saved in Pictures\\Ghost (3 Nov, 9:42 pm).',
      file: { path: 'C:\\Users\\Aaron\\Pictures\\Ghost\\Screenshot 0.png', kind: 'screenshot' },
    });
    inbox.length = 0;
    await core.userMessage('previous recording');
    const none = await until(m => m.type === 'turn_end');
    expect(none).toMatchObject({ text: "I haven't made any recordings yet." });
    expect((none as { file?: unknown }).file).toBeUndefined();
  });

  it('records, switches the mic from the REC tag, and stops with the length', async () => {
    const { core, cap, ws, inbox, until } = await setup(true);
    await core.userMessage('record my screen');
    await until(m => m.type === 'recording' && m.on);
    // Said in the bubble only: spoken, it would end up in the recording.
    const started = await until(m => m.type === 'turn_end' && (m as { text: string }).text === 'Recording your screen.');
    await new Promise(r => setTimeout(r, 100));
    expect(inbox.some(m => m.type === 'audio' && m.turnId === (started as { turnId: string }).turnId)).toBe(false);
    expect((started as { silent?: boolean }).silent).toBe(true); // so the bubble shows it at once, not after waiting for a voice
    ws.send(JSON.stringify({ type: 'recording_mic', on: true }));
    await until(m => m.type === 'notice' && /No microphone found, so the recording carries on/.test(m.text));
    ws.send(JSON.stringify({ type: 'recording_stop' }));
    await until(m => m.type === 'recording' && !m.on);
    const saved = await until(m => m.type === 'turn_end' && /Recording saved/.test((m as { text: string }).text));
    expect((saved as { text: string }).text).toMatch(/^Recording saved in Videos\\Ghost \(1 min \d+ s\)\.$/);
    expect(saved).toMatchObject({ file: { path: 'C:\\Users\\Aaron\\Videos\\Ghost\\Ghost recording.mp4', kind: 'recording' } });
    await until(m => m.type === 'audio' && m.turnId === (saved as { turnId: string }).turnId); // spoken once it's stopped
    expect(cap.calls).toEqual(['start', 'mic:true', 'stop']);
    expect(inbox.filter(m => m.type === 'recording').length).toBeGreaterThanOrEqual(3);
  });

  it("keeps a brain's reply quiet once it has started a recording (it would be in the video)", async () => {
    const { core, inbox, until } = await setup(true, new ToolBrain('start_recording'));
    await core.userMessage('could you capture what I am doing on screen');
    const end = await until(m => m.type === 'turn_end' && m.provider === 'claude');
    expect(end).toMatchObject({ silent: true, text: 'Done. Let me know when you want me to stop.' });
    await new Promise(r => setTimeout(r, 150));
    expect(inbox.some(m => m.type === 'audio' && m.turnId === (end as { turnId: string }).turnId && m.data)).toBe(false);
  });

  it("shows a brain's screenshot, and the last one it looked up, with the card", async () => {
    const { core, until } = await setup(false, new ToolBrain('take_screenshot'));
    await core.userMessage('grab the screen for me and keep it');
    expect(await until(m => m.type === 'turn_end' && m.provider === 'claude')).toMatchObject({ file: { path: 'C:\\Users\\Aaron\\Pictures\\Ghost\\Screenshot 1.png', kind: 'screenshot' } });
    core.stop();
    const again = await setup(false, new ToolBrain('show_last_capture', { kind: 'screenshot' }));
    await again.core.userMessage('the screenshot from earlier, where is it');
    const end = await again.until(m => m.type === 'turn_end' && m.provider === 'claude');
    expect(end).toMatchObject({ file: { path: 'C:\\Users\\Aaron\\Pictures\\Ghost\\Screenshot 0.png', kind: 'screenshot' } });
    expect((end as { silent?: boolean }).silent).toBeUndefined();
  });

  it("says so instead of failing when there's nothing to stop", async () => {
    const { core, until } = await setup();
    await core.userMessage('stop recording');
    expect(((await until(m => m.type === 'turn_end')) as { text: string }).text).toBe("I'm not recording.");
  });
});

describe('the files the bubble may open', () => {
  const root = mkdtempSync(join(tmpdir(), 'ghost-files-'));
  const pics = join(root, 'Pictures', 'Ghost');
  const vids = join(root, 'Videos', 'Ghost');
  mkdirSync(pics, { recursive: true });
  mkdirSync(vids, { recursive: true });
  const put = (path: string, at: number) => { writeFileSync(path, 'x'); utimesSync(path, at / 1000, at / 1000); return path; };

  it("opens only Ghost's own screenshots and recordings", () => {
    const shot = put(join(pics, 'Screenshot 1.png'), Date.now());
    const video = put(join(vids, 'Ghost recording 1.mp4'), Date.now());
    const script = put(join(pics, 'run.cmd'), Date.now());
    const outside = put(join(root, 'elsewhere.png'), Date.now());
    const dirs = [pics, vids];
    expect(isCaptureFile(shot, dirs)).toBe(true);
    expect(isCaptureFile(video, dirs)).toBe(true);
    for (const bad of [script, outside, pics, join(pics, '..', '..', 'elsewhere.png'), join(pics, 'missing.png'), '', 42, null]) expect(isCaptureFile(bad, dirs), String(bad)).toBe(false);
  });

  it("finds the newest one of a kind, Ghost's or Windows'", () => {
    const windows = join(root, 'Pictures', 'Screenshots');
    mkdirSync(windows, { recursive: true });
    put(join(pics, 'Screenshot old.png'), Date.now() - 60_000);
    const ghosts = put(join(pics, 'Screenshot new.png'), Date.now() + 60_000);
    put(join(pics, 'notes.txt'), Date.now() + 120_000);
    expect(latestCapture(pics, SCREENSHOT_TYPES)?.path).toBe(ghosts);
    const snipped = put(join(windows, 'Screenshot 2026-11-03 231619.png'), Date.now() + 90_000);
    expect(latestCapture([pics, windows], SCREENSHOT_TYPES)?.path).toBe(snipped);
    expect(latestCapture([join(root, 'nowhere'), pics], SCREENSHOT_TYPES)?.path).toBe(ghosts);
    expect(latestCapture(join(root, 'nowhere'), SCREENSHOT_TYPES)).toBeNull();
  });
});
