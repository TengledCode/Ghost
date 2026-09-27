// Generates resources/icon.png (app/installer) and resources/tray.png: a faceted ring around a glowing eye.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function ghost(size) {
  return png(size, (x, y) => {
    const s = 4, acc = [0, 0, 0, 0];
    for (let sy = 0; sy < s; sy++) for (let sx = 0; sx < s; sx++) {
      const u = ((x + (sx + 0.5) / s) / size) * 2 - 1, v = ((y + (sy + 0.5) / s) / size) * 2 - 1;
      const r = Math.hypot(u, v), a = Math.atan2(v, u);
      const seg = ((a + Math.PI) / (Math.PI / 3)) % 1; // six plates with gaps
      let c = null;
      if (r < 0.42) { const g = 1 - r / 0.42; c = [90 + 165 * g, 200 + 55 * g, 255, 255]; }
      else if (r > 0.56 && r < 0.9 && seg > 0.06 && seg < 0.94) { const l = 0.75 + 0.25 * Math.cos(a - 2.3); c = [205 * l, 214 * l, 226 * l, 255]; }
      else if (r >= 0.9 && r < 0.96 && seg > 0.06 && seg < 0.94) c = [127, 212, 255, 255];
      if (c) for (let i = 0; i < 4; i++) acc[i] += c[i];
    }
    return acc.map(v => Math.round(v / (s * s)));
  });
}

mkdirSync('resources', { recursive: true });
writeFileSync('resources/icon.png', ghost(256));
writeFileSync('resources/tray.png', ghost(32));
console.log('icons written');
