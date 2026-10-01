// Windows tells Ghost the instant another app's window is hidden, cloaked (the closing animation of
// apps like Photos) or destroyed, or the foreground changes, through SetWinEventHook. When an app
// like Photos closes, Windows drops Ghost's transparent window from the screen at some point in that
// sequence; redrawing at these exact moments brings him back before the gap can be seen.
//
// Out-of-context hooks are delivered through the calling thread's message loop, which Electron's main
// thread runs. If anything here isn't available, start() returns false and Ghost keeps its polling.

const EVENT_SYSTEM_FOREGROUND = 0x0003;
const EVENT_OBJECT_DESTROY = 0x8001;
const EVENT_OBJECT_HIDE = 0x8003;
const EVENT_OBJECT_CLOAKED = 0x8017;
const EVENT_OBJECT_UNCLOAKED = 0x8018;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const WINEVENT_SKIPOWNPROCESS = 0x0002;
const OBJID_WINDOW = 0;

/** Window events worth reacting to: top-level windows of other apps going away or changing. */
export const WATCHED_EVENTS = [EVENT_SYSTEM_FOREGROUND, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE, EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED];

export function eventName(event: number): string {
  return ({ [EVENT_SYSTEM_FOREGROUND]: 'foreground', [EVENT_OBJECT_DESTROY]: 'destroy', [EVENT_OBJECT_HIDE]: 'hide', [EVENT_OBJECT_CLOAKED]: 'cloaked', [EVENT_OBJECT_UNCLOAKED]: 'uncloaked' } as Record<number, string>)[event] ?? String(event);
}

export class WindowEvents {
  private hooks: unknown[] = [];
  private unhook: ((h: unknown) => void) | null = null;
  private callback: unknown = null;
  private koffi: { unregister(cb: unknown): void } | null = null;

  /** `onEvent` gets the event name for top-level windows of other processes. */
  constructor(private readonly onEvent: (name: string) => void) {}

  start(): boolean {
    if (process.platform !== 'win32' || this.hooks.length) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const WinEventProc = koffi.proto('void __stdcall WinEventProc(void *hook, uint32_t event, void *hwnd, int32_t idObject, int32_t idChild, uint32_t thread, uint32_t time)');
      const SetWinEventHook = user32.func('void * __stdcall SetWinEventHook(uint32_t eventMin, uint32_t eventMax, void *hmod, WinEventProc *proc, uint32_t idProcess, uint32_t idThread, uint32_t flags)');
      const UnhookWinEvent = user32.func('bool __stdcall UnhookWinEvent(void *hook)');
      this.callback = koffi.register((_hook: unknown, event: number, hwnd: unknown, idObject: number, idChild: number) => {
        try {
          if (!hwnd || idObject !== OBJID_WINDOW || idChild !== 0) return; // whole windows only, not their parts
          this.onEvent(eventName(event));
        } catch { /* never let an exception cross into Windows */ }
      }, koffi.pointer(WinEventProc));
      for (const ev of WATCHED_EVENTS) {
        const h = SetWinEventHook(ev, ev, null, this.callback, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
        if (h) this.hooks.push(h);
      }
      this.unhook = h => UnhookWinEvent(h);
      this.koffi = koffi;
      if (!this.hooks.length) { this.stop(); return false; }
      return true;
    } catch (e) {
      console.warn('[ghost] window events unavailable:', e);
      this.stop();
      return false;
    }
  }

  stop(): void {
    for (const h of this.hooks) { try { this.unhook?.(h); } catch { /* already gone */ } }
    this.hooks = [];
    if (this.callback && this.koffi) { try { this.koffi.unregister(this.callback); } catch { /* ignore */ } }
    this.callback = null;
  }
}
