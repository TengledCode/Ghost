// Headless Ghost core for UI work in a plain browser (no Electron, no subscription).
// Started by preview-server.mjs, which prints the URL to open.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhostCore } from '../src/core/ghostCore';
import { MockProvider } from '../src/core/providers/mock';
import { EdgeTts } from '../src/core/tts/edge';
import { TtsService } from '../src/core/tts/service';
import { TtsError, type TtsEngine } from '../src/core/tts/types';
import { mergeSettings } from '../src/shared/settings';

// A short silent MP3 frame stands in for speech when GHOST_PREVIEW_TTS=silent (e.g. offline CI).
const SILENT_MP3 = Buffer.from('//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP////////////////////////////////////////////////8AAAA5TEFNRTMuOTlyAc0AAAAAAAAAABSAJAJAQgAAgAAAAnEMRIn1AAAAAAAAAAAAAAAAAAAAAP/7kMQAAANIAAAAAExBTUUzLjk5LjVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV', 'base64');
const silent: TtsEngine = { id: 'edge', synthesize: async () => ({ audio: SILENT_MP3, mime: 'audio/mpeg' }) };

/** Offline stand-in voice: a buzzy vowel tone shaped into syllables, as WAV. Enough to drive the mouth. */
function synthSpeech(text: string): Buffer {
  const rate = 22050, syllables = Math.max(2, Math.round(text.length / 3.2)), per = 0.16;
  const n = Math.round(rate * (syllables * per + 0.2));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate, s = Math.floor(t / per), x = (t % per) / per;
    const stress = s % 4 === 0 ? 1 : 0.6, gap = s % 5 === 4 ? 0.1 : 1;
    const env = s < syllables ? Math.sin(Math.PI * x) ** 0.8 * stress * gap : 0;
    const f0 = 115 + 15 * Math.sin(t * 3);
    const buzz = ((t * f0) % 1) * 2 - 1;
    const vowel = Math.sin(2 * Math.PI * 700 * t) * 0.5 + Math.sin(2 * Math.PI * 1200 * t) * 0.3;
    pcm[i] = Math.round(env * (buzz * 0.35 + vowel * buzz * 0.4) * 12000);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n * 2, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(n * 2, 40);
  return Buffer.concat([h, Buffer.from(pcm.buffer)]);
}
const synth: TtsEngine = { id: 'edge', synthesize: async text => ({ audio: synthSpeech(text), mime: 'audio/wav' }) };
// A voice that always fails, as Edge does when Microsoft drops the stream (to check notices and the reply's timing).
const failing: TtsEngine = { id: 'edge', synthesize: async () => { await new Promise(r => setTimeout(r, 800)); throw new TtsError('Edge TTS failed: Stream closed (pretend)', 'network'); } };
// Works for some sentences and not others (what Edge does on a bad day).
// Every second new sentence fails, retries included.
const flakySeen = new Map<string, number>();
const flaky: TtsEngine = {
  id: 'edge',
  synthesize: async (text, voice, signal) => {
    if (!flakySeen.has(text)) flakySeen.set(text, flakySeen.size);
    return (flakySeen.get(text)! % 2 === 1 ? failing : synth).synthesize(text, voice, signal);
  },
};
// A voice that takes 12 s to come (Edge retrying): the no-voice safety net (8 s) starts revealing the
// words silently, and the voice arrives mid-reply, so its catching up can be watched.
const slow: TtsEngine = { id: 'edge', synthesize: async (text, voice, signal) => { await new Promise(r => setTimeout(r, 12_000)); return synth.synthesize(text, voice, signal); } };
const mode = process.env.GHOST_PREVIEW_TTS;
const edge = mode === 'silent' ? silent : mode === 'synth' ? synth : mode === 'fail' ? failing : mode === 'flaky' ? flaky : mode === 'slow' ? slow : new EdgeTts();

const core = new GhostCore({
  dataDir: mkdtempSync(join(tmpdir(), 'ghost-preview-')),
  personaPath: join(process.cwd(), 'config/persona.md'),
  mcpServerPath: join(process.cwd(), 'out/main/mcpServer.js'),
  nodeExecPath: process.execPath,
  providers: { mock: new MockProvider() },
  tts: new TtsService(silent, edge),
  host: {
    openExternal: async () => {}, openPath: async () => '', trash: async () => {},
    // Pretend captures, so the bubble's screenshot / recording card can be tried (no real files).
    capture: (() => {
      let rec: { on: boolean; startedAt?: number; mic: boolean } = { on: false, mic: false };
      return {
        screenshot: async () => ({ path: 'C:\\Users\\Aaron\\Pictures\\Ghost\\Screenshot 2026-11-03 21-42-09.png' }),
        startRecording: async () => { rec = { on: true, startedAt: Date.now(), mic: false }; core.recordingChanged(rec); },
        stopRecording: async () => { rec = { on: false, mic: false }; core.recordingChanged(rec); return 'C:\\Users\\Aaron\\Videos\\Ghost\\Ghost recording 2026-11-03 22-00-46.mp4'; },
        setRecordingMic: () => {},
        recording: () => rec,
        latest: async (kind: 'screenshot' | 'recording') => ({ path: kind === 'screenshot' ? 'C:\\Users\\Aaron\\Pictures\\Ghost\\Screenshot 2026-11-03 21-42-09.png' : 'C:\\Users\\Aaron\\Videos\\Ghost\\Ghost recording 2026-11-03 22-00-46.mp4', at: Date.now() - 3_600_000 }),
      };
    })(),
  },
  settings: () => mergeSettings({ provider: 'mock', fallbackProvider: null, ttsEngine: 'edge' }),
  port: Number(process.env.GHOST_PREVIEW_PORT ?? 0),
  greetOnStart: true,
});
await core.start();
console.log(JSON.stringify({ url: core.url, token: core.token }));
