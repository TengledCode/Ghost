import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/core/approvals/classify';
import { ConversationLog } from '../src/core/memory/conversations';
import { MemoryStore } from '../src/core/memory/store';
import { agyHookDecision, agyPaths, writeAgyPlugin } from '../src/core/providers/agyPlugin';
import { execFileSync } from 'node:child_process';
import { classifyError } from '../src/core/providers/types';
import { ReminderScheduler } from '../src/core/reminders/scheduler';
import { ToolExecutor } from '../src/core/tools/executor';
import { isInside, safeReadRoots } from '../src/core/tools/fileAccess';
import { mergeSettings } from '../src/shared/settings';

const host = { openExternal: async () => {}, openPath: async () => '', trash: async () => {} };
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe('file access', () => {
  it("follows links: a shortcut inside Documents to a private folder isn't safe", () => {
    const home = tmp('ghost-home-');
    mkdirSync(join(home, 'Documents'));
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id'), 'key');
    symlinkSync(join(home, '.ssh'), join(home, 'Documents', 'keys'));
    const roots = safeReadRoots({ ghostDirs: [], home });
    expect(isInside(join(home, 'Documents', 'keys', 'id'), roots)).toBe(false);
    expect(classify('read_file', { path: join(home, 'Documents', 'keys', 'id') }, { safeReadRoots: roots })).toBe('confirm');
  });
  it('never treats a network share as safe', () => {
    expect(isInside('\\\\server\\share\\x.txt', ['\\\\server\\share'])).toBe(false);
  });
});

describe("Antigravity's own file tools", () => {
  const roots = ['C:\\Users\\Aaron\\Documents', 'C:\\Users\\Aaron\\AppData\\Roaming\\Ghost\\data\\workspace'];
  it('may look inside the safe folders', () => {
    expect(agyHookDecision({ name: 'view_file', args: { AbsolutePath: 'C:\\Users\\Aaron\\Documents\\plan.md' } }, roots).decision).toBe('allow');
    expect(agyHookDecision({ name: 'view_file', args: { AbsolutePath: 'c:/users/aaron/appdata/roaming/ghost/data/workspace/screens/s.png' } }, roots).decision).toBe('allow');
    expect(agyHookDecision({ name: 'grep_search', args: { Query: 'budget', SearchPath: 'C:\\Users\\Aaron\\Documents' } }, roots).decision).toBe('allow');
  });
  it('is sent to Ghost\'s read_file anywhere else', () => {
    const deny = (args: Record<string, unknown>, name = 'view_file') => agyHookDecision({ name, args }, roots);
    expect(deny({ AbsolutePath: 'C:\\Users\\Aaron\\.ssh\\id_ed25519' }).decision).toBe('deny');
    expect(deny({ AbsolutePath: 'C:\\Users\\Aaron\\Documents\\..\\.ssh\\id' }).decision).toBe('deny');
    expect(deny({ AbsolutePath: 'C:\\Users\\Aaron\\Documents-old\\x' }).decision).toBe('deny');
    expect(deny({ DirectoryPath: '\\\\server\\share' }, 'list_dir').decision).toBe('deny');
    expect(deny({ SearchDirectory: 'C:\\' }, 'find_by_name').reason).toMatch(/read_file/);
  });
  it.skipIf(process.platform === 'win32')('works as the real hook script agy runs', () => {
    const paths = agyPaths(tmp('ghost-hook-'));
    writeAgyPlugin(paths, { nodeExecPath: process.execPath, mcpServerPath: 'x.js', env: {}, safeReadRoots: ['/home/aaron/Documents'], windows: false });
    const run = (toolCall: object) => JSON.parse(execFileSync(join(paths.plugin, 'hook.sh'), { input: JSON.stringify({ toolCall }) }).toString());
    expect(run({ name: 'view_file', args: { AbsolutePath: '/home/aaron/Documents/a.md' } }).decision).toBe('allow');
    expect(run({ name: 'view_file', args: { AbsolutePath: '/home/aaron/.ssh/id' } }).decision).toBe('deny');
    expect(run({ name: 'call_mcp_tool', args: { ServerName: 'ghost_ghost' } }).decision).toBe('allow');
  });
  it('keeps the old rules for everything else', () => {
    expect(agyHookDecision({ name: 'search_web', args: { query: 'C:\\secret' } }, roots).decision).toBe('allow');
    expect(agyHookDecision({ name: 'run_command', args: {} }, roots).decision).toBe('deny');
  });
});

describe('read_file and list_folder', () => {
  const exec = () => new ToolExecutor(host, new MemoryStore(join(tmp('ghost-m-'), 'm.json')), new ReminderScheduler(join(tmp('ghost-r-'), 'r.json'), () => {}));
  it('reads text, refuses programs and trims long files', async () => {
    const dir = tmp('ghost-files-');
    writeFileSync(join(dir, 'a.txt'), 'hello');
    writeFileSync(join(dir, 'app.bin'), Buffer.from([0x4d, 0x5a, 0, 0, 1, 2]));
    writeFileSync(join(dir, 'big.log'), 'x'.repeat(100_000));
    const e = exec();
    expect(await e.run('read_file', { path: join(dir, 'a.txt') })).toBe('hello');
    expect(await e.run('read_file', { path: join(dir, 'app.bin') })).toMatch(/isn't a text file/);
    expect(String(await e.run('read_file', { path: join(dir, 'big.log') }))).toMatch(/truncated; the file is 100 KB/);
    expect(await e.run('read_file', { path: join(dir, 'nope.txt') })).toMatch(/no file/);
    expect(await e.run('read_file', { path: 'relative.txt' })).toMatch(/absolute/);
    expect(await e.run('list_folder', { path: dir })).toMatch(/a\.txt {2}\(5 B, \d{4}-\d\d-\d\d\)/);
  });
  it('returns pictures as images', async () => {
    const dir = tmp('ghost-img-');
    writeFileSync(join(dir, 'p.png'), Buffer.from('fakepng'));
    const r = await exec().run('read_file', { path: join(dir, 'p.png') });
    expect(r).toEqual({ text: 'Image p.png', image: { data: Buffer.from('fakepng').toString('base64'), mime: 'image/png' } });
  });
});

describe('forget', () => {
  it("won't wipe memory with a tiny or sweeping match", async () => {
    const memory = new MemoryStore(join(tmp('ghost-f-'), 'm.json'));
    for (const f of ['likes tea', 'likes coffee', 'likes cats', 'likes jazz', 'likes rain', 'likes chess']) memory.remember(f);
    const e = new ToolExecutor(host, memory, new ReminderScheduler(join(tmp('ghost-r-'), 'r.json'), () => {}));
    expect(await e.run('forget', { match: '' })).toMatch(/memory id or a few words/);
    expect(await e.run('forget', { match: 'e' })).toMatch(/memory id or a few words/);
    expect(await e.run('forget', { match: 'likes' })).toMatch(/matches 6 memories/);
    expect(memory.list()).toHaveLength(6);
    expect(await e.run('forget', { match: 'likes jazz' })).toBe('Forgot 1 item(s).');
    expect(memory.forget('')).toBe(0);
  });
});

describe('robustness', () => {
  it('keeps a conversation readable when one line is damaged', () => {
    const dir = tmp('ghost-c-');
    const log = new ConversationLog(dir, Date.now, () => ({ user: 'Sam', assistant: 'Echo' }));
    log.append('user', 'first message about tea');
    appendFileSync(join(dir, 'conversations', `${log.current.conversationId}.jsonl`), '{"ts":"2026-10-01T10:00:00Z","role":"assis\n');
    log.append('assistant', 'second message about tea');
    expect(log.lines().map(l => l.text)).toEqual(['first message about tea', 'second message about tea']);
    expect(log.search('tea')[0]).toMatch(/(Sam|Echo): /); // the real names, not hard-coded ones
  });
  it('drops settings that no longer exist', () => {
    const s = mergeSettings({ compatibleDrawing: true, hideOnFullscreen: false, someOldThing: 1, size: 200 } as never);
    expect(Object.keys(s)).not.toEqual(expect.arrayContaining(['compatibleDrawing']));
    expect('someOldThing' in s).toBe(false);
    expect(s.fullscreenHide).toBe('never'); // still migrated first
    expect(s.size).toBe(200);
  });
  it("doesn't mistake any missing file for a missing CLI", () => {
    expect(classifyError('spawn claude ENOENT')).toBe('missing');
    expect(classifyError("ENOENT: no such file or directory, open 'C:\\x\\session.json'")).toBe('other');
  });
});
