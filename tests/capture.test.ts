import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { duration, parseCaptureCommand } from '../src/core/captureCommands';
import { GhostCore } from '../src/core/ghostCore';
import { MockProvider } from '../src/core/providers/mock';
import type { CaptureHost, RecordingState } from '../src/core/tools/executor';
import { TtsService } from '../src/core/tts/service';
import type { TtsEngine } from '../src/core/tts/types';
import type { CoreMessage } from '../src/shared/protocol';
import { mergeSettings } from '../src/shared/settings';

describe('capture commands', () => {
  it('recognises screenshot, record and stop said plainly', () => {
    for (const t of ['take a screenshot', 'Take a screenshot please', 'screenshot', 'ghost, grab a screenshot of my screen', 'can you take a screen shot?', 'screenshot my screen'])
      expect(parseCaptureCommand(t), t).toBe('screenshot');
    for (const t of ['record my screen', 'start recording', 'Start recording my screen please', 'screen record', 'begin a screen recording', 'record the screen'])
      expect(parseCaptureCommand(t), t).toBe('record');
    for (const t of ['stop recording', 'Stop the recording.', 'ok, stop recording now', 'end screen recording', 'save the recording'])
      expect(parseCaptureCommand(t), t).toBe('stop');
  });
  it('leaves real questions to the brain', () => {
    for (const t of ['how do I take a screenshot on Windows?', 'record a reminder to call mum', 'what is screen recording', 'stop', 'take a screenshot and send it to Sam'])
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
  };
  return { host, calls, onChange: (f: (s: RecordingState) => void) => { notify = f; } };
}

async function setup() {
  const cap = fakeCapture();
  core = new GhostCore({
    dataDir: mkdtempSync(join(tmpdir(), 'ghost-cap-')), personaPath: join(__dirname, '../config/persona.md'),
    mcpServerPath: '/out/main/mcpServer.js', nodeExecPath: process.execPath, providers: { claude: new MockProvider() as never },
    tts: new TtsService(fakeTts, fakeTts),
    host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {}, capture: cap.host },
    settings: () => mergeSettings({ provider: 'claude', fallbackProvider: null, voiceEnabled: false }), port: 0,
  });
  const c = core;
  cap.onChange(s => c.recordingChanged(s));
  await core.start();
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
    expect((line as { text: string }).text).toMatch(/^Screenshot saved and copied to the clipboard\.\nC:\\Users\\Aaron\\Pictures\\Ghost/);
    expect(core.log.lines()).toHaveLength(0); // a command, not a conversation
  });

  it('records, switches the mic from the REC tag, and stops with the length', async () => {
    const { core, cap, ws, inbox, until } = await setup();
    await core.userMessage('record my screen');
    await until(m => m.type === 'recording' && m.on);
    ws.send(JSON.stringify({ type: 'recording_mic', on: true }));
    await until(m => m.type === 'notice' && /No microphone found, so the recording carries on/.test(m.text));
    ws.send(JSON.stringify({ type: 'recording_stop' }));
    await until(m => m.type === 'recording' && !m.on);
    const saved = await until(m => m.type === 'turn_end' && /Recording saved/.test((m as { text: string }).text));
    expect((saved as { text: string }).text).toMatch(/^Recording saved \(1 min \d+ s\)\.\nC:\\.*Ghost recording\.mp4$/);
    expect(cap.calls).toEqual(['start', 'mic:true', 'stop']);
    expect(inbox.filter(m => m.type === 'recording').length).toBeGreaterThanOrEqual(3);
  });

  it("says so instead of failing when there's nothing to stop", async () => {
    const { core, until } = await setup();
    await core.userMessage('stop recording');
    expect(((await until(m => m.type === 'turn_end')) as { text: string }).text).toBe("I'm not recording.");
  });
});
