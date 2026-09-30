import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { GhostCore } from '../src/core/ghostCore';
import type { ProviderEvent, SendRequest } from '../src/core/providers/types';
import { TtsService } from '../src/core/tts/service';
import type { TtsEngine } from '../src/core/tts/types';
import type { CoreMessage } from '../src/shared/protocol';
import { mergeSettings } from '../src/shared/settings';

const tts: TtsEngine = { id: 'edge', synthesize: async t => ({ audio: Buffer.from(`mp3:${t}`), mime: 'audio/mpeg' }) };
let core: GhostCore | null = null;
afterEach(() => core?.stop());

// A brain that answers questions (with a screen note), and files conversations when asked.
const brain = {
  id: 'claude' as const,
  isAvailable: async () => true,
  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    if (req.oneShot) {
      yield { type: 'done', text: JSON.stringify({ title: 'Trip with Sam', summary: 'Aaron asked about a trip with Sam.', keyPoints: [], decisions: [], tags: ['travel'], people: ['Sam'] }) };
      return;
    }
    const reply = 'You could go to Kyoto with Sam in spring. <screen>a map of Japan</screen>';
    for (const part of reply.match(/.{1,7}/gs)!) yield { type: 'text_delta', text: part };
    yield { type: 'done', text: reply, sessionId: 's1' };
  },
};

async function setup() {
  const vault = mkdtempSync(join(tmpdir(), 'core-vault-'));
  mkdirSync(join(vault, 'People'), { recursive: true });
  writeFileSync(join(vault, 'People', 'Sam.md'), '# Sam\n');
  const dataDir = mkdtempSync(join(tmpdir(), 'core-data-'));
  core = new GhostCore({
    dataDir, personaPath: join(__dirname, '../config/persona.md'), mcpServerPath: '/x.js', nodeExecPath: process.execPath,
    providers: { claude: brain as never }, tts: new TtsService(tts, tts), host: { openExternal: async () => {}, openPath: async () => '', trash: async () => {} },
    settings: () => mergeSettings({ provider: 'claude', fallbackProvider: null, obsidian: { vaultPath: vault } as never }), port: 0,
  });
  await core.start();
  const ws = new WebSocket(core.url);
  const inbox: CoreMessage[] = [];
  ws.on('message', raw => inbox.push(JSON.parse(String(raw))));
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', token: core.token, role: 'ui' }));
  await until(() => inbox.some(m => m.type === 'welcome'));
  return { vault, dataDir, ws, inbox };
}

const until = async (check: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 25)); }
};

describe('Ghost with an Obsidian vault', () => {
  it('writes the conversation as a note, files it with links and tags, and keeps the screen note out of the reply', async () => {
    const { vault, inbox, ws } = await setup();
    await core!.userMessage('Where should I travel with Sam?');
    await until(() => inbox.some(m => m.type === 'audio' && m.last));
    const shown = inbox.filter(m => m.type === 'text_delta').map(m => (m as { text: string }).text).join('');
    expect(shown).toBe('You could go to Kyoto with Sam in spring. ');
    const spoken = inbox.filter((m): m is Extract<CoreMessage, { type: 'audio' }> => m.type === 'audio' && !!m.data).map(a => Buffer.from(a.data, 'base64').toString()).join(' ');
    expect(spoken).not.toContain('map of Japan');

    const convDir = join(vault, 'Ghost', 'Conversations');
    const liveFiles = () => (existsSync(convDir) ? readdirSync(convDir, { recursive: true }).map(String).filter(f => f.endsWith('.md')) : []);
    expect(liveFiles()).toHaveLength(1); // written live

    core!.newConversation();
    await until(() => liveFiles().some(f => f.endsWith('Trip with Sam.md')));
    const note = readFileSync(join(convDir, liveFiles()[0]), 'utf8');
    expect(note).toContain('people:\n  - "[[Sam]]"');
    expect(note).toContain('  - ghost\n  - travel');
    expect(note).toContain('Aaron asked about a trip with [[Sam]].');
    expect(note).toContain('> *(looked at your screen: a map of Japan)*');
    const daily = readdirSync(vault).filter(f => /^\d{4}-\d\d-\d\d\.md$/.test(f));
    expect(readFileSync(join(vault, daily[0]), 'utf8')).toMatch(/## Ghost\n- \d\d:\d\d \[\[\d{4}-\d\d-\d\d Trip with Sam\|Trip with Sam]]/);

    ws.send(JSON.stringify({ type: 'obsidian_status' }));
    await until(() => inbox.some(m => m.type === 'obsidian_status'));
    const status = inbox.find((m): m is Extract<CoreMessage, { type: 'obsidian_status' }> => m.type === 'obsidian_status')!.status;
    expect(status.connected).toMatchObject({ notes: expect.any(Number), waiting: false });
    ws.close();
  });

  it('remembers facts as Memory notes', async () => {
    const { vault } = await setup();
    core!.memory.remember('Sam likes ramen', 'People');
    expect(readFileSync(join(vault, 'Ghost', 'Memory', 'People.md'), 'utf8')).toContain('- [[Sam]] likes ramen');
    expect(core!.memory.contextFor('what does Sam like to eat')).toContain('Sam likes ramen');
  });
});
