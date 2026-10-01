import { contextBridge, ipcRenderer } from 'electron';

// The hidden recorder page's only link to the app: it hands over video chunks and reports its state.
export interface RecorderStart { sourceId: string; width: number; height: number; systemAudio: boolean }

const api = {
  onStart: (cb: (o: RecorderStart) => void) => { ipcRenderer.on('recorder:start', (_e, o) => cb(o)); },
  onStop: (cb: () => void) => { ipcRenderer.on('recorder:stop', () => cb()); },
  onMic: (cb: (on: boolean) => void) => { ipcRenderer.on('recorder:mic', (_e, on) => cb(on)); },
  started: (mime: string) => ipcRenderer.send('recorder:started', mime),
  chunk: (data: Uint8Array) => ipcRenderer.send('recorder:chunk', data),
  stopped: () => ipcRenderer.send('recorder:stopped'),
  error: (message: string) => ipcRenderer.send('recorder:error', message),
  mic: (on: boolean, error?: string) => ipcRenderer.send('recorder:mic', on, error),
};

export type RecorderApi = typeof api;
contextBridge.exposeInMainWorld('ghostRecorder', api);
