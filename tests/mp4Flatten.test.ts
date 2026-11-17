import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flattenMp4 } from '../src/main/mp4Flatten';

// A small fragmented MP4 laid out like Chrome's MediaRecorder output (default-base-is-moof, runs with
// data offsets, per-sample durations and sizes, key frames marked by the first sample's flags).
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const u32 = (...n: number[]) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
const zeros = (n: number) => Buffer.alloc(n);
const NON_SYNC = 0x10000;

const empty = (type: string, extra = 0) => box(type, u32(0, ...Array(extra).fill(0)));
const trak = (id: number, scale: number, kind: 'soun' | 'vide') => box('trak',
  box('tkhd', u32(0, 0, 0, id, 0, 0), zeros(60)),
  box('mdia',
    box('mdhd', u32(0, 0, 0, scale, 0), zeros(4)),
    box('hdlr', u32(0, 0), Buffer.from(kind), zeros(13)),
    box('minf', kind === 'vide' ? box('vmhd', u32(1), zeros(8)) : box('smhd', u32(0, 0)), box('dinf', box('dref', u32(0, 0))),
      box('stbl', empty('stsc', 1), empty('stts', 1), empty('stsz', 2), empty('stco', 1), box('stsd', u32(0, 1), box(kind === 'vide' ? 'avc1' : 'mp4a', zeros(16)))))));

type Run = { id: number; start: number; samples: { data: string; duration: number }[]; key?: boolean };
/** One fragment (moof + mdat) holding the given runs, data in the order given. */
function fragment(seq: number, runs: Run[]): Buffer {
  const build = (offsets: number[]) => box('moof', box('mfhd', u32(0, seq)), ...runs.map((r, i) => box('traf',
    box('tfhd', u32(0x020020, r.id, r.key === undefined ? 0 : NON_SYNC)),
    box('tfdt', Buffer.from([1, 0, 0, 0]), Buffer.alloc(4), u32(r.start)),
    r.key === undefined
      ? box('trun', u32(0x01000301, r.samples.length, offsets[i]), ...r.samples.map(s => u32(s.duration, s.data.length)))
      : box('trun', u32(0x01000305, r.samples.length, offsets[i], r.key ? 0 : NON_SYNC), ...r.samples.map(s => u32(s.duration, s.data.length))))));
  const size = build(runs.map(() => 0)).length;
  const offsets: number[] = [];
  let at = size + 8;
  for (const r of runs) { offsets.push(at); at += r.samples.reduce((n, s) => n + s.data.length, 0); }
  return Buffer.concat([build(offsets), box('mdat', Buffer.from(runs.flatMap(r => r.samples.map(s => s.data)).join(''), 'latin1'))]);
}

function recording(): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom'), u32(0)),
    box('moov', box('mvhd', u32(0, 0, 0, 1000, 0), zeros(80)), trak(1, 48000, 'soun'), trak(2, 30000, 'vide'),
      box('mvex', box('trex', u32(0, 2, 1, 0, 0, 0)), box('trex', u32(0, 1, 1, 0, 0, 0)))),
    fragment(1, [
      { id: 1, start: 0, samples: [{ data: 'a1a', duration: 1024 }, { data: 'a2a2', duration: 1024 }] },
      { id: 2, start: 0, key: true, samples: [{ data: 'K1K1K', duration: 1000 }, { data: 'v2v2v2', duration: 1000 }] },
    ]),
    fragment(2, [
      { id: 1, start: 2048, samples: [{ data: 'a3', duration: 1024 }] },
      // Starts 500 after the previous fragment ended: the gap goes onto the sample before it.
      { id: 2, start: 2500, key: false, samples: [{ data: 'v3v', duration: 1000 }] },
    ]),
  ]);
}

/** Reads the plain MP4's tables back: each track's samples (bytes, duration) and key frames. */
function readBack(file: Buffer) {
  const kids = (start: number, end: number) => {
    const out: { type: string; start: number; end: number }[] = [];
    for (let o = start; o + 8 <= end;) { const size = file.readUInt32BE(o); out.push({ type: file.toString('latin1', o + 4, o + 8), start: o + 8, end: o + size }); o += size; }
    return out;
  };
  const find = (list: ReturnType<typeof kids>, type: string) => list.find(b => b.type === type)!;
  const top = kids(0, file.length);
  const moov = find(top, 'moov');
  return kids(moov.start, moov.end).filter(b => b.type === 'trak').map(trak => {
    const mdia = find(kids(trak.start, trak.end), 'mdia');
    const mdhd = find(kids(mdia.start, mdia.end), 'mdhd');
    const stbl = find(kids(find(kids(mdia.start, mdia.end), 'minf').start, find(kids(mdia.start, mdia.end), 'minf').end), 'stbl');
    const t = kids(stbl.start, stbl.end);
    const list = (type: string, skip: number, width: number) => { const b = find(t, type); const n = file.readUInt32BE(b.start + skip); return Array.from({ length: n * width }, (_, i) => file.readUInt32BE(b.start + skip + 4 + i * 4)); };
    const sizes = list('stsz', 8, 1), stts = list('stts', 4, 2), stsc = list('stsc', 4, 3), stco = list('stco', 4, 1);
    const durations = stts.flatMap((v, i) => (i % 2 ? [] : Array(v).fill(stts[i + 1])));
    const samples: string[] = [];
    let s = 0;
    stco.forEach((offset, chunk) => {
      let per = 0;
      for (let i = 0; i < stsc.length; i += 3) if (stsc[i] <= chunk + 1) per = stsc[i + 1];
      for (let k = 0, at = offset; k < per; k++) { samples.push(file.toString('latin1', at, at + sizes[s])); at += sizes[s++]; }
    });
    const stss = t.some(b => b.type === 'stss') ? list('stss', 4, 1) : null;
    return { samples, durations, stss, length: file.readUInt32BE(mdhd.start + 16), types: top.map(b => b.type) };
  });
}

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ghost-flat-')), 'r.mp4');

describe('flattenMp4 (recordings every app can open)', () => {
  it('rewrites a fragmented recording as one header and one block of data, every sample in place', () => {
    const path = tmp();
    writeFileSync(path, recording());
    // Video: 2 frames, a 500 gap, then 1 more = 3500 at 30 kHz; audio 3072 at 48 kHz. Longest: 0.117 s.
    expect(flattenMp4(path)).toBeCloseTo(3500 / 30000, 2);
    const [audio, video] = readBack(readFileSync(path));
    expect(audio.types).toEqual(['ftyp', 'moov', 'mdat']);
    expect(audio.samples).toEqual(['a1a', 'a2a2', 'a3']);
    expect(audio.durations).toEqual([1024, 1024, 1024]);
    expect(audio.length).toBe(3072);
    expect(audio.stss).toBeNull(); // every sound sample is a key sample
    expect(video.samples).toEqual(['K1K1K', 'v2v2v2', 'v3v']);
    expect(video.durations).toEqual([1000, 1500, 1000]); // the gap kept the picture in step with the sound
    expect(video.length).toBe(3500);
    expect(video.stss).toEqual([1]); // only the first frame is a key frame
  });

  it('leaves a file that is already plain, or not an MP4, as it was', () => {
    const path = tmp();
    writeFileSync(path, recording());
    flattenMp4(path);
    const once = readFileSync(path);
    expect(flattenMp4(path)).toBeNull();
    expect(readFileSync(path).equals(once)).toBe(true);
    writeFileSync(path, Buffer.from('not a video at all'));
    expect(flattenMp4(path)).toBeNull();
  });
});
