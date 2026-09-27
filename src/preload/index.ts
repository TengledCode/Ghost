import { contextBridge, ipcRenderer } from 'electron';
import type { Corner, Settings } from '../shared/settings';

export interface Bootstrap { url: string; token: string; settings: Settings; hasElevenLabsKey: boolean }

const api = {
  bootstrap: (): Promise<Bootstrap> => ipcRenderer.invoke('ghost:bootstrap'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('ghost:update-settings', patch),
  setSecret: (name: string, value: string): Promise<boolean> => ipcRenderer.invoke('ghost:set-secret', name, value),
  setInteractive: (on: boolean) => ipcRenderer.send('ghost:interactive', on),
  dragBy: (dx: number, dy: number) => ipcRenderer.send('ghost:drag', dx, dy),
  dragEnd: () => ipcRenderer.send('ghost:drag-end'),
  dismissed: () => ipcRenderer.send('ghost:dismissed'),
  openSettings: () => ipcRenderer.send('ghost:open-settings'),
  onSettings: (cb: (s: Settings) => void): void => { ipcRenderer.on('ghost:settings', (_e, s) => cb(s)); },
  onSummon: (cb: () => void): void => { ipcRenderer.on('ghost:summon', () => cb()); },
  onOrientation: (cb: (c: Corner) => void): void => { ipcRenderer.on('ghost:orientation', (_e, c) => cb(c)); },
};

export type GhostApi = typeof api;
contextBridge.exposeInMainWorld('ghost', api);
