import { closeSync, fstatSync, openSync, rmSync, writeSync } from 'node:fs';
import { type Box, boxes, child, children, readAt, topLevel, writeLength } from './mp4Duration';

// The browser's MediaRecorder writes MP4 in fragments: a header with empty sample tables, then a
// fragment (moof + mdat) every second or so. Media Player copes, but other apps don't (WhatsApp hangs
// on it). This rewrites a recording as a plain MP4, the layout every app expects: ftyp, then one moov
// whose tables list every sample, then one mdat. The sound and picture data are copied byte for byte;
// only the index around them is rebuilt.

interface Sample { size: number; duration: number; sync: boolean; cto: number }
interface Chunk { from: number; length: number; samples: number } // where its data is in the old file
interface Track { id: number; samples: Sample[]; chunks: Chunk[]; time: number; hasCto: boolean }

const NON_SYNC = 0x10000; // sample_is_non_sync_sample, in sample flags

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
const full = (type: string, version: number, ...parts: Buffer[]) => box(type, u32(version << 24), ...parts);
function u32(...n: number[]): Buffer { const b = Buffer.alloc(4 * n.length); n.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; }
function u64(...n: number[]): Buffer { const b = Buffer.alloc(8 * n.length); n.forEach((v, i) => b.writeBigUInt64BE(BigInt(v), i * 8)); return b; }
const raw = (buf: Buffer, b: Box) => buf.subarray(b.start, b.start + b.size);

/** Reads every fragment's sample list (sizes, durations, key frames and where the data sits). */
function readFragments(fd: number, top: Box[], moov: Buffer, root: Box): Map<number, Track> {
  const trex = new Map<number, { duration: number; size: number; flags: number }>();
  const mvex = child(moov, root, 'mvex');
  for (const t of mvex ? children(moov, mvex, 'trex') : []) {
    const p = t.start + t.header;
    trex.set(moov.readUInt32BE(p + 4), { duration: moov.readUInt32BE(p + 12), size: moov.readUInt32BE(p + 16), flags: moov.readUInt32BE(p + 20) });
  }
  const tracks = new Map<number, Track>();
  for (const m of top.filter(b => b.type === 'moof')) {
    const moof = readAt(fd, m.start, m.size);
    let nextData = m.start; // where the next run's data starts, when a run doesn't say
    for (const traf of children(moof, { ...m, start: 0 }, 'traf')) {
      const tfhd = child(moof, traf, 'tfhd');
      if (!tfhd) continue;
      let p = tfhd.start + tfhd.header;
      const flags = moof.readUInt32BE(p) & 0xffffff;
      const id = moof.readUInt32BE(p + 4);
      p += 8;
      const defaults = trex.get(id) ?? { duration: 0, size: 0, flags: 0 };
      // Where data offsets count from: given, the moof itself (default-base-is-moof, as Chrome writes),
      // or else the end of the previous traf's data (the moof for the first).
      let base = flags & 0x20000 ? m.start : nextData;
      if (flags & 0x01) { base = Number(moof.readBigUInt64BE(p)); p += 8; }
      if (flags & 0x02) p += 4;
      const defDuration = flags & 0x08 ? moof.readUInt32BE((p += 4) - 4) : defaults.duration;
      const defSize = flags & 0x10 ? moof.readUInt32BE((p += 4) - 4) : defaults.size;
      const defFlags = flags & 0x20 ? moof.readUInt32BE(p) : defaults.flags;
      const track = tracks.get(id) ?? { id, samples: [], chunks: [], time: 0, hasCto: false };
      tracks.set(id, track);
      // Keep the tracks in step: a gap before this fragment lengthens the sample before it.
      const tfdt = child(moof, traf, 'tfdt');
      if (tfdt) {
        const q = tfdt.start + tfdt.header;
        const start = moof[q] === 1 ? Number(moof.readBigUInt64BE(q + 4)) : moof.readUInt32BE(q + 4);
        const last = track.samples.at(-1);
        if (last && start > track.time) last.duration += start - track.time;
        track.time = Math.max(track.time, start);
      }
      for (const trun of children(moof, traf, 'trun')) {
        let q = trun.start + trun.header;
        const head = moof.readUInt32BE(q);
        const version = head >>> 24, tf = head & 0xffffff;
        const count = moof.readUInt32BE(q + 4);
        q += 8;
        let data = nextData;
        if (tf & 0x01) { data = base + moof.readInt32BE(q); q += 4; }
        let firstFlags: number | undefined;
        if (tf & 0x04) { firstFlags = moof.readUInt32BE(q); q += 4; }
        let length = 0;
        for (let i = 0; i < count; i++) {
          const duration = tf & 0x100 ? moof.readUInt32BE((q += 4) - 4) : defDuration;
          const size = tf & 0x200 ? moof.readUInt32BE((q += 4) - 4) : defSize;
          const sampleFlags = tf & 0x400 ? moof.readUInt32BE((q += 4) - 4) : i === 0 && firstFlags !== undefined ? firstFlags : defFlags;
          const cto = tf & 0x800 ? (version ? moof.readInt32BE((q += 4) - 4) : moof.readUInt32BE((q += 4) - 4)) : 0;
          if (cto) track.hasCto = true;
          track.samples.push({ size, duration, sync: !(sampleFlags & NON_SYNC), cto });
          track.time += duration;
          length += size;
        }
        if (count) track.chunks.push({ from: data, length, samples: count });
        nextData = data + length;
      }
    }
  }
  return tracks;
}

/** A track's sample tables, with chunk offsets counted from `dataStart` in the new file. */
function sampleTable(track: Track, stsd: Buffer, isVideo: boolean, offsets: number[], wide: boolean): Buffer {
  const stts: number[] = [];
  for (const s of track.samples) {
    if (stts.length && stts[stts.length - 1] === s.duration) stts[stts.length - 2]++;
    else stts.push(1, s.duration);
  }
  const stsc: number[] = [];
  track.chunks.forEach((c, i) => { if (!stsc.length || stsc[stsc.length - 2] !== c.samples) stsc.push(i + 1, c.samples, 1); });
  const parts = [stsd, full('stts', 0, u32(stts.length / 2, ...stts))];
  const syncs = track.samples.flatMap((s, i) => (s.sync ? [i + 1] : []));
  if (isVideo && syncs.length < track.samples.length) parts.push(full('stss', 0, u32(syncs.length, ...syncs)));
  if (track.hasCto) {
    const ctts: number[] = [];
    for (const s of track.samples) {
      if (ctts.length && ctts[ctts.length - 1] === s.cto) ctts[ctts.length - 2]++;
      else ctts.push(1, s.cto);
    }
    parts.push(full('ctts', 1, u32(ctts.length / 2, ...ctts)));
  }
  parts.push(full('stsc', 0, u32(stsc.length / 3, ...stsc)));
  parts.push(full('stsz', 0, u32(0, track.samples.length, ...track.samples.map(s => s.size))));
  parts.push(wide ? full('co64', 0, u32(offsets.length), u64(...offsets)) : full('stco', 0, u32(offsets.length, ...offsets)));
  return box('stbl', ...parts);
}

/** Copies a duration-patched header box (mvhd, tkhd, mdhd), writing `value` into its length field. */
function withLength(buf: Buffer, b: Box, field: { v0: number; v1: number }, value: number): Buffer {
  const out = Buffer.from(raw(buf, b));
  const v1 = out[b.header] === 1;
  writeLength(out, b.header + (v1 ? field.v1 : field.v0), v1, value);
  return out;
}
const timescale = (buf: Buffer, b: Box) => buf.readUInt32BE(b.start + b.header + (buf[b.start + b.header] === 1 ? 20 : 12));

function buildMoov(moov: Buffer, root: Box, tracks: Map<number, Track>, chunkOffsets: Map<number, number[]>, wide: boolean): Buffer {
  const mvhd = child(moov, root, 'mvhd')!;
  const movieScale = timescale(moov, mvhd);
  let movieLength = 0;
  const traks: Buffer[] = [];
  for (const trak of children(moov, root, 'trak')) {
    const tkhd = child(moov, trak, 'tkhd')!;
    const id = moov.readUInt32BE(tkhd.start + tkhd.header + (moov[tkhd.start + tkhd.header] === 1 ? 20 : 12));
    const track = tracks.get(id);
    const mdia = child(moov, trak, 'mdia');
    const mdhd = mdia && child(moov, mdia, 'mdhd');
    const minf = mdia && child(moov, mdia, 'minf');
    const stbl = minf && child(moov, minf, 'stbl');
    const stsd = stbl && child(moov, stbl, 'stsd');
    if (!track || !track.samples.length || !mdhd || !minf || !stsd) continue; // a track with nothing recorded is left out
    const hdlr = child(moov, mdia, 'hdlr');
    const isVideo = !!hdlr && moov.toString('latin1', hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12) === 'vide';
    const length = track.samples.reduce((t, s) => t + s.duration, 0);
    const inMovie = Math.round(length * movieScale / timescale(moov, mdhd));
    movieLength = Math.max(movieLength, inMovie);
    const newMinf = box('minf', ...[...boxes(moov, minf.start + minf.header, minf.start + minf.size)]
      .map(b => (b.type === 'stbl' ? sampleTable(track, raw(moov, stsd), isVideo, chunkOffsets.get(id)!, wide) : raw(moov, b))));
    const newMdia = box('mdia', ...[...boxes(moov, mdia.start + mdia.header, mdia.start + mdia.size)]
      .map(b => (b.type === 'mdhd' ? withLength(moov, b, { v0: 16, v1: 24 }, length) : b.type === 'minf' ? newMinf : raw(moov, b))));
    traks.push(box('trak', ...[...boxes(moov, trak.start + trak.header, trak.start + trak.size)]
      .map(b => (b.type === 'tkhd' ? withLength(moov, b, { v0: 20, v1: 28 }, inMovie) : b.type === 'mdia' ? newMdia : raw(moov, b)))));
  }
  const rest = [...boxes(moov, root.start + root.header, root.start + root.size)].filter(b => !['mvhd', 'trak', 'mvex'].includes(b.type));
  return box('moov', withLength(moov, mvhd, { v0: 16, v1: 24 }, movieLength), ...traks, ...rest.map(b => raw(moov, b)));
}

/**
 * Writes a fragmented MP4 (`path`) out again as a plain one at `dest`, a new file: replacing a file
 * that was just written fails on Windows while the virus scanner or Explorer still has it open.
 * Returns the length in seconds, or null if `path` isn't a fragmented MP4 (then nothing is written).
 */
export function flattenMp4(path: string, dest: string): number | null {
  const fd = openSync(path, 'r');
  const tmp = dest;
  let out: number | null = null;
  try {
    const top = topLevel(fd);
    const ftypBox = top.find(b => b.type === 'ftyp');
    const moovBox = top.find(b => b.type === 'moov');
    if (!ftypBox || !moovBox || !top.some(b => b.type === 'moof')) return null;
    const ftyp = readAt(fd, ftypBox.start, ftypBox.size);
    const moov = readAt(fd, moovBox.start, moovBox.size);
    const root: Box = { ...moovBox, start: 0 };
    const tracks = readFragments(fd, top, moov, root);

    // The new mdat holds every run's data in the order it had in the file.
    const chunks = [...tracks.values()].flatMap(t => t.chunks.map((c, i) => ({ track: t.id, index: i, ...c }))).sort((a, b) => a.from - b.from);
    const dataSize = chunks.reduce((n, c) => n + c.length, 0);
    const end = fstatSync(fd).size;
    if (chunks.some(c => c.from < 0 || c.from + c.length > end)) throw new Error('a fragment points outside the file');
    const layout = (moovSize: number, wide: boolean) => {
      const mdatHeader = dataSize + 8 > 0xffffffff ? 16 : 8;
      let at = ftyp.length + moovSize + mdatHeader;
      const offsets = new Map<number, number[]>([...tracks.keys()].map(id => [id, []]));
      for (const c of chunks) { offsets.get(c.track)![c.index] = at; at += c.length; }
      return { offsets, mdatHeader, wide };
    };
    // Size the header with placeholder offsets, then build it for real (the size doesn't change).
    const guess = buildMoov(moov, root, tracks, layout(0, false).offsets, false).length;
    const wide = ftyp.length + guess + 16 + dataSize > 0xffffffff;
    const sized = buildMoov(moov, root, tracks, layout(0, wide).offsets, wide).length;
    const { offsets, mdatHeader } = layout(sized, wide);
    const newMoov = buildMoov(moov, root, tracks, offsets, wide);

    const w = openSync(tmp, 'w');
    try {
      writeSync(w, ftyp);
      writeSync(w, newMoov);
      const head = Buffer.alloc(mdatHeader);
      if (mdatHeader === 16) { head.writeUInt32BE(1); head.write('mdat', 4, 'latin1'); head.writeBigUInt64BE(BigInt(dataSize + 16), 8); }
      else { head.writeUInt32BE(dataSize + 8); head.write('mdat', 4, 'latin1'); }
      writeSync(w, head);
      for (const c of chunks) {
        for (let done = 0; done < c.length;) {
          const piece = readAt(fd, c.from + done, Math.min(c.length - done, 4 << 20));
          if (!piece.length) throw new Error('the file ended early');
          writeSync(w, piece);
          done += piece.length;
        }
      }
    } finally {
      closeSync(w);
    }
    const mvhd = child(newMoov, { type: 'moov', start: 0, header: 8, size: newMoov.length }, 'mvhd')!;
    const at = mvhd.start + mvhd.header;
    const v1 = newMoov[at] === 1;
    out = Number(v1 ? newMoov.readBigUInt64BE(at + 24) : newMoov.readUInt32BE(at + 16)) / newMoov.readUInt32BE(at + (v1 ? 20 : 12));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    closeSync(fd);
  }
  return out;
}
