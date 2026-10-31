// Detects fullscreen games/apps on Windows via SHQueryUserNotificationState (the same signal that
// Windows uses to hold back notifications). On other platforms it never reports fullscreen.
import type { FullscreenHide } from '../shared/settings';

type Query = () => number; // the raw QUNS code, 0 when unknown

// 2 = QUNS_BUSY (a fullscreen app, which also covers some screen recorders), 3 = QUNS_RUNNING_D3D_FULL_SCREEN
// (a fullscreen game), 4 = QUNS_PRESENTATION_MODE
const HIDE_CODES: Record<Exclude<FullscreenHide, 'never'>, number[]> = { all: [2, 3, 4], games: [3] };

export const QUNS_NAMES: Record<number, string> = {
  1: 'no user present', 2: 'a fullscreen app', 3: 'a fullscreen game', 4: 'presentation mode', 5: 'normal', 6: 'quiet time', 7: 'a Windows Store app',
};

/** The window in front, as far as deciding "is a game covering the screen?" goes. */
export interface Foreground { cls: string; exe: string; coversScreen: boolean }

// Most games now run "borderless": Windows reports them as a fullscreen *app* (2), like a fullscreen
// video, not as a fullscreen game (3). They give themselves away by their engine's window class or by
// where they're installed.
const GAME_CLASSES = /^(UnrealWindow|UnityWndClass|SDL_app|GLFW30|CryENGINE|Valve001|RiotWindowClass|LaunchUnrealUWindowsClient|GameMaker|Godot_Engine|OgreD3D11Wnd)$/i;
const GAME_FOLDERS = /\\(Riot Games|steamapps|Epic Games|GOG Galaxy\\Games|GOG Games|EA Games|Ubisoft Game Launcher\\games|Battle\.net|Blizzard|XboxGames|Rockstar Games)\\/i;

export function looksLikeGame(fg: Pick<Foreground, 'cls' | 'exe'>): boolean {
  return GAME_CLASSES.test(fg.cls) || GAME_FOLDERS.test(fg.exe);
}

export function shouldHide(mode: FullscreenHide, code: number, fg?: Foreground | null): boolean {
  if (mode === 'never') return false;
  if (HIDE_CODES[mode].includes(code)) return true;
  // "Games only": a borderless game covering the whole screen counts too (TFT, League, most Unreal/Unity games).
  return mode === 'games' && code === 2 && !!fg && fg.coversScreen && looksLikeGame(fg);
}

function loadQuery(): Query | null {
  if (process.platform !== 'win32') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    const fn = shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int *pquns)');
    return () => {
      const out = [0];
      return fn(out) === 0 ? out[0] : 0;
    };
  } catch (e) {
    console.warn('[ghost] fullscreen detection unavailable:', e);
    return null;
  }
}

/** The window in front: its class, its program's path, and whether it covers its whole monitor. */
function loadForeground(): (() => Foreground | null) | null {
  if (process.platform !== 'win32') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const RECT = koffi.struct('GhostRect', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    const MONITORINFO = koffi.struct('GhostMonitorInfo', { cbSize: 'uint32_t', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32_t' });
    const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
    const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ GhostRect *rect)');
    const MonitorFromWindow = user32.func('void * __stdcall MonitorFromWindow(void *hwnd, uint32_t flags)');
    const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(void *hmon, _Inout_ GhostMonitorInfo *info)');
    const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint16_t *buf, int max)');
    const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)');
    const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
    const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *proc, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)');
    const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');
    const text = (buf: Uint16Array, n: number) => String.fromCharCode(...buf.subarray(0, n));
    return () => {
      const hwnd = GetForegroundWindow();
      if (!hwnd) return null;
      const win = { left: 0, top: 0, right: 0, bottom: 0 };
      const info = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: { ...win }, rcWork: { ...win }, dwFlags: 0 };
      if (!GetWindowRect(hwnd, win) || !GetMonitorInfoW(MonitorFromWindow(hwnd, 2 /* nearest */), info)) return null;
      const m = info.rcMonitor;
      const coversScreen = win.left <= m.left && win.top <= m.top && win.right >= m.right && win.bottom >= m.bottom;
      const cls = new Uint16Array(256);
      const clsLen = GetClassNameW(hwnd, cls, 256);
      let exe = '';
      const pid = [0];
      GetWindowThreadProcessId(hwnd, pid);
      const proc = pid[0] ? OpenProcess(0x1000 /* query limited information */, false, pid[0]) : null;
      if (proc) {
        const buf = new Uint16Array(1024);
        const size = [1024];
        if (QueryFullProcessImageNameW(proc, 0, buf, size)) exe = text(buf, size[0]);
        CloseHandle(proc);
      }
      return { cls: text(cls, clsLen), exe, coversScreen };
    };
  } catch (e) {
    console.warn('[ghost] foreground window details unavailable:', e);
    return null;
  }
}

export class FullscreenWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last = false;
  private readonly query = loadQuery();
  private readonly foreground = loadForeground();

  /** `onChange` gets whether to hide, the Windows code that decided it, and the game's program when one was spotted (for the log). */
  constructor(private readonly onChange: (hide: boolean, code: number, game?: string) => void) {}

  start(mode: FullscreenHide, intervalMs = 1500): void {
    if (!this.query || this.timer || mode === 'never') return;
    this.timer = setInterval(() => {
      const code = this.query!();
      // Only a fullscreen "app" needs a closer look at what's in front (is it a borderless game?).
      const fg = mode === 'games' && code === 2 ? this.foreground?.() ?? null : null;
      const now = shouldHide(mode, code, fg);
      if (now !== this.last) { this.last = now; this.onChange(now, code, now && fg ? fg.exe.split('\\').pop() : undefined); }
    }, intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.last = false; }
}
