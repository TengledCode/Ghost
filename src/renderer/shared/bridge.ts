import type { GhostApi } from '../../preload/index';
import type { Bootstrap } from '../../preload/index';
import { DEFAULT_SETTINGS, mergeSettings } from '../../shared/settings';

declare global { interface Window { ghost?: GhostApi } }

// Inside Electron, the preload bridge is present. In a plain browser (UI preview, tests, and
// later a phone client), connection details come from the URL: ?core=ws://…&token=…
const params = new URLSearchParams(location.search);

const browserApi: GhostApi = {
  bootstrap: async (): Promise<Bootstrap> => ({
    url: params.get('core') ?? 'ws://127.0.0.1:47831',
    token: params.get('token') ?? '',
    settings: mergeSettings({ ...DEFAULT_SETTINGS, ...(params.get('settings') ? JSON.parse(params.get('settings')!) : {}) }),
    hasElevenLabsKey: false,
  }),
  updateSettings: async patch => mergeSettings(patch),
  saveElevenLabsKey: async v => (v ? { has: true, saved: true, check: { status: 'ok' } } : { has: false }),
  checkElevenLabsKey: async () => ({ has: false }),
  modelSuggestion: async () => null,
  answerModelSuggestion: () => {},
  onModelSuggestion: () => {},
  setInteractive: () => {},
  dragArm: () => {},
  dragStart: () => {},
  dragEnd: () => {},
  shellRect: r => { (window as unknown as { lastShellRect: unknown }).lastShellRect = r; }, // preview: inspectable
  dismissed: () => {},
  openSettings: () => window.open('../settings/index.html' + location.search, '_blank'),
  quit: () => {},
  pickFolder: async title => window.prompt(`${title} (full path)`) || null,
  openObsidian: url => { location.href = url; },
  openCaptureFolder: () => {},
  // The browser preview has no files: a test card stands in for the picture.
  capturePreview: async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, '#2b5876'); grad.addColorStop(1, '#4e4376');
    g.fillStyle = grad; g.fillRect(0, 0, 640, 360);
    g.fillStyle = '#f4f4f4'; g.fillRect(40, 40, 560, 40); g.fillRect(40, 110, 260, 200); g.fillRect(330, 110, 270, 90);
    g.fillStyle = '#222'; g.font = 'bold 26px Segoe UI, sans-serif'; g.fillText('Test screenshot', 52, 70);
    return c.toDataURL();
  },
  openCapture: (path, how) => console.info('[ghost] open capture', how, path),
  // The browser preview can't update itself.
  updateStatus: async () => ({ state: 'unavailable', version: 'preview', commit: '', changes: [], canInstall: false }),
  checkForUpdates: async () => ({ state: 'unavailable', version: 'preview', commit: '', changes: [], canInstall: false }),
  runUpdate: () => {},
  log: (event, detail) => console.info('[ghost]', event, detail ?? ''),
  onUpdate: () => {},
  onSettings: () => {},
  onSummon: () => {},
  onOrientation: () => {},
  // In a plain browser the page's own mousemove stands in for the global cursor feed.
  onCursor: cb => window.addEventListener('mousemove', e => cb(e.clientX, e.clientY)),
  onElsewhere: () => {},
  onClickedThrough: () => {},
  onAlt: () => {}, // the page's own key events cover Alt in a plain browser
};

export const bridge: GhostApi = window.ghost ?? browserApi;
export const inElectron = !!window.ghost;
