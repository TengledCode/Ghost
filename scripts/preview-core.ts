// Headless Ghost core for UI work in a plain browser (no Electron, no subscription).
// Started by preview-server.mjs, which prints the URL to open.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhostCore } from '../src/core/ghostCore';
import { MockProvider } from '../src/core/providers/mock';
import { EdgeTts } from '../src/core/tts/edge';
import { TtsService } from '../src/core/tts/service';
import type { TtsEngine } from '../src/core/tts/types';
import { mergeSettings } from '../src/shared/settings';

// A short silent MP3 frame stands in for speech when GHOST_PREVIEW_TTS=silent (e.g. offline CI).
const SILENT_MP3 = Buffer.from('//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgP////////////////////////////////////////////////8AAAA5TEFNRTMuOTlyAc0AAAAAAAAAABSAJAJAQgAAgAAAAnEMRIn1AAAAAAAAAAAAAAAAAAAAAP/7kMQAAANIAAAAAExBTUUzLjk5LjVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV', 'base64');
const silent: TtsEngine = { id: 'edge', synthesize: async () => ({ audio: SILENT_MP3, mime: 'audio/mpeg' }) };
const edge = process.env.GHOST_PREVIEW_TTS === 'silent' ? silent : new EdgeTts();

const core = new GhostCore({
  dataDir: mkdtempSync(join(tmpdir(), 'ghost-preview-')),
  personaPath: join(process.cwd(), 'config/persona.md'),
  mcpServerPath: join(process.cwd(), 'out/main/mcpServer.js'),
  nodeExecPath: process.execPath,
  providers: { mock: new MockProvider() },
  tts: new TtsService(silent, edge),
  host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {} },
  settings: () => mergeSettings({ provider: 'mock', fallbackProvider: null, ttsEngine: 'edge' }),
  port: Number(process.env.GHOST_PREVIEW_PORT ?? 0),
});
await core.start();
console.log(JSON.stringify({ url: core.url, token: core.token }));
