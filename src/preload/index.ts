import { contextBridge, ipcRenderer } from 'electron';
import type { Corner, Settings } from '../shared/settings';

export interface Bootstrap { url: string; token: string; settings: Settings; hasElevenLabsKey: boolean; orientation?: Corner }

const api = {
  bootstrap: (): Promise<Bootstrap> => ipcRenderer.invoke('ghost:bootstrap'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('ghost:update-settings', patch),
  setSecret: (name: string, value: string): Promise<boolean> => ipcRenderer.invoke('ghost:set-secret', name, value),
  setInteractive: (on: boolean) => ipcRenderer.send('ghost:interactive', on),
  dragArm: () => ipcRenderer.send('ghost:drag-arm'),
  dragStart: () => ipcRenderer.send('ghost:drag-start'),
  dragEnd: () => ipcRenderer.send('ghost:drag-end'),
  /** Where the shell's hit area sits inside the window, so the main process can snap the shell itself. */
  shellRect: (r: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('ghost:shell-rect', r),
  dismissed: () => ipcRenderer.send('ghost:dismissed'),
  openSettings: () => ipcRenderer.send('ghost:open-settings'),
  quit: () => ipcRenderer.send('ghost:quit'),
  onSettings: (cb: (s: Settings) => void): void => { ipcRenderer.on('ghost:settings', (_e, s) => cb(s)); },
  onSummon: (cb: () => void): void => { ipcRenderer.on('ghost:summon', () => cb()); },
  onOrientation: (cb: (c: Corner) => void): void => { ipcRenderer.on('ghost:orientation', (_e, c) => cb(c)); },
  /** Cursor position relative to the overlay window, anywhere on screen. */
  onCursor: (cb: (x: number, y: number) => void): void => { ipcRenderer.on('ghost:cursor', (_e, x, y) => cb(x, y)); },
  /** Another app came to the front (Aaron clicked away from Ghost). */
  onElsewhere: (cb: () => void): void => { ipcRenderer.on('ghost:elsewhere', () => cb()); },
};

export type GhostApi = typeof api;
contextBridge.exposeInMainWorld('ghost', api);
