// Notices when Aaron clicks away from Ghost into another app, even if Ghost never had keyboard focus
// (for example it replied while he was working elsewhere). On Windows it watches which window is in
// front; when that changes to something that isn't one of Ghost's own windows, it reports it.
// Elsewhere it does nothing, and the overlay's own blur event covers the focused case.

type Query = () => bigint;

function loadQuery(): Query | null {
  if (process.platform !== 'win32') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const fn = user32.func('void * __stdcall GetForegroundWindow()');
    return () => {
      const hwnd = fn();
      return hwnd ? BigInt(koffi.address(hwnd)) : 0n;
    };
  } catch (e) {
    console.warn('[ghost] foreground detection unavailable:', e);
    return null;
  }
}

/** The HWND inside an Electron window's native handle buffer. */
export function hwndOf(handle: Buffer): bigint {
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

export class ForegroundWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last = 0n;
  private readonly query = loadQuery();

  constructor(private readonly ownWindows: () => bigint[], private readonly onElsewhere: () => void) {}

  start(intervalMs = 250): void {
    if (!this.query || this.timer) return;
    this.last = this.query();
    this.timer = setInterval(() => {
      const now = this.query!();
      if (now === this.last) return;
      this.last = now;
      if (now && !this.ownWindows().includes(now)) this.onElsewhere();
    }, intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
