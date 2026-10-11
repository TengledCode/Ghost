import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';

// The browser's MediaRecorder writes MP4 in fragments (a header, then a chunk every second) and never
// goes back to fill in the total length, so Windows shows no length and Media Player can't seek.
// Once a recording is saved, this adds up each track's fragments and writes the real duration into
// the header's existing fields. Nothing changes size, so the rest of the file is untouched.

interface Box { type: string; start: number; header: number; size: number }

function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o);
    let header = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(o + 8)); header = 16; } else if (size === 0) size = end - o;
    if (size < header || o + size > end) return;
    yield { type: buf.toString('latin1', o + 4, o + 8), start: o, header, size };
    o += size;
  }
}

const child = (buf: Buffer, parent: Box, type: string) => [...boxes(buf, parent.start + parent.header, parent.start + parent.size)].find(b => b.type === type);
const children = (buf: Buffer, parent: Box, type: string) => [...boxes(buf, parent.start + parent.header, parent.start + parent.size)].filter(b => b.type === type);

/** Reads `length` bytes at `pos` of an open file. */
function readAt(fd: number, pos: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, pos + got);
    if (!n) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** The top-level boxes of a file, reading only their headers (a recording can be gigabytes). */
function topLevel(fd: number): Box[] {
  const end = fstatSync(fd).size;
  const out: Box[] = [];
  let o = 0;
  while (o + 8 <= end) {
    const h = readAt(fd, o, 16);
    let size = h.readUInt32BE(0);
    let header = 8;
    if (size === 1) { size = Number(h.readBigUInt64BE(8)); header = 16; } else if (size === 0) size = end - o;
    if (size < header) break;
    out.push({ type: h.toString('latin1', 4, 8), start: o, header, size });
    o += size;
  }
  return out;
}

/**
 * Writes the real length into a fragmented MP4's header. Returns the length in seconds, or null if the
 * file isn't a fragmented MP4 (or already has a length), in which case it is left as it was.
 */
export function fixMp4Duration(path: string): number | null {
  const fd = openSync(path, 'r+');
  try {
    const top = topLevel(fd);
    const moovBox = top.find(b => b.type === 'moov');
    if (!moovBox || !top.some(b => b.type === 'moof')) return null;
    const moov = readAt(fd, moovBox.start, moovBox.size);
    const root: Box = { ...moovBox, start: 0 };
    const mvhd = child(moov, root, 'mvhd');
    if (!mvhd) return null;
    const mvhdAt = mvhd.start + mvhd.header;
    const mvhdV1 = moov[mvhdAt] === 1;
    const movieScale = moov.readUInt32BE(mvhdAt + (mvhdV1 ? 20 : 12));
    if (Number(mvhdV1 ? moov.readBigUInt64BE(mvhdAt + 24) : moov.readUInt32BE(mvhdAt + 16)) > 0) return null;

    // Each track's default sample length, from the movie extends box.
    const defaults = new Map<number, number>();
    const mvex = child(moov, root, 'mvex');
    for (const trex of mvex ? children(moov, mvex, 'trex') : []) {
      const p = trex.start + trex.header;
      defaults.set(moov.readUInt32BE(p + 4), moov.readUInt32BE(p + 12));
    }

    // Where each track ends, in its own timescale: the last fragment's start time plus its samples.
    const ends = new Map<number, number>();
    for (const m of top.filter(b => b.type === 'moof')) {
      const moof = readAt(fd, m.start, m.size);
      const moofRoot: Box = { ...m, start: 0 };
      for (const traf of children(moof, moofRoot, 'traf')) {
        const tfhd = child(moof, traf, 'tfhd');
        if (!tfhd) continue;
        let p = tfhd.start + tfhd.header;
        const flags = moof.readUInt32BE(p) & 0xffffff;
        const track = moof.readUInt32BE(p + 4);
        p += 8;
        if (flags & 0x01) p += 8; // base data offset
        if (flags & 0x02) p += 4; // sample description index
        const defaultDuration = flags & 0x08 ? moof.readUInt32BE(p) : defaults.get(track) ?? 0;
        const tfdt = child(moof, traf, 'tfdt');
        let t = 0;
        if (tfdt) {
          const q = tfdt.start + tfdt.header;
          t = moof[q] === 1 ? Number(moof.readBigUInt64BE(q + 4)) : moof.readUInt32BE(q + 4);
        } else t = ends.get(track) ?? 0;
        for (const trun of children(moof, traf, 'trun')) {
          let q = trun.start + trun.header;
          const tf = moof.readUInt32BE(q) & 0xffffff;
          const count = moof.readUInt32BE(q + 4);
          q += 8;
          if (tf & 0x01) q += 4; // data offset
          if (tf & 0x04) q += 4; // first sample flags
          const each = (tf & 0x100 ? 4 : 0) + (tf & 0x200 ? 4 : 0) + (tf & 0x400 ? 4 : 0) + (tf & 0x800 ? 4 : 0);
          if (tf & 0x100) for (let i = 0; i < count; i++) t += moof.readUInt32BE(q + i * each);
          else t += count * defaultDuration;
        }
        ends.set(track, Math.max(ends.get(track) ?? 0, t));
      }
    }

    // Write each track's length (tkhd in the movie's timescale, mdhd in the track's) and the movie's.
    let movieDuration = 0;
    for (const trak of children(moov, root, 'trak')) {
      const tkhd = child(moov, trak, 'tkhd');
      const mdia = child(moov, trak, 'mdia');
      const mdhd = mdia && child(moov, mdia, 'mdhd');
      if (!tkhd || !mdhd) continue;
      const tkV1 = moov[tkhd.start + tkhd.header] === 1;
      const track = moov.readUInt32BE(tkhd.start + tkhd.header + (tkV1 ? 20 : 12));
      const end = ends.get(track);
      if (!end) continue;
      const mdV1 = moov[mdhd.start + mdhd.header] === 1;
      const scale = moov.readUInt32BE(mdhd.start + mdhd.header + (mdV1 ? 20 : 12));
      const inMovie = Math.round(end * movieScale / scale);
      movieDuration = Math.max(movieDuration, inMovie);
      writeLength(moov, mdhd.start + mdhd.header + (mdV1 ? 24 : 16), mdV1, end);
      writeLength(moov, tkhd.start + tkhd.header + (tkV1 ? 28 : 20), tkV1, inMovie);
    }
    if (!movieDuration) return null;
    writeLength(moov, mvhdAt + (mvhdV1 ? 24 : 16), mvhdV1, movieDuration);
    writeSync(fd, moov, 0, moov.length, moovBox.start);
    return movieDuration / movieScale;
  } finally {
    closeSync(fd);
  }
}

function writeLength(buf: Buffer, at: number, wide: boolean, value: number): void {
  if (wide) buf.writeBigUInt64BE(BigInt(value), at);
  else buf.writeUInt32BE(Math.min(value, 0xffffffff), at);
}
