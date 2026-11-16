import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GhostCore } from '../src/core/ghostCore';
import { clearPastedImages, savePastedImages } from '../src/core/pasted';
import { buildTurnPrompt } from '../src/core/persona';
import type { Provider, ProviderEvent, SendRequest } from '../src/core/providers/types';
import { TtsService } from '../src/core/tts/service';
import type { TtsEngine } from '../src/core/tts/types';
import { mergeSettings } from '../src/shared/settings';

const tmp = () => mkdtempSync(join(tmpdir(), 'ghost-pasted-'));
const png = (text = 'fakepng') => ({ mime: 'image/png', data: Buffer.from(text).toString('base64') });

describe('pictures pasted into the text box', () => {
  it('are saved as files for the brain to look at', () => {
    const dir = tmp();
    const paths = savePastedImages(dir, [png('one'), { mime: 'image/jpeg', data: Buffer.from('two').toString('base64') }], new Date('2026-11-15T12:00:00Z'));
    expect(paths.map(p => p.slice(dir.length + 1))).toEqual(['pasted-2026-11-15T12-00-00-000Z-1.png', 'pasted-2026-11-15T12-00-00-000Z-2.jpg']);
    expect(readFileSync(paths[0], 'utf8')).toBe('one');
  });
  it('takes only real pictures: a known type, proper base64, at most four, not too big', () => {
    const dir = tmp();
    expect(savePastedImages(dir, 'nope')).toEqual([]);
    expect(savePastedImages(dir, [{ mime: 'text/html', data: 'PGI+' }, { mime: 'image/png', data: '../../x' }, { mime: 'image/png' }, { mime: 'image/svg+xml', data: 'PHN2Zz4=' }, null])).toEqual([]);
    expect(existsSync(join(dir, 'pasted-x'))).toBe(false);
    expect(savePastedImages(dir, [png(), png(), png(), png(), png(), png()])).toHaveLength(4);
    expect(savePastedImages(dir, [{ mime: 'image/png', data: Buffer.alloc(12_000_001).toString('base64') }])).toEqual([]);
  });
  it('keeps only the newest twenty', () => {
    const dir = tmp();
    for (let i = 0; i < 12; i++) savePastedImages(dir, [png(), png()], new Date(Date.UTC(2026, 10, 15, 12, i)));
    const kept = readdirSync(dir).sort();
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe('pasted-2026-11-15T12-02-00-000Z-1.png'); // the first two messages' pictures are gone
  });
  it('are gone once Ghost closes, and when it next starts', () => {
    const dir = join(tmp(), 'pasted');
    savePastedImages(dir, [png()]);
    clearPastedImages(dir);
    expect(existsSync(dir)).toBe(false);
    clearPastedImages(dir); // nothing there: no error
  });
  it('are named in the message\'s context, with the tool to look at them', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    expect(buildTurnPrompt('what is this?', { now, memories: [], userName: 'Aaron', pictures: ['C:\\g\\pasted\\p1.png'] }))
      .toMatch(/Aaron pasted a picture into this message: C:\\g\\pasted\\p1\.png\. Look at it with Ghost's read_file tool/);
    expect(buildTurnPrompt('compare', { now, memories: [], userName: 'Aaron', pictures: ['a.png', 'b.png'] })).toMatch(/pasted 2 pictures.*a\.png, b\.png.*each of them/);
    expect(buildTurnPrompt('hi', { now, memories: [], userName: 'Aaron', pictures: [] })).not.toMatch(/pasted/);
  });
});

describe('a message with a pasted picture, in the core', () => {
  const silent: TtsEngine = { id: 'edge', synthesize: async () => ({ audio: Buffer.from('x'), mime: 'audio/mpeg' }) };
  class RecordingProvider implements Provider {
    readonly id = 'claude' as const;
    sent: SendRequest[] = [];
    async isAvailable() { return true; }
    async *send(req: SendRequest): AsyncIterable<ProviderEvent> { this.sent.push(req); yield { type: 'done', text: 'Noted.' }; }
  }
  function makeCore() {
    const provider = new RecordingProvider();
    const dataDir = tmp();
    const shots: string[] = [];
    const core = new GhostCore({
      dataDir, personaPath: join(__dirname, '../config/persona.md'), mcpServerPath: '/x.js', nodeExecPath: process.execPath,
      providers: { claude: provider }, tts: new TtsService(silent, silent), settings: () => mergeSettings({ provider: 'claude', fallbackProvider: null, voiceEnabled: false }),
      host: {
        openExternal: async () => {}, openPath: async () => '', trash: async () => {},
        capture: { screenshot: async () => { shots.push('shot'); return { path: 'C:\\p\\s.png' }; }, startRecording: async () => {}, stopRecording: async () => '', setRecordingMic: () => {}, recording: () => ({ on: false, mic: false }), latest: async () => null },
      },
    });
    return { core, provider, dataDir, shots };
  }

  it('goes to the brain with the picture\'s path, on the Balanced model at least', async () => {
    const { core, provider, dataDir } = makeCore();
    await core.userMessage('hi', [png()]); // "hi" alone would take the Light model
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].model).toBe('sonnet');
    expect(provider.sent[0].prompt).toContain(join(dataDir, 'workspace', 'pasted'));
    expect(core.log.lines().find(l => l.role === 'user')?.text).toBe('hi *(with 1 pasted picture)*');
  });
  it('works with no words at all', async () => {
    const { core, provider } = makeCore();
    await core.userMessage('', [png(), png()]);
    expect(provider.sent[0].prompt).toMatch(/pasted 2 pictures/);
    expect(provider.sent[0].prompt).toMatch(/Have a look at these pictures\.$/);
    await core.userMessage('   ');
    expect(provider.sent).toHaveLength(1); // nothing to send
  });
  it('skips the shortcuts: "take a screenshot" with a picture is a question for the brain', async () => {
    const { core, provider, shots } = makeCore();
    await core.userMessage('take a screenshot', [png()]);
    expect(shots).toEqual([]);
    expect(provider.sent).toHaveLength(1);
    await core.userMessage('take a screenshot');
    expect(shots).toEqual(['shot']);
  });
});
