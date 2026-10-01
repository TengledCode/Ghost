import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { GhostCore } from '../core/ghostCore';
import { ClaudeLiveProvider } from '../core/providers/claudeLive';
import { AntigravityProvider } from '../core/providers/antigravity';
import { MockProvider } from '../core/providers/mock';
import { EdgeTts } from '../core/tts/edge';
import { ElevenLabsTts } from '../core/tts/elevenlabs';
import { TtsService } from '../core/tts/service';
import type { Settings } from '../shared/settings';
import { ForegroundWatcher, hwndOf } from './foregroundWatcher';
import { initLog, log } from './log';
import { WindowEvents } from './windowEvents';
import { FullscreenWatcher } from './fullscreenWatcher';
import { OverlayWindow } from './overlayWindow';
import { SettingsStore } from './settingsStore';
import { captureScreen } from './screenCapture';
import { openSettingsWindow } from './settingsWindow';
import { readBuildInfo, Updater, type BuildInfo } from './updater';

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.aaron.ghost');
// Chromium stops drawing windows it believes are covered ("native window occlusion"). For a
// transparent always-on-top overlay that check can get stuck after a covering app (e.g. Photos)
// closes: Ghost's window is still there but draws nothing. Ghost is tiny, so it simply keeps drawing.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const resource = (...p: string[]) => (app.isPackaged ? join(process.resourcesPath, ...p) : join(app.getAppPath(), ...p));

let tray: Tray | null = null;

app.whenReady().then(async () => {
  initLog(join(app.getPath('userData'), 'data', 'ghost.log'));
  log('start', { version: app.getVersion() });
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
      : { claude: new ClaudeLiveProvider(), gemini: new AntigravityProvider({ dir: join(app.getPath('userData'), 'data', 'agy') }) },
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
    greetOnStart: true,
  });
  await core.start();

  const overlay = new OverlayWindow(settings, patch => store.update(patch));
  overlay.load();
  // The GPU process can die when the graphics driver resets (e.g. closing a heavy app like Photos);
  // Electron restarts it, and the overlay reloads so the 3D shell is drawn again.
  app.on('child-process-gone', (_e, d) => { log('child process gone', d); if (d.type === 'GPU') overlay.recover(1200); });
  app.on('before-quit', () => { overlay.allowClose = true; });
  ipcMain.on('ghost:log', (_e, event: string, detail?: unknown) => log(`overlay: ${event}`, detail ?? ''));
  overlay.startCursorFeed();

  // ---- IPC used by the overlay and settings renderers
  ipcMain.handle('ghost:bootstrap', () => ({ url: core.url, token: core.token, settings: settings(), hasElevenLabsKey: !!store.getSecret('elevenlabs'), orientation: overlay.orientation }));
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
  ipcMain.handle('ghost:pick-folder', async (_e, title: string) => {
    const r = await dialog.showOpenDialog({ title, properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  // Only Obsidian links (obsidian://…) from the Settings window.
  ipcMain.on('ghost:open-obsidian', (_e, url: string) => { if (/^obsidian:\/\//.test(url)) void shell.openExternal(url); });

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
  const fullscreen = new FullscreenWatcher((hide, code) => overlay.setFullscreenHidden(hide, code));
  fullscreen.start(settings().fullscreenHide);
  log('fullscreen hiding:', settings().fullscreenHide);
  // Clicking into another app sends Ghost to its idle look straight away.
  const foreground = new ForegroundWatcher(
    () => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => hwndOf(w.getNativeWindowHandle())),
    () => {
      if (overlay.win.isDestroyed()) return;
      overlay.win.webContents.send('ghost:elsewhere');
      overlay.keepOnTop();
      // Make sure it's drawn: closing an app like Photos makes Windows drop Ghost's image at some
      // point during its closing animation, after focus has already moved. Redraw through that whole
      // stretch, so whenever it happens he's back within about a tenth of a second.
      overlay.refreshBurst();
    },
  );
  setInterval(() => overlay.checkHealth(), 5000).unref();
  // Windows tells Ghost the instant another window hides, closes or cloaks (an app like Photos
  // closing), so he redraws at that exact moment instead of after a visible blink.
  const windowEvents = new WindowEvents(name => {
    if (overlay.win.isDestroyed()) return;
    if (name === 'foreground') overlay.refreshBurst();
    else overlay.refreshNow();
  });
  log('window events', windowEvents.start() ? 'on' : 'unavailable: using timed redraws only');
  app.on('will-quit', () => windowEvents.stop());
  foreground.start(60); // quick to notice, so a dropped frame is back before it's seen
  app.on('will-quit', () => foreground.stop());

  store.on('change', (next: Settings, prev: Settings) => {
    if (next.hotkey !== prev.hotkey || next.quitHotkey !== prev.quitHotkey || next.liveScreenHotkey !== prev.liveScreenHotkey) bindHotkeys(next);
    if (next.liveScreenAutoOff !== prev.liveScreenAutoOff || next.liveScreenAutoOffMinutes !== prev.liveScreenAutoOffMinutes) core.settingsChanged();
    if (next.launchAtLogin !== prev.launchAtLogin) applyLogin(next.launchAtLogin);
    if (next.fullscreenHide !== prev.fullscreenHide) {
      fullscreen.stop();
      overlay.setFullscreenHidden(false);
      fullscreen.start(next.fullscreenHide);
      log('fullscreen hiding:', next.fullscreenHide);
    }
    if (next.size !== prev.size || next.corner !== prev.corner || next.cornerDisplayId !== prev.cornerDisplayId || next.customPosition !== prev.customPosition) overlay.place();
    if (next.userName !== prev.userName || next.assistantName !== prev.assistantName) core.writeCliConfig();
    if (JSON.stringify(next.obsidian) !== JSON.stringify(prev.obsidian)) core.obsidianChanged();
    overlay.win.webContents.send('ghost:settings', next);
  });

  // ---- Updates (Settings → Updates): from the folder this copy was built from
  const updater = new Updater({
    info: app.isPackaged ? readBuildInfo(join(__dirname, '..', 'build-info.json')) : sourceInfo(app.getAppPath()),
    version: app.getVersion(),
    installable: app.isPackaged && process.platform === 'win32',
    logFile: join(app.getPath('userData'), 'data', 'update.log'),
    install: installer => {
      // The installer is a windowless app that closes the running Ghost itself before replacing it,
      // installs silently (/S) and starts the new version (--force-run). Started directly, so no
      // console window flashes up.
      spawn(installer, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.quit(), 300);
    },
  });
  updater.on('status', status => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('ghost:update', status); });
  ipcMain.handle('ghost:update-status', () => updater.current);
  ipcMain.handle('ghost:update-check', () => updater.check());
  ipcMain.on('ghost:update-run', () => { void updater.update(); });
  setTimeout(() => void updater.check(), 60_000).unref();
  setInterval(() => void updater.check(), 4 * 3600_000).unref();

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

/** Running from source (npm run dev): the repo itself is the source. */
function sourceInfo(dir: string): BuildInfo | null {
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    return { sourceDir: dir, branch: git('rev-parse', '--abbrev-ref', 'HEAD'), commit: git('rev-parse', 'HEAD') };
  } catch { return null; }
}
