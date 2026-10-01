import { clipboard, desktopCapturer, screen, type NativeImage } from 'electron';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stamp } from './recorder';

export interface Capture { path: string; width: number; height: number; takenAt: string }

const MAX_EDGE = 1568; // long edge sent to the model: readable text at a modest image cost
const KEEP = 5; // snapshots kept on disk

/** Keeps Ghost's own window out of a capture while `on` (Windows 10 2004+: WDA_EXCLUDEFROMCAPTURE). */
export type HideGhost = (on: boolean) => void;

/** The monitor under the cursor at native resolution, with Ghost left out of the picture. */
async function grabScreen(hideGhost: HideGhost): Promise<NativeImage> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const thumb = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
  // Only for this moment, so Ghost still appears in Aaron's own screenshots and screen shares.
  hideGhost(true);
  let sources: Electron.DesktopCapturerSource[];
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumb });
  } finally {
    hideGhost(false);
  }
  const source = sources.find(s => s.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) throw new Error('no screen image available');
  return source.thumbnail;
}

/**
 * Snapshot for the model (live screen view, "what's on my screen?"), saved in Ghost's workspace and
 * scaled down to a size it reads well. Only the last few are kept.
 */
export async function captureScreen(dir: string, hideGhost: HideGhost): Promise<Capture> {
  let img = await grabScreen(hideGhost);
  const { width, height } = img.getSize();
  if (Math.max(width, height) > MAX_EDGE) {
    img = width >= height ? img.resize({ width: MAX_EDGE, quality: 'good' }) : img.resize({ height: MAX_EDGE, quality: 'good' });
  }
  mkdirSync(dir, { recursive: true });
  const takenAt = new Date().toISOString();
  const path = join(dir, `screen-${takenAt.replace(/[:.]/g, '-')}.png`);
  writeFileSync(path, img.toPNG());
  const old = readdirSync(dir).filter(f => /^screen-.*\.png$/.test(f)).sort().slice(0, -KEEP);
  for (const f of old) rmSync(join(dir, f), { force: true });
  const size = img.getSize();
  return { path, width: size.width, height: size.height, takenAt };
}

/** A screenshot for Aaron: full resolution, saved in his Pictures\Ghost folder and copied to the clipboard. */
export async function saveScreenshot(dir: string, hideGhost: HideGhost): Promise<Capture> {
  const img = await grabScreen(hideGhost);
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const path = join(dir, `Screenshot ${stamp(now)}.png`);
  writeFileSync(path, img.toPNG());
  clipboard.writeImage(img);
  const size = img.getSize();
  return { path, width: size.width, height: size.height, takenAt: now.toISOString() };
}
