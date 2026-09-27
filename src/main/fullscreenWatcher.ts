// Detects fullscreen games/apps on Windows via SHQueryUserNotificationState (the same signal that
// Windows uses to hold back notifications). On other platforms it never reports fullscreen.
type Query = () => boolean;

function loadQuery(): Query | null {
  if (process.platform !== 'win32') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    const fn = shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int *pquns)');
    return () => {
      const out = [0];
      if (fn(out) !== 0) return false;
      // 2 = QUNS_BUSY (fullscreen app), 3 = QUNS_RUNNING_D3D_FULL_SCREEN, 4 = QUNS_PRESENTATION_MODE
      return out[0] === 2 || out[0] === 3 || out[0] === 4;
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

  constructor(private readonly onChange: (fullscreen: boolean) => void) {}

  start(intervalMs = 1500): void {
    if (!this.query || this.timer) return;
    this.timer = setInterval(() => {
      const now = this.query!();
      if (now !== this.last) { this.last = now; this.onChange(now); }
    }, intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.last = false; }
}
