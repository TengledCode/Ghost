import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { Corner, Settings } from '../shared/settings';
import { cornerPosition, nearestCorner, orientationFor, windowSize } from './placement';

export class OverlayWindow {
  readonly win: BrowserWindow;
  private hiddenForFullscreen = false;
  private summoned = false;

  constructor(private settings: () => Settings, private save: (p: Partial<Settings>) => void) {
    const size = windowSize(settings().size);
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

  load(): void {
    if (process.env.ELECTRON_RENDERER_URL) void this.win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`);
    else void this.win.loadFile(join(__dirname, '../renderer/overlay/index.html'));
    this.win.once('ready-to-show', () => this.win.showInactive());
  }

  /** Position from settings: a snapped corner, or a remembered free position if its display still exists. */
  place(): void {
    const s = this.settings();
    const size = windowSize(s.size);
    this.win.setSize(size.width, size.height);
    const custom = s.customPosition;
    const display = custom ? screen.getAllDisplays().find(d => d.id === custom.displayId) : undefined;
    if (custom && display) {
      const x = Math.min(Math.max(custom.x, display.workArea.x), display.workArea.x + display.workArea.width - size.width);
      const y = Math.min(Math.max(custom.y, display.workArea.y), display.workArea.y + display.workArea.height - size.height);
      this.win.setPosition(Math.round(x), Math.round(y));
      this.sendOrientation(orientationFor(x, y, display.workArea, size));
    } else {
      const work = screen.getPrimaryDisplay().workArea;
      const p = cornerPosition(s.corner, work, size);
      this.win.setPosition(p.x, p.y);
      this.sendOrientation(s.corner);
    }
  }

  private sendOrientation(corner: Corner): void {
    const send = () => this.win.webContents.send('ghost:orientation', corner);
    if (this.win.webContents.isLoading()) this.win.webContents.once('did-finish-load', send); else send();
  }

  dragBy(dx: number, dy: number): void {
    const [x, y] = this.win.getPosition();
    this.win.setPosition(Math.round(x + dx), Math.round(y + dy));
  }

  dragEnd(): void {
    const [x, y] = this.win.getPosition();
    const size = windowSize(this.settings().size);
    const display = screen.getDisplayNearestPoint({ x: x + size.width / 2, y: y + size.height / 2 });
    const { corner, snap } = nearestCorner(x, y, display.workArea, size);
    if (snap && display.id === screen.getPrimaryDisplay().id) this.save({ corner, customPosition: null });
    else this.save({ customPosition: { x, y, displayId: display.id } });
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
