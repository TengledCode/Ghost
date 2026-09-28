import { desktopCapturer, screen, type BrowserWindow } from 'electron';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Capture { path: string; width: number; height: number; takenAt: string }

const MAX_EDGE = 1568; // long edge sent to the model: readable text at a modest image cost
const KEEP = 5; // snapshots kept on disk

/**
 * Snapshot of the monitor under the cursor, saved as a PNG in Ghost's workspace so the model can
 * open it with its file-reading tool. Ghost's own window is excluded from the capture.
 */
export async function captureScreen(dir: string, overlay: BrowserWindow): Promise<Capture> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  // Ask for the display at native pixels (DIP size × scale factor); it's downscaled below if large.
  const thumb = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
  // Leave Ghost out of the picture (Windows 10 2004+: WDA_EXCLUDEFROMCAPTURE). Only for this moment,
  // so Ghost still appears in Aaron's own screenshots and screen shares.
  overlay.setContentProtection(true);
  let sources: Electron.DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumb });
  } finally {
    overlay.setContentProtection(false);
  }
  const source = sources.find(s => s.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('no screen image available');
  let img = source.thumbnail;
  const { width, height } = img.getSize();
  if (Math.max(width, height) > MAX_EDGE) {
    img = width >= height ? img.resize({ width: MAX_EDGE, quality: 'good' }) : img.resize({ height: MAX_EDGE, quality: 'good' });
  }
  mkdirSync(dir, { recursive: true });
  const takenAt = new Date().toISOString();
  const path = join(dir, `screen-${takenAt.replace(/[:.]/g, '-')}.png`);
  writeFileSync(path, img.toPNG());
  // Keep only the last few snapshots.
  const old = readdirSync(dir).filter(f => /^screen-.*\.png$/.test(f)).sort().slice(0, -KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
  const size = img.getSize();
  return { path, width: size.width, height: size.height, takenAt };
}
