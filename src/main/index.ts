import { app, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { join } from 'node:path';
import { GhostCore } from '../core/ghostCore';
import { ClaudeCliProvider } from '../core/providers/claude';
import { GeminiCliProvider } from '../core/providers/gemini';
import { MockProvider } from '../core/providers/mock';
import { EdgeTts } from '../core/tts/edge';
import { ElevenLabsTts } from '../core/tts/elevenlabs';
import { TtsService } from '../core/tts/service';
import type { Settings } from '../shared/settings';
import { FullscreenWatcher } from './fullscreenWatcher';
import { OverlayWindow } from './overlayWindow';
import { SettingsStore } from './settingsStore';
import { openSettingsWindow } from './settingsWindow';

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.aaron.ghost');

const resource = (...p: string[]) => (app.isPackaged ? join(process.resourcesPath, ...p) : join(app.getAppPath(), ...p));

let tray: Tray | null = null;

app.whenReady().then(async () => {
  const store = new SettingsStore();
  const settings = () => store.get();

  const mock = process.env.GHOST_PROVIDER === 'mock' || settings().provider === 'mock';
  const core = new GhostCore({
    dataDir: join(app.getPath('userData'), 'data'),
    personaPath: resource('config', 'persona.md'),
    mcpServerPath: join(__dirname, 'mcpServer.js'),
    nodeExecPath: process.execPath,
    providers: mock
      ? { mock: new MockProvider(), claude: new MockProvider() as never, gemini: new MockProvider() as never }
      : { claude: new ClaudeCliProvider(), gemini: new GeminiCliProvider() },
    tts: new TtsService(new ElevenLabsTts(() => store.getSecret('elevenlabs')), new EdgeTts()),
    host: {
      openExternal: url => shell.openExternal(url),
      openPath: path => shell.openPath(path),
      trash: path => shell.trashItem(path),
    },
    settings,
  });
  await core.start();

  const overlay = new OverlayWindow(settings, patch => store.update(patch));
  overlay.load();

  // ---- IPC used by the overlay and settings renderers
  ipcMain.handle('ghost:bootstrap', () => ({ url: core.url, token: core.token, settings: settings(), hasElevenLabsKey: !!store.getSecret('elevenlabs') }));
  ipcMain.handle('ghost:update-settings', (_e, patch: Partial<Settings>) => store.update(patch));
  ipcMain.handle('ghost:set-secret', (_e, name: string, value: string) => { store.setSecret(name, value); return !!value; });
  ipcMain.on('ghost:interactive', (_e, on: boolean) => overlay.setInteractive(on));
  ipcMain.on('ghost:drag', (_e, dx: number, dy: number) => overlay.dragBy(dx, dy));
  ipcMain.on('ghost:drag-end', () => overlay.dragEnd());
  ipcMain.on('ghost:dismissed', () => overlay.dismissed());
  ipcMain.on('ghost:open-settings', () => openSettingsWindow());

  // ---- Hotkey, login item, fullscreen
  const bindHotkey = (accelerator: string) => {
    globalShortcut.unregisterAll();
    if (!globalShortcut.register(accelerator, () => overlay.summon())) {
      console.warn(`[ghost] hotkey ${accelerator} is taken by another app`);
    }
  };
  bindHotkey(settings().hotkey);
  const applyLogin = (on: boolean) => { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden-start'] }); };
  applyLogin(settings().launchAtLogin);
  const fullscreen = new FullscreenWatcher(isFull => overlay.setFullscreenHidden(isFull));
  if (settings().hideOnFullscreen) fullscreen.start();

  store.on('change', (next: Settings, prev: Settings) => {
    if (next.hotkey !== prev.hotkey) bindHotkey(next.hotkey);
    if (next.launchAtLogin !== prev.launchAtLogin) applyLogin(next.launchAtLogin);
    if (next.hideOnFullscreen !== prev.hideOnFullscreen) { fullscreen.stop(); overlay.setFullscreenHidden(false); if (next.hideOnFullscreen) fullscreen.start(); }
    if (next.size !== prev.size || next.corner !== prev.corner || next.customPosition !== prev.customPosition) overlay.place();
    if (next.userName !== prev.userName || next.assistantName !== prev.assistantName) core.writeCliConfig();
    overlay.win.webContents.send('ghost:settings', next);
  });

  // ---- Tray
  const icon = nativeImage.createFromPath(resource('resources', 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Ghost');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Talk to Ghost', click: () => overlay.summon() },
    { label: 'New conversation', click: () => core.newConversation() },
    { label: 'Settings…', click: () => openSettingsWindow() },
    { type: 'separator' },
    { label: 'Quit Ghost', click: () => app.quit() },
  ]));
  tray.on('click', () => overlay.summon());

  app.on('second-instance', () => overlay.summon());
  app.on('will-quit', () => { globalShortcut.unregisterAll(); fullscreen.stop(); core.stop(); });
});

// A tray app: closing windows doesn't quit.
app.on('window-all-closed', () => { /* keep running in the tray */ });
