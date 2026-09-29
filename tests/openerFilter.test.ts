import { describe, expect, it } from 'vitest';
import { OpenerFilter } from '../src/core/openerFilter';

function run(deltas: string[]): string {
  const f = new OpenerFilter('Aaron');
  return deltas.map(d => f.push(d)).join('') + f.flush();
}

describe('OpenerFilter (answers start with the answer)', () => {
  it('drops pleasantries, even when split across deltas', () => {
    expect(run(['Cert', 'ainly, Aa', 'ron. Paris is ', 'the capital.'])).toBe('Paris is the capital.');
    expect(run(['Very good. ', "I've opened Notepad."])).toBe("I've opened Notepad.");
    expect(run(['Of course, ', 'the file is saved. More text.'])).toBe('The file is saved. More text.');
    expect(run(['Good question, Aaron. It depends.'])).toBe('It depends.');
  });

  it('leaves real answers alone', () => {
    expect(run(['Very good results came from the second test.'])).toBe('Very good results came from the second test.');
    expect(run(['Sure enough, it rained.'])).toBe('Sure enough, it rained.');
    expect(run(['Aaron, your meeting starts in 5 minutes.'])).toBe('Aaron, your meeting starts in 5 minutes.');
  });

  it('keeps a reply that is only a pleasantry, rather than saying nothing', () => {
    expect(run(['Certainly, Aaron.'])).toBe('Certainly, Aaron.');
  });

  it('passes text through without delay once the opening is settled', () => {
    const f = new OpenerFilter('Aaron');
    expect(f.push('Certainly. ')).toBe('');
    expect(f.push('It is 3 pm. ')).toBe('It is 3 pm. ');
    expect(f.push('Anything else')).toBe('Anything else');
  });
});
