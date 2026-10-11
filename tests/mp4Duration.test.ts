import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixMp4Duration } from '../src/main/mp4Duration';

// A minimal fragmented MP4 shaped like the browser's MediaRecorder output: a header with zero
// lengths, then fragments whose samples carry their own durations.
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const u32 = (...n: number[]) => { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v, i * 4)); return b; };
const zeros = (n: number) => Buffer.alloc(n);

const mvhd = () => box('mvhd', u32(0, 0, 0, 1000, 0), zeros(80)); // timescale 1000, duration 0
const trak = (id: number, scale: number) => box('trak',
  box('tkhd', u32(0, 0, 0, id, 0, 0), zeros(60)),
  box('mdia', box('mdhd', u32(0, 0, 0, scale, 0), zeros(4))));
const trex = (id: number, duration: number) => box('trex', u32(0, id, 1, duration, 0, 0));
// One fragment: track `id` starting at `start`, with samples of the given durations (or the default).
const traf = (id: number, start: number, samples: number[] | { count: number }) => box('traf',
  box('tfhd', u32(0x020000, id)),
  box('tfdt', u32(0, start)),
  Array.isArray(samples)
    ? box('trun', u32(0x000301, samples.length, 0), ...samples.map(d => u32(d, 100)))
    : box('trun', u32(0x000201, samples.count, 0), ...Array.from({ length: samples.count }, () => u32(100))));

function recording(): Buffer {
  return Buffer.concat([
    box('ftyp', Buffer.from('isom'), u32(0)),
    box('moov', mvhd(), trak(1, 48000), trak(2, 30000), box('mvex', trex(1, 1024), trex(2, 0))),
    box('moof', box('mfhd', u32(0, 1)), traf(1, 0, { count: 47 }), traf(2, 0, [1000, 1000, 1000])),
    box('mdat', zeros(64)),
    box('moof', box('mfhd', u32(0, 2)), traf(1, 48128, { count: 47 }), traf(2, 3000, Array(297).fill(1000))),
    box('mdat', zeros(64)),
  ]);
}

const tmp = () => join(mkdtempSync(join(tmpdir(), 'ghost-mp4-')), 'r.mp4');

describe('fixMp4Duration', () => {
  it('writes the real length into a recording header', () => {
    const path = tmp();
    writeFileSync(path, recording());
    const before = readFileSync(path).length;
    // Audio: 94 samples of 1024 at 48 kHz = 2.005 s. Video: 300 frames of 1000 at 30 kHz = 10 s.
    expect(fixMp4Duration(path)).toBeCloseTo(10, 3);
    const out = readFileSync(path);
    expect(out.length).toBe(before);
    const at = (type: string, from = 0) => out.indexOf(type, from, 'latin1') - 4;
    expect(out.readUInt32BE(at('mvhd') + 8 + 16)).toBe(10_000);
    const mdhd1 = at('mdhd');
    expect(out.readUInt32BE(mdhd1 + 8 + 16)).toBe(94 * 1024);
    expect(out.readUInt32BE(at('mdhd', mdhd1 + 8) + 8 + 16)).toBe(300_000);
    const tkhd1 = at('tkhd');
    expect(out.readUInt32BE(tkhd1 + 8 + 20)).toBe(Math.round(94 * 1024 / 48));
    expect(out.readUInt32BE(at('tkhd', tkhd1 + 8) + 8 + 20)).toBe(10_000);
    // Only the header changed.
    const moovEnd = at('moof');
    expect(out.subarray(moovEnd).equals(recording().subarray(moovEnd))).toBe(true);
  });

  it('leaves a file with a length, or a non-MP4, alone', () => {
    const path = tmp();
    writeFileSync(path, recording());
    fixMp4Duration(path);
    const once = readFileSync(path);
    expect(fixMp4Duration(path)).toBeNull();
    expect(readFileSync(path).equals(once)).toBe(true);
    writeFileSync(path, Buffer.from('not a video at all'));
    expect(fixMp4Duration(path)).toBeNull();
  });

  it.runIf(process.env.GHOST_MP4)('fixes a real recording (GHOST_MP4=path)', () => {
    const length = fixMp4Duration(process.env.GHOST_MP4!);
    console.log('length', length);
    expect(length).toBeGreaterThan(0);
  });
});
