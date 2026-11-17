import { BrowserWindow, desktopCapturer, ipcMain, screen, session, type IpcMainEvent } from 'electron';
import { createWriteStream, existsSync, mkdirSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log';
import { fixMp4Duration } from './mp4Duration';
import { flattenMp4 } from './mp4Flatten';

// Screen recording: a hidden page records the monitor under the cursor (plus whatever the PC plays,
// on Windows) with the browser's MediaRecorder, and streams it here chunk by chunk into a video file,
// so even a long recording never sits in memory. The microphone can be mixed in or out at any time.

export interface RecordingStatus { on: boolean; startedAt?: number; mic: boolean; micError?: string }

export interface RecorderOptions {
  dir: () => string; // where recordings are saved
  preload: string; // the recorder page's preload script
  load: (win: BrowserWindow) => void; // load the recorder page into the hidden window
  onStatus: (s: RecordingStatus) => void;
  hideGhost: (on: boolean) => void; // keep Ghost's own window out of the picture while recording
  maxMs?: number; // stops by itself after this long
}

const PARTITION = 'ghost-recorder';
const MAX_MS = 60 * 60_000;

export class ScreenRecorder {
  private win: BrowserWindow | null = null;
  private file: WriteStream | null = null;
  private path = ''; // the file being written
  private saveAs = ''; // the finished recording
  private status: RecordingStatus = { on: false, mic: false };
  private starting: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private stopping: ((path: string) => void)[] = [];
  private limit: NodeJS.Timeout | null = null;
  private hiding = false; // Ghost is hidden from captures for this recording (undone exactly once)

  constructor(private readonly o: RecorderOptions) {
    // The hidden page may use the screen and the microphone; nothing else gets this session.
    const ses = session.fromPartition(PARTITION);
    // Since Electron 45, recording a screen asks for 'display-capture' (the microphone is still 'media').
    const allowed = (permission: string) => permission === 'media' || permission === 'display-capture';
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed(permission));
    const fromRecorder = (e: IpcMainEvent) => !!this.win && e.sender === this.win.webContents;
    ipcMain.on('recorder:started', (e, mime: string) => {
      if (!fromRecorder(e)) return;
      mkdirSync(this.o.dir(), { recursive: true });
      const mp4 = mime.startsWith('video/mp4');
      this.saveAs = join(this.o.dir(), `Ghost recording ${stamp(new Date())}.${mp4 ? 'mp4' : 'webm'}`);
      // An MP4 is recorded into a .part file and written out again as a plain MP4 when it stops.
      this.path = mp4 ? `${this.saveAs}.part` : this.saveAs;
      this.file = createWriteStream(this.path);
      this.setStatus({ on: true, startedAt: Date.now(), mic: false });
      log('recording started', { mime, path: this.path });
      this.starting?.resolve();
      this.starting = null;
    });
    ipcMain.on('recorder:chunk', (e, chunk: Uint8Array) => { if (fromRecorder(e)) this.file?.write(Buffer.from(chunk)); });
    ipcMain.on('recorder:stopped', e => { if (fromRecorder(e)) this.finish(); });
    ipcMain.on('recorder:error', (e, message: string) => {
      if (!fromRecorder(e)) return;
      log('recording error', message);
      if (this.starting) { this.starting.reject(new Error(message)); this.starting = null; this.cleanUp(); }
      else this.finish();
    });
    ipcMain.on('recorder:mic', (e, on: boolean, error?: string) => {
      if (fromRecorder(e)) this.setStatus({ ...this.status, mic: on, micError: error });
    });
  }

  get current(): RecordingStatus { return { ...this.status }; }

  /** Start recording the monitor under the cursor. Resolves once frames are being written. */
  async start(): Promise<void> {
    if (this.status.on || this.win) throw new Error('Already recording.');
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find(s => s.display_id === String(display.id)) ?? sources[0];
    if (!source) throw new Error('no screen available to record');
    this.hiding = true;
    this.o.hideGhost(true);
    const win = new BrowserWindow({
      show: false, width: 320, height: 200,
      webPreferences: { preload: this.o.preload, sandbox: true, contextIsolation: true, partition: PARTITION, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    this.win = win;
    win.webContents.on('render-process-gone', () => this.finish());
    const started = new Promise<void>((resolve, reject) => { this.starting = { resolve, reject }; });
    win.webContents.once('did-finish-load', () => win.webContents.send('recorder:start', {
      sourceId: source.id,
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
      systemAudio: process.platform === 'win32', // Windows can record what the PC plays ("loopback")
    }));
    this.o.load(win);
    const timeout = setTimeout(() => { if (!this.starting) return; this.starting.reject(new Error('the recorder did not start')); this.starting = null; this.cleanUp(); }, 15_000);
    try { await started; } finally { clearTimeout(timeout); }
    this.limit = setTimeout(() => { log('recording hit its time limit'); void this.stop(); }, this.o.maxMs ?? MAX_MS);
  }

  /** Stop and save. Resolves with the file's path. */
  stop(): Promise<string> {
    if (!this.win) return Promise.reject(new Error("Ghost isn't recording."));
    const done = new Promise<string>(resolve => this.stopping.push(resolve));
    this.win.webContents.send('recorder:stop');
    // If the page doesn't answer, save what has been written so far.
    setTimeout(() => { if (this.stopping.length) this.finish(); }, 5000);
    return done;
  }

  /** Mix the microphone in or out (works mid-recording). */
  setMic(on: boolean): void { this.win?.webContents.send('recorder:mic', on); }

  private finish(): void {
    const path = this.path;
    const saveAs = this.saveAs;
    const file = this.file;
    const waiting = this.stopping.splice(0);
    const done = async () => {
      // A recording that never got any frames is just an empty file: don't leave it behind.
      try { if (path && statSync(path).size === 0) rmSync(path, { force: true }); } catch { /* none */ }
      const saved = path !== saveAs && existsSync(path) ? await finishMp4(path, saveAs) : path;
      log('recording saved', saved);
      for (const w of waiting) w(saved);
    };
    this.file = null;
    this.cleanUp();
    if (file) file.end(() => void done()); else void done();
  }

  private cleanUp(): void {
    if (this.limit) clearTimeout(this.limit);
    this.limit = null;
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
    if (this.hiding) { this.hiding = false; this.o.hideGhost(false); }
    this.setStatus({ on: false, mic: false });
  }

  private setStatus(s: RecordingStatus): void { this.status = s; this.o.onStatus(this.current); }
}

/**
 * Turns the recorded .part file into the finished recording at `saveAs`: the browser's fragmented MP4
 * written out as a plain one, which every app opens (WhatsApp hangs on fragments). If that fails, the
 * .part file itself becomes the recording, with its total length filled in so Media Player can seek.
 * Returns where the recording ended up.
 */
export async function finishMp4(part: string, saveAs: string): Promise<string> {
  try {
    const length = flattenMp4(part, saveAs);
    if (length !== null) {
      log('recording rewritten as a plain MP4', length);
      // Windows' virus scanner may still be reading the .part file; keep trying for a few seconds.
      await rm(part, { force: true, maxRetries: 20, retryDelay: 250 }).catch(e => log('recording .part file left behind', String(e)));
      return saveAs;
    }
  } catch (e) {
    log('recording not rewritten', String(e));
  }
  if (!(await retry(() => rename(part, saveAs)))) { log('recording kept under its .part name'); return part; }
  try { log('recording length', fixMp4Duration(saveAs)); } catch (e) { log('recording length not fixed', String(e)); }
  return saveAs;
}

async function retry(job: () => Promise<unknown>, tries = 20, gapMs = 250): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try { await job(); return true; } catch (e) {
      if (i === tries - 1) { log('recording rename failed', String(e)); return false; }
      await new Promise(r => setTimeout(r, gapMs));
    }
  }
  return false;
}

/** "2026-10-01 14-03-09", safe in a Windows file name. */
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
