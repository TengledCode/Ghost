import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { join } from 'node:path';
import { GhostCore } from '../core/ghostCore';
import { ClaudeCliProvider } from '../core/providers/claude';
import { GeminiCliProvider } from '../core/providers/gemini';
import { MockProvider } from '../core/providers/mock';
import { EdgeTts } from '../core/tts/edge';
import { ElevenLabsTts } from '../core/tts/elevenlabs';
import { TtsService } from '../core/tts/service';
import type { Settings } from '../shared/settings';
import { ForegroundWatcher, hwndOf } from './foregroundWatcher';
import { FullscreenWatcher } from './fullscreenWatcher';
import { OverlayWindow } from './overlayWindow';
import { SettingsStore } from './settingsStore';
import { captureScreen } from './screenCapture';
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
    // Snapshots land in the CLIs' working folder, where the model's file-reading tool can open them.
    captureScreen: () => captureScreen(join(app.getPath('userData'), 'data', 'workspace', 'screens'), overlay.win),
    onLiveScreen: on => tray?.setToolTip(on ? 'Ghost: watching screen' : 'Ghost'),
  });
  await core.start();

  const overlay = new OverlayWindow(settings, patch => store.update(patch));
  overlay.load();
  overlay.startCursorFeed();

  // ---- IPC used by the overlay and settings renderers
  ipcMain.handle('ghost:bootstrap', () => ({ url: core.url, token: core.token, settings: settings(), hasElevenLabsKey: !!store.getSecret('elevenlabs') }));
  ipcMain.handle('ghost:update-settings', (_e, patch: Partial<Settings>) => store.update(patch));
  ipcMain.handle('ghost:set-secret', (_e, name: string, value: string) => { store.setSecret(name, value); return !!value; });
  ipcMain.on('ghost:interactive', (_e, on: boolean) => overlay.setInteractive(on));
  ipcMain.on('ghost:drag-arm', () => overlay.dragArm());
  ipcMain.on('ghost:drag-start', () => overlay.dragStart());
  ipcMain.on('ghost:drag-end', () => overlay.dragEnd());
  ipcMain.on('ghost:shell-rect', (_e, r: { x: number; y: number; width: number; height: number }) => overlay.setShellRect(r));
  ipcMain.on('ghost:dismissed', () => overlay.dismissed());
  ipcMain.on('ghost:open-settings', () => openSettingsWindow());
  ipcMain.on('ghost:quit', () => app.quit());

  // ---- Hotkey, login item, fullscreen
  const bindHotkeys = (s: Settings) => {
    globalShortcut.unregisterAll();
    const pairs: [string, string, () => void][] = [
      [s.hotkey, 'Summon', () => overlay.summon()],
      [s.quitHotkey, 'Quit', () => app.quit()],
      [s.liveScreenHotkey, 'Live screen', () => core.setLiveScreen(!core.isLiveScreen, true)],
    ];
    for (const [accelerator, label, action] of pairs) {
      if (!accelerator) continue;
      let ok = false;
      try { ok = globalShortcut.register(accelerator, action); } catch { ok = false; }
      if (!ok) core.notify('warn', `${label} hotkey ${accelerator.replace(/\+/g, ' + ')} is taken by another app. Pick another in Settings.`);
    }
  };
  bindHotkeys(settings());
  const applyLogin = (on: boolean) => { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden-start'] }); };
  applyLogin(settings().launchAtLogin);
  const fullscreen = new FullscreenWatcher(isFull => overlay.setFullscreenHidden(isFull));
  if (settings().hideOnFullscreen) fullscreen.start();
  // Clicking into another app sends Ghost to its idle look straight away.
  const foreground = new ForegroundWatcher(
    () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => hwndOf(w.getNativeWindowHandle())),
    () => { if (!overlay.win.isDestroyed()) overlay.win.webContents.send('ghost:elsewhere'); },
  );
  foreground.start();
  app.on('will-quit', () => foreground.stop());

  store.on('change', (next: Settings, prev: Settings) => {
    if (next.hotkey !== prev.hotkey || next.quitHotkey !== prev.quitHotkey || next.liveScreenHotkey !== prev.liveScreenHotkey) bindHotkeys(next);
    if (next.liveScreenAutoOff !== prev.liveScreenAutoOff || next.liveScreenAutoOffMinutes !== prev.liveScreenAutoOffMinutes) core.settingsChanged();
    if (next.launchAtLogin !== prev.launchAtLogin) applyLogin(next.launchAtLogin);
    if (next.hideOnFullscreen !== prev.hideOnFullscreen) { fullscreen.stop(); overlay.setFullscreenHidden(false); if (next.hideOnFullscreen) fullscreen.start(); }
    if (next.size !== prev.size || next.corner !== prev.corner || next.cornerDisplayId !== prev.cornerDisplayId || next.customPosition !== prev.customPosition) overlay.place();
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
  app.on('will-quit', () => { globalShortcut.unregisterAll(); fullscreen.stop(); overlay.stopCursorFeed(); core.stop(); });
});

// A tray app: closing windows doesn't quit.
app.on('window-all-closed', () => { /* keep running in the tray */ });
