import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { Corner, Settings } from '../shared/settings';
import { log } from './log';
import { QUNS_NAMES } from './fullscreenWatcher';
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
    // Ghost only goes away when the app quits. A stray close (Alt+F4 landing on the overlay, another
    // app closing windows) is ignored instead of leaving Ghost gone with only the tray icon left.
    this.win.on('close', e => { if (!this.allowClose) { e.preventDefault(); log('overlay close blocked'); } });
    // If the page's renderer dies (e.g. the graphics driver resets when a heavy app like Photos
    // closes), bring Ghost straight back.
    this.win.webContents.on('render-process-gone', (_e, d) => { log('overlay renderer gone', d); this.recover(); });
    this.win.webContents.on('unresponsive', () => { log('overlay unresponsive'); this.recover(5000); });
    this.win.setVisibleOnAllWorkspaces(true);
    this.win.setIgnoreMouseEvents(true, { forward: true });
    this.place();
    screen.on('display-metrics-changed', (_e, display, changed) => {
      // e.g. Photos switching the screen into and out of HDR/wide colour for an image
      log('display changed', { id: display.id, changed });
      this.place();
      this.refresh();
    });
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

  /** Set when the app is quitting: only then may the overlay close. */
  allowClose = false;
  private recovering: NodeJS.Timeout | null = null;

  /** Reload the overlay after a crash (debounced); the core keeps all state, so nothing is lost. */
  recover(delayMs = 800): void {
    if (this.win.isDestroyed() || this.recovering) return;
    this.recovering = setTimeout(() => {
      this.recovering = null;
      if (this.win.isDestroyed()) return;
      log('overlay reloaded');
      this.win.webContents.reload();
      if (!this.win.isVisible()) this.win.showInactive();
    }, delayMs);
  }

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

  /**
   * Make the compositor redraw Ghost's transparent window: a repaint plus a tiny opacity nudge, which
   * makes Windows recomposite it. Cheap, and harmless when nothing was wrong.
   */
  refresh(): void {
    if (this.win.isDestroyed()) return;
    this.win.webContents.invalidate();
    if (this.hiddenForFullscreen && !this.summoned) return;
    this.win.setOpacity(0.99);
    setTimeout(() => { if (!this.win.isDestroyed() && !(this.hiddenForFullscreen && !this.summoned)) this.win.setOpacity(1); }, 16);
  }

  private burst: NodeJS.Timeout[] = [];

  /**
   * Redraw every ~2 frames over the next 1.2 s (a closing app's animation), restarting if called
   * again. When Windows drops Ghost's image somewhere in that stretch, the gap is at most ~40 ms.
   */
  refreshBurst(steps = 30): void {
    for (const t of this.burst) clearTimeout(t);
    this.burst = Array.from({ length: steps }, (_, i) => setTimeout(() => this.refresh(), i * 40));
  }

  private lastRefresh = 0;

  /** Another app's window just hid, closed or cloaked: redraw now and for a few frames after (rate-limited). */
  refreshNow(): void {
    const now = Date.now();
    if (now - this.lastRefresh < 30) return;
    this.lastRefresh = now;
    this.refreshBurst(8);
  }

  /**
   * Another app came to the front. Windows can quietly drop a window's always-on-top status when a
   * fullscreen-style app (e.g. Photos) closes, leaving Ghost behind other windows, so re-assert it.
   */
  keepOnTop(): void {
    if (this.win.isDestroyed()) return;
    if (!this.win.isAlwaysOnTop()) log('overlay had lost always-on-top; restored');
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.moveTop();
  }

  /**
   * Every few seconds: is Ghost actually there? Anything wrong (hidden, see-through while not over
   * a fullscreen app, not on top, off every screen) is logged and put right.
   */
  checkHealth(): void {
    if (this.win.isDestroyed()) return;
    const problems: string[] = [];
    if (!this.win.isVisible()) { problems.push('not visible'); this.win.showInactive(); }
    if (!this.hiddenForFullscreen && this.win.getOpacity() < 0.05) { problems.push('transparent while not hidden for fullscreen'); this.win.setOpacity(1); }
    if (!this.win.isAlwaysOnTop()) { problems.push('not on top'); this.win.setAlwaysOnTop(true, 'screen-saver'); }
    const b = this.win.getBounds();
    const s = this.shellRect;
    const shell = { x: b.x + s.x, y: b.y + s.y, width: s.width, height: s.height };
    const onScreen = screen.getAllDisplays().some(d => {
      const w = d.workArea;
      return shell.x < w.x + w.width && shell.x + shell.width > w.x && shell.y < w.y + w.height && shell.y + shell.height > w.y;
    });
    if (!onScreen) { problems.push(`off-screen at ${b.x},${b.y}`); this.place(); }
    if (problems.length) log('overlay health', problems.join('; '));
  }

  setFullscreenHidden(hidden: boolean, code?: number): void {
    if (!hidden && !this.hiddenForFullscreen) return;
    const why = code !== undefined ? ` (Windows reports ${QUNS_NAMES[code] ?? 'state'}, code ${code})` : '';
    log(hidden ? `hidden: a fullscreen app is in front${why}` : `shown again${why}`, this.summoned ? '(summoned, stays visible)' : '');
    this.hiddenForFullscreen = hidden;
    if (this.summoned) return;
    // Opacity rather than hide(), so the renderer keeps playing voice and reminders.
    this.win.setOpacity(hidden ? 0 : 1);
    if (hidden) this.win.setIgnoreMouseEvents(true, { forward: true });
  }
}
