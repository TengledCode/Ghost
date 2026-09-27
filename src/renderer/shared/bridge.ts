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
  setSecret: async (_n, v) => !!v,
  setInteractive: () => {},
  dragBy: () => {},
  dragEnd: () => {},
  dismissed: () => {},
  openSettings: () => window.open('../settings/index.html' + location.search, '_blank'),
  onSettings: () => {},
  onSummon: () => {},
  onOrientation: () => {},
};

export const bridge: GhostApi = window.ghost ?? browserApi;
export const inElectron = !!window.ghost;
