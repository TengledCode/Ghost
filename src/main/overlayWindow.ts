import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { Corner, Settings } from '../shared/settings';
import { cornerWindowPosition, orientationForShell, SHELL_PAD, snapShell, windowSize, type Rect } from './placement';

export class OverlayWindow {
  readonly win: BrowserWindow;
  private hiddenForFullscreen = false;
  private summoned = false;
  private cursorTimer: NodeJS.Timeout | null = null;
  private lastCursor = { x: NaN, y: NaN };
  /** The shell's hit area inside the window (CSS px = DIPs), reported by the renderer. */
  private shellRect: Rect;
  private drag: { cursor: Electron.Point; win: { x: number; y: number }; timer: NodeJS.Timeout | null } | null = null;
  /** Which way the chat stack grows. The renderer also asks for it on start, as a message sent while it loads can be missed. */
  orientation: Corner = 'bottom-right';

  constructor(private settings: () => Settings, private save: (p: Partial<Settings>) => void) {
    const size = windowSize(settings().size);
    this.shellRect = this.estimateShellRect();
    this.win = new BrowserWindow({
      ...size,
      transparent: true,
      frame: false,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        backgroundThrottling: false, // keep voice + reminders working while hidden
        autoplayPolicy: 'no-user-gesture-required',
        contextIsolation: true,
        sandbox: false,
      },
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true);
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.place();
    screen.on('display-metrics-changed', () => this.place());
    screen.on('display-removed', () => this.place());
  }

  /**
   * Ghost follows the cursor anywhere on screen, not just over its own window. About 30 times a
   * second the cursor position (relative to this window, in DIPs) goes to the renderer. It is
   * sent only when it moves, and paused while hidden over a fullscreen app.
   */
  startCursorFeed(): void {
    if (this.cursorTimer) return;
    this.cursorTimer = setInterval(() => {
      if (this.win.isDestroyed() || !this.win.isVisible() || (this.hiddenForFullscreen && !this.summoned)) return;
      const p = screen.getCursorScreenPoint();
      if (p.x === this.lastCursor.x && p.y === this.lastCursor.y) return;
      this.lastCursor = p;
      const [wx, wy] = this.win.getPosition();
      this.win.webContents.send('ghost:cursor', p.x - wx, p.y - wy);
    }, 33);
  }

  stopCursorFeed(): void { if (this.cursorTimer) clearInterval(this.cursorTimer); this.cursorTimer = null; }

  load(): void {
    if (process.env.ELECTRON_RENDERER_URL) void this.win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`);
    else void this.win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
    this.win.once('ready-to-show', () => this.win.showInactive());
  }

  /** Until the renderer reports it: the shell sits in the bottom-right of the window, inside its padding. */
  private estimateShellRect(): Rect {
    const { size } = this.settings();
    const win = windowSize(size);
    const inset = 8 + size * SHELL_PAD;
    return { x: win.width - inset - size, y: win.height - inset - size, width: size, height: size };
  }

  private setWindowPos(x: number, y: number): void {
    // setBounds with a fixed size: setPosition on scaled Windows displays slowly changes the
    // window's size, which made Ghost drift and "shoot outward" while dragging.
    const { width, height } = windowSize(this.settings().size);
    this.win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  }

  /** Position from settings: the shell in a corner of its monitor, or a remembered free position. */
  place(): void {
    if (this.drag?.timer) return;
    const s = this.settings();
    const displays = screen.getAllDisplays();
    const custom = s.customPosition;
    const customDisplay = custom ? displays.find(d => d.id === custom.displayId) : undefined;
    if (custom && customDisplay) {
      const work = customDisplay.workArea;
      const p = snapShell({ x: custom.x, y: custom.y }, this.shellRect, work); // also clamps onto the screen
      this.setWindowPos(p.x, p.y);
      this.sendOrientation(orientationForShell({ ...this.shellRect, x: p.x + this.shellRect.x, y: p.y + this.shellRect.y }, work));
    } else {
      const display = displays.find(d => d.id === s.cornerDisplayId) ?? screen.getPrimaryDisplay();
      const p = cornerWindowPosition(s.corner, this.shellRect, display.workArea);
      this.setWindowPos(p.x, p.y);
      this.sendOrientation(s.corner);
    }
  }

  /** The renderer measured the shell (it moves inside the window when the orientation flips). */
  setShellRect(r: Rect): void {
    const old = this.shellRect;
    if (Math.abs(old.x - r.x) + Math.abs(old.y - r.y) + Math.abs(old.width - r.width) < 1) return;
    this.shellRect = r;
    this.place();
  }

  private sendOrientation(corner: Corner): void {
    this.orientation = corner;
    const send = () => this.win.webContents.send('ghost:orientation', corner);
    if (this.win.webContents.isLoading()) this.win.webContents.once('did-finish-load', send); else send();
  }

  // ---- dragging, done here in the main process from the real cursor position (no feedback loop)

  /** Pointer went down on the shell: remember where things started, in case this becomes a drag. */
  dragArm(): void {
    const [x, y] = this.win.getPosition();
    this.drag = { cursor: screen.getCursorScreenPoint(), win: { x, y }, timer: null };
  }

  /** The pointer moved far enough: follow the cursor until release. */
  dragStart(): void {
    if (!this.drag) this.dragArm();
    const d = this.drag!;
    if (d.timer) return;
    d.timer = setInterval(() => {
      const p = screen.getCursorScreenPoint();
      this.setWindowPos(d.win.x + p.x - d.cursor.x, d.win.y + p.y - d.cursor.y);
    }, 16);
  }

  /** Released: snap the shell to nearby edges or a corner of whichever monitor it is on, and remember it. */
  dragEnd(): void {
    const d = this.drag;
    this.drag = null;
    if (!d?.timer) return;
    clearInterval(d.timer);
    const [x, y] = this.win.getPosition();
    const r = this.shellRect;
    const display = screen.getDisplayNearestPoint({ x: Math.round(x + r.x + r.width / 2), y: Math.round(y + r.y + r.height / 2) });
    const snapped = snapShell({ x, y }, r, display.workArea);
    if (snapped.corner) this.save({ corner: snapped.corner, cornerDisplayId: display.id, customPosition: null });
    else this.save({ customPosition: { x: snapped.x, y: snapped.y, displayId: display.id } });
    this.place();
  }

  setInteractive(on: boolean): void {
    if (this.hiddenForFullscreen && !this.summoned) return;
    this.win.setIgnoreMouseEvents(!on, { forward: true });
  }

  /** Hotkey: show, focus and open the input bar (even over a fullscreen game). */
  summon(): void {
    this.summoned = true;
    this.win.setOpacity(1);
    this.win.show();
    this.win.focus();
    this.win.webContents.send('ghost:summon');
  }

  dismissed(): void {
    this.summoned = false;
    if (this.hiddenForFullscreen) this.win.setOpacity(0);
  }

  setFullscreenHidden(hidden: boolean): void {
    this.hiddenForFullscreen = hidden;
    if (this.summoned) return;
    // Opacity rather than hide(), so the renderer keeps playing voice and reminders.
    this.win.setOpacity(hidden ? 0 : 1);
    if (hidden) this.win.setIgnoreMouseEvents(true, { forward: true });
  }
}
