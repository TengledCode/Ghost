// Small mouse and keyboard helpers from user32 on Windows (no-ops elsewhere):
//  - leftButtonDown(): whether the left button is pressed, so Ghost can tell a click that passed
//    through him to the app behind;
//  - altDown(): whether Alt is held, which makes Ghost grabbable. Ghost's window almost never has
//    keyboard focus, so its own key events can't see it;
//  - nudgeMouse(): a zero-pixel mouse move. When the overlay stops letting clicks through, Windows
//    only re-checks which window is under a still cursor when the mouse moves, so without it the
//    next click would still land on the app behind. The cursor doesn't actually move.

interface InputNative { held: (vKey: number) => boolean; pressedOrHeld: (vKey: number) => boolean; nudge: () => void }

const VK_LBUTTON = 0x01;
const VK_MENU = 0x12; // Alt
const MOUSEEVENTF_MOVE = 0x0001;

function load(): InputNative | null {
  if (process.platform !== 'win32') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const getAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)');
    const mouseEvent = user32.func('void __stdcall mouse_event(uint32_t dwFlags, uint32_t dx, uint32_t dy, uint32_t dwData, uintptr_t dwExtraInfo)');
    return {
      held: vKey => (getAsyncKeyState(vKey) & 0x8000) !== 0,
      // Low bit: pressed since the last check, so a quick click between polls counts too.
      pressedOrHeld: vKey => (getAsyncKeyState(vKey) & 0x8001) !== 0,
      nudge: () => mouseEvent(MOUSEEVENTF_MOVE, 0, 0, 0, 0),
    };
  } catch (e) {
    console.warn('[ghost] input helpers unavailable:', e);
    return null;
  }
}

const native = load();

export const leftButtonDown = (): boolean => native?.pressedOrHeld(VK_LBUTTON) ?? false;
export const altDown = (): boolean => native?.held(VK_MENU) ?? false;
export const nudgeMouse = (): void => native?.nudge();
