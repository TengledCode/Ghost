import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GhostCore } from '../src/core/ghostCore';
import { ClaudeCliProvider } from '../src/core/providers/claude';
import { TtsService } from '../src/core/tts/service';
import type { TtsEngine } from '../src/core/tts/types';
import type { CoreMessage } from '../src/shared/protocol';
import { mergeSettings } from '../src/shared/settings';
import WebSocket from 'ws';

// Live check against the real, logged-in Claude Code CLI (spends a little subscription usage).
// Run with: GHOST_LIVE=1 npx vitest run tests/claude.live.test.ts   (after `npm run build`)
const bridge = join(__dirname, '../out/main/mcpServer.js');
const tts: TtsEngine = { id: 'edge', synthesize: async () => ({ audio: Buffer.from('x'), mime: 'audio/mpeg' }) };

describe.skipIf(!process.env.GHOST_LIVE || !existsSync(bridge))('Claude CLI (live)', () => {
  it('answers in persona and calls a Ghost tool through MCP', async () => {
    const core = new GhostCore({
      dataDir: mkdtempSync(join(tmpdir(), 'ghost-live-')), personaPath: join(__dirname, '../config/persona.md'),
      mcpServerPath: bridge, nodeExecPath: process.execPath, providers: { claude: new ClaudeCliProvider() },
      tts: new TtsService(tts, tts), host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {} },
      settings: () => mergeSettings({ provider: 'claude', fallbackProvider: null, modelTier: 'fast' }), port: 0,
    });
    await core.start();
    const ws = new WebSocket(core.url);
    const inbox: CoreMessage[] = [];
    ws.on('message', r => inbox.push(JSON.parse(String(r))));
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', token: core.token, role: 'ui' }));
    ws.send(JSON.stringify({ type: 'user_message', text: 'Remind me to drink water in 5 minutes.' }));
    const end = await new Promise<Extract<CoreMessage, { type: 'turn_end' }>>((resolve, reject) => {
      const t = setInterval(() => { const m = inbox.find(x => x.type === 'turn_end'); if (m) { clearInterval(t); resolve(m as never); } }, 200);
      setTimeout(() => { clearInterval(t); reject(new Error('no reply')); }, 150_000);
    });
    console.log('Reply:', end.text, '| model:', end.model);
    console.log('States:', inbox.filter(m => m.type === 'state').map(m => (m as { state: string }).state).join(' → '));
    expect(end.provider).toBe('claude');
    expect(core.reminders.list().map(r => r.text.toLowerCase()).join()).toMatch(/water/);
    ws.close();
    core.stop();
  }, 180_000);

  it('reads the live screen snapshot with its Read tool', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ghost-live-screen-'));
    const shot = join(dataDir, 'workspace', 'screens', 'screen-test.png');
    const core = new GhostCore({
      dataDir, personaPath: join(__dirname, '../config/persona.md'),
      mcpServerPath: bridge, nodeExecPath: process.execPath, providers: { claude: new ClaudeCliProvider() },
      tts: new TtsService(tts, tts), host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {} },
      settings: () => mergeSettings({ provider: 'claude', fallbackProvider: null, voiceEnabled: false }), port: 0,
      // Stands in for the Electron capture: the fixture is a dialog with a known reference code.
      captureScreen: async () => {
        mkdirSync(dirname(shot), { recursive: true });
        copyFileSync(join(__dirname, 'fixtures', 'screen-error.png'), shot);
        return { path: shot, width: 800, height: 450, takenAt: new Date().toISOString() };
      },
    });
    await core.start();
    const ended = new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(core.url);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: core.token, role: 'ui' }));
        ws.send(JSON.stringify({ type: 'user_message', text: "What's the reference code in the error on my screen?" }));
      });
      ws.on('message', r => { const m = JSON.parse(String(r)) as CoreMessage; if (m.type === 'turn_end') { ws.close(); resolve(m.text); } });
      setTimeout(() => reject(new Error('no reply')), 150_000);
    });
    const text = await ended;
    console.log('Reply:', text);
    expect(text).toMatch(/GHOST-?4217/i);
    core.stop();
  }, 180_000);
});
