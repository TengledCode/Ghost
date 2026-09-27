import { BrowserWindow } from 'electron';
import { join } from 'node:path';

let win: BrowserWindow | null = null;

export function openSettingsWindow(): void {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 760,
    height: 820,
    title: 'Ghost settings',
    backgroundColor: '#0d0f14',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false },
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/settings/index.html`);
  else void win.loadFile(join(__dirname, '../renderer/settings/index.html'));
  win.on('closed', () => { win = null; });
}
