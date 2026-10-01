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

export function shouldHide(mode: FullscreenHide, code: number): boolean {
  return mode !== 'never' && HIDE_CODES[mode].includes(code);
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

export class FullscreenWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last = false;
  private readonly query = loadQuery();

  /** `onChange` gets whether to hide, and the Windows code that decided it (for the log). */
  constructor(private readonly onChange: (hide: boolean, code: number) => void) {}

  start(mode: FullscreenHide, intervalMs = 1500): void {
    if (!this.query || this.timer || mode === 'never') return;
    this.timer = setInterval(() => {
      const code = this.query!();
      const now = shouldHide(mode, code);
      if (now !== this.last) { this.last = now; this.onChange(now, code); }
    }, intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.last = false; }
}
