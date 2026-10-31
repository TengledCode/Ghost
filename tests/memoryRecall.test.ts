import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore, recallQuery } from '../src/core/memory/store';

// The 4 Oct 2026 mix-up: "do you have the source of this? could you link it here thanks", asked
// right after a Roborock warranty question, recalled an unrelated NTUC note that mentions "Link"
// and a "source", and the brain answered about NTUC.
const ROBOROCK = "what is roborock's warranty like for robot vacuums? when is the deadline for submitting it if i bought it from shopee?";
const FOLLOW_UP = 'do you have the source of this? could you link it here thanks';

describe('picking memories for a message', () => {
  it('ignores chat filler, and lets a short follow-up borrow the previous message', () => {
    expect(recallQuery(FOLLOW_UP)).toBe('');
    expect(recallQuery(FOLLOW_UP, ROBOROCK)).toMatch(/roborock.*warranty/);
    expect(recallQuery('what does my NTUC membership cover?', ROBOROCK)).toBe('ntuc membership cover'); // a real topic stands alone
  });

  it("doesn't drag an unrelated note into a follow-up", () => {
    const m = new MemoryStore(join(mkdtempSync(join(tmpdir(), 'ghost-recall-')), 'm.json'));
    m.addEpisode('NTUC membership excludes SAF personnel; source: NTUC eligibility page and the Link Rewards Programme.');
    m.addEpisode('Asked about the Roborock robot vacuum warranty when bought on Shopee.');
    const context = m.contextFor(FOLLOW_UP, 0, ROBOROCK);
    expect(context.some(c => /Roborock/.test(c))).toBe(true);
    expect(context.some(c => /NTUC/.test(c))).toBe(false);
    expect(m.contextFor(FOLLOW_UP, 0)).toEqual([]); // with nothing to go on, nothing is recalled
  });
});
