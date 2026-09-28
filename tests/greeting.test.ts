import { describe, expect, it } from 'vitest';
import { ACKS, AckPicker, classifyAck } from '../src/shared/acks';
import { birthdayFrom, pickGreeting } from '../src/core/greeting';
import { SentenceSplitter } from '../src/core/sentenceSplitter';

describe('acknowledgements', () => {
  it('rotates through every line of a pool before repeating, never back to back', () => {
    const picker = new AckPicker();
    for (const pool of Object.keys(ACKS) as (keyof typeof ACKS)[]) {
      const n = ACKS[pool].length;
      const seen = Array.from({ length: n * 6 }, () => picker.next(pool));
      for (let i = 0; i < seen.length; i += n) expect(new Set(seen.slice(i, i + n)).size).toBe(n);
      for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    }
  });

  it('picks a pool to suit the message', () => {
    expect(classifyAck('what is on my screen', 'balanced', true)).toBe('screen');
    expect(classifyAck('explain quantum computing', 'deep', false)).toBe('deep');
    expect(classifyAck("what's the weather in Singapore", 'fast', false)).toBe('search');
    expect(classifyAck('Please draft an email to Sam', 'balanced', false)).toBe('task');
    expect(classifyAck('why is the sky blue?', 'balanced', false)).toBe('question');
  });
});

describe('startup greeting', () => {
  const base = { userName: 'Aaron', assistantName: 'Ghost' };
  const at = (iso: string) => new Date(iso);
  const many = (i: Parameters<typeof pickGreeting>[0]) => new Set(Array.from({ length: 200 }, (_, k) => pickGreeting({ ...i, random: seeded(k) })));

  it('varies, and never says "good morning" in the evening', () => {
    const lines = many({ ...base, now: at('2026-09-29T19:30:00'), lastSeen: at('2026-09-29T09:00:00').getTime() });
    expect(lines.size).toBeGreaterThan(5);
    for (const l of lines) expect(l).not.toMatch(/morning/i);
    expect([...lines].some(l => /evening/i.test(l))).toBe(true);
  });

  it('notices a quick return and a long absence', () => {
    const now = at('2026-09-29T15:00:00');
    const soon = many({ ...base, now, lastSeen: now.getTime() - 5 * 60_000 });
    expect([...soon].some(l => /so soon|Here again|That was quick/.test(l))).toBe(true);
    for (const l of soon) expect(l).not.toMatch(/afternoon/i); // no time-of-day line after five minutes away
    const away = many({ ...base, now, lastSeen: now.getTime() - 5 * 86_400_000 });
    expect([...away].some(l => /few days|little while/.test(l))).toBe(true);
  });

  it('knows the day: Friday lines on a Friday, and a birthday from memory', () => {
    const fri = many({ ...base, now: at('2026-10-02T10:00:00'), lastSeen: at('2026-10-01T22:00:00').getTime() });
    expect([...fri].some(l => /Friday/.test(l))).toBe(true);
    const bday = pickGreeting({ ...base, now: at('2026-03-14T09:00:00'), facts: ["Aaron's birthday is 14 March"] });
    expect(bday).toMatch(/birthday|happy returns/i);
  });

  it('never repeats the previous greeting', () => {
    const now = at('2026-09-29T15:00:00');
    for (let k = 0; k < 50; k++) {
      const first = pickGreeting({ ...base, now, random: seeded(k) });
      expect(pickGreeting({ ...base, now, lastGreeting: first, random: seeded(k) })).not.toBe(first);
    }
  });

  it('reads birthdays written several ways', () => {
    expect(birthdayFrom(['Aaron was born on 1994-07-03'])).toEqual({ month: 6, day: 3 });
    expect(birthdayFrom(['birthday: March 14th'])).toEqual({ month: 2, day: 14 });
    expect(birthdayFrom(['likes tea'])).toBeNull();
  });
});

describe('speaking sooner', () => {
  it('lets the opening clause go to the voice on its own, then splits by sentence', () => {
    const s = new SentenceSplitter(true);
    const segs = [...s.push('The short answer is yes, although there are a few caveats worth knowing, '), ...s.push('and here they are. First, rent is flexible. ')];
    expect(segs[0].display).toBe('The short answer is yes,');
    expect(segs.slice(1).map(x => x.display.trim())).toEqual(['although there are a few caveats worth knowing, and here they are.', 'First, rent is flexible.']);
  });

  it('keeps short openers ("Very good, Aaron.") whole, and is off by default', () => {
    const s = new SentenceSplitter(true);
    expect(s.push('Very good, Aaron. Done. ').map(x => x.display.trim())).toEqual(['Very good, Aaron.']);
    expect(new SentenceSplitter().push('The short answer is yes, although not always. ').map(x => x.display.trim())).toEqual(['The short answer is yes, although not always.']);
  });
});

function seeded(seed: number): () => number {
  let x = seed * 2654435761 + 1;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}
