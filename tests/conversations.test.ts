import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationLog } from '../src/core/memory/conversations';
import { MemoryStore } from '../src/core/memory/store';
import { ReminderScheduler } from '../src/core/reminders/scheduler';
import { ToolExecutor } from '../src/core/tools/executor';

const HOUR = 3600_000;

describe('ConversationLog', () => {
  it('survives a restart: same conversation and Claude session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-log-'));
    const a = new ConversationLog(dir);
    a.append('user', 'Book me a table at Burnt Ends on Friday');
    a.append('assistant', 'Very good. Friday at eight, for two?', { provider: 'claude', model: 'sonnet' });
    a.setClaudeSession('sess-42');
    const b = new ConversationLog(dir); // the app restarted
    expect(b.current.conversationId).toBe(a.current.conversationId);
    expect(b.current.claudeSessionId).toBe('sess-42');
    expect(b.lines().map(l => l.role)).toEqual(['user', 'assistant']);
  });

  it('marks a conversation stale after the idle window and rotates to a fresh one', () => {
    let now = Date.parse('2026-09-28T10:00:00Z');
    const dir = mkdtempSync(join(tmpdir(), 'ghost-log-'));
    const log = new ConversationLog(dir, () => now);
    expect(log.isStale(2 * HOUR)).toBe(false); // empty conversations are never stale
    log.append('user', 'hello');
    now += 3 * HOUR;
    expect(log.isStale(2 * HOUR)).toBe(true);
    const ended = log.rotate();
    expect(ended).not.toBe(log.current.conversationId);
    expect(log.lines(ended)).toHaveLength(1);
    expect(log.lines()).toHaveLength(0);
  });

  it('searches every past conversation with dates, and clears on request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-log-'));
    const log = new ConversationLog(dir);
    log.append('user', 'What was the film you recommended? Something with a heist');
    log.append('assistant', 'Heat, 1995. Michael Mann. You would like the diner scene.');
    log.rotate();
    log.append('user', 'Remind me to water the plants');
    const hits = log.search('which heist film did you recommend');
    expect(hits[0]).toMatch(/^\(\d{4}-\d{2}-\d{2}\) (Aaron|Ghost): .*heist/i);
    log.clear();
    expect(log.search('heist')).toEqual([]);
  });
});

describe('recall tool', () => {
  it('returns stored facts and matching lines from past conversations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghost-recall-'));
    const memory = new MemoryStore(join(dir, 'memory.json'));
    memory.remember('Aaron prefers window seats on flights');
    const log = new ConversationLog(dir);
    log.append('user', 'Should I take the Tokyo flight on Thursday or Friday?');
    log.append('assistant', 'Thursday. The Friday flight lands too late for your dinner.');
    const tools = new ToolExecutor({ openExternal: async () => {}, openPath: async () => '', trash: async () => {} }, memory,
      new ReminderScheduler(join(dir, 'r.json'), () => {}), log);
    const out = await tools.run('recall', { query: 'which Tokyo flight did we pick' });
    expect(out).toContain('From past conversations:');
    expect(out).toMatch(/Tokyo flight/);
    const facts = await tools.run('recall', { query: 'window seats' });
    expect(facts).toContain('Memory:');
  });
});
