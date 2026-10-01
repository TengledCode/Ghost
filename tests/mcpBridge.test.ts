import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { GhostCore } from '../src/core/ghostCore';
import { MockProvider } from '../src/core/providers/mock';
import { TtsService } from '../src/core/tts/service';
import type { TtsEngine } from '../src/core/tts/types';
import { mergeSettings } from '../src/shared/settings';

// Exercises the compiled MCP bridge exactly as the Claude/Gemini CLI would: stdio JSON-RPC in,
// relayed over the WebSocket to the core. Needs `npm run build` first.
const bridge = join(__dirname, '../out/main/mcpServer.js');
const tts: TtsEngine = { id: 'edge', synthesize: async () => ({ audio: Buffer.alloc(0), mime: 'audio/mpeg' }) };

describe.skipIf(!existsSync(bridge))('MCP bridge (built)', () => {
  it('lists Ghost tools and relays calls to the core', async () => {
    const shots = mkdtempSync(join(tmpdir(), 'ghost-shots-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'ghost-private-'));
    const core = new GhostCore({
      readableDirs: [shots], approvalTimeoutMs: 300,
      dataDir: mkdtempSync(join(tmpdir(), 'ghost-mcp-')), personaPath: join(__dirname, '../config/persona.md'),
      mcpServerPath: bridge, nodeExecPath: process.execPath, providers: { mock: new MockProvider() },
      tts: new TtsService(tts, tts), host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {} },
      settings: () => mergeSettings({ provider: 'mock', fallbackProvider: null }), port: 0,
    });
    await core.start();
    const child = spawn(process.execPath, [bridge], { env: { ...process.env, GHOST_CORE_URL: core.url, GHOST_TOKEN: core.token }, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = new Map<number, (v: any) => void>();
    createInterface({ input: child.stdout }).on('line', l => { const m = JSON.parse(l); replies.get(m.id)?.(m); });
    let n = 0;
    const rpc = (method: string, params: object) => new Promise<any>(resolve => {
      const id = ++n;
      replies.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      expect(init.result.serverInfo.name).toBe('ghost');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const list = await rpc('tools/list', {});
      const names = list.result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual(expect.arrayContaining(['open_app', 'run_command', 'set_reminder', 'remember']));
      const call = await rpc('tools/call', { name: 'set_reminder', arguments: { text: 'stand up', in_minutes: 30 } });
      expect(call.result.isError).toBe(false);
      expect(call.result.content[0].text).toMatch(/^Reminder \w+ set for/);
      expect(core.reminders.list()[0].text).toBe('stand up');
      // A picture in a safe folder reaches the model as an image it can see.
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      mkdirSync(join(shots, 'screens'), { recursive: true });
      writeFileSync(join(shots, 'screens', 's.png'), png);
      const img = await rpc('tools/call', { name: 'read_file', arguments: { path: join(shots, 'screens', 's.png') } });
      expect(img.result.isError).toBe(false);
      expect(img.result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: png.toString('base64') });
      // Anywhere else needs Aaron's OK; nobody answers here, so it's declined.
      writeFileSync(join(elsewhere, 'secret.txt'), 'hunter2');
      const secret = await rpc('tools/call', { name: 'read_file', arguments: { path: join(elsewhere, 'secret.txt') } });
      expect(secret.result.isError).toBe(true);
      expect(JSON.stringify(secret.result)).not.toContain('hunter2');
    } finally {
      child.kill();
      core.stop();
    }
  }, 20_000);
});
