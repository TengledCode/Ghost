import { contextBridge, ipcRenderer } from 'electron';
import type { Orientation, Settings } from '../shared/settings';
import type { UpdateStatus } from '../main/updater';
import type { KeyCheck } from '../core/tts/elevenlabs';
import type { ModelSuggestion } from '../main/modelWatcher';

/** The ElevenLabs key as Settings shows it: whether one is stored, and whether it works. */
export interface KeyState { has: boolean; saved?: boolean; check?: KeyCheck }

export interface Bootstrap { url: string; token: string; settings: Settings; hasElevenLabsKey: boolean; orientation?: Orientation }

const api = {
  bootstrap: (): Promise<Bootstrap> => ipcRenderer.invoke('ghost:bootstrap'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('ghost:update-settings', patch),
  /** Checks a new key with ElevenLabs and saves it unless it's rejected ('' removes the key). */
  saveElevenLabsKey: (value: string): Promise<KeyState> => ipcRenderer.invoke('ghost:save-eleven-key', value),
  checkElevenLabsKey: (): Promise<KeyState> => ipcRenderer.invoke('ghost:check-eleven-key'),
  /** A new Gemini family on offer for Balanced and Heavy (null when there's none). */
  modelSuggestion: (): Promise<ModelSuggestion | null> => ipcRenderer.invoke('ghost:model-suggestion'),
  answerModelSuggestion: (use: boolean) => ipcRenderer.send('ghost:model-suggestion-answer', use),
  onModelSuggestion: (cb: (s: ModelSuggestion | null) => void): void => { ipcRenderer.on('ghost:model-suggestion', (_e, s) => cb(s)); },
  setInteractive: (on: boolean) => ipcRenderer.send('ghost:interactive', on),
  dragArm: () => ipcRenderer.send('ghost:drag-arm'),
  dragStart: () => ipcRenderer.send('ghost:drag-start'),
  dragEnd: () => ipcRenderer.send('ghost:drag-end'),
  /** Where the shell's hit area sits inside the window, so the main process can snap the shell itself. */
  shellRect: (r: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('ghost:shell-rect', r),
  dismissed: () => ipcRenderer.send('ghost:dismissed'),
  openSettings: () => ipcRenderer.send('ghost:open-settings'),
  quit: () => ipcRenderer.send('ghost:quit'),
  pickFolder: (title: string): Promise<string | null> => ipcRenderer.invoke('ghost:pick-folder', title),
  openObsidian: (url: string) => ipcRenderer.send('ghost:open-obsidian', url),
  openCaptureFolder: (kind: 'screenshots' | 'recordings') => ipcRenderer.send('ghost:open-capture-folder', kind),
  /** A screenshot's or recording's preview as a data URL (null if there's none). */
  capturePreview: (path: string): Promise<string | null> => ipcRenderer.invoke('ghost:capture-preview', path),
  /** Open a screenshot or recording, or show it in its folder. */
  openCapture: (path: string, how: 'open' | 'folder') => ipcRenderer.send('ghost:capture-open', path, how),
  updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke('ghost:update-status'),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke('ghost:update-check'),
  runUpdate: () => ipcRenderer.send('ghost:update-run'),
  log: (event: string, detail?: unknown) => ipcRenderer.send('ghost:log', event, detail),
  onUpdate: (cb: (s: UpdateStatus) => void): void => { ipcRenderer.on('ghost:update', (_e, s) => cb(s)); },
  onSettings: (cb: (s: Settings) => void): void => { ipcRenderer.on('ghost:settings', (_e, s) => cb(s)); },
  onSummon: (cb: () => void): void => { ipcRenderer.on('ghost:summon', () => cb()); },
  onOrientation: (cb: (c: Orientation) => void): void => { ipcRenderer.on('ghost:orientation', (_e, c) => cb(c)); },
  /** Cursor position relative to the overlay window, anywhere on screen. */
  onCursor: (cb: (x: number, y: number) => void): void => { ipcRenderer.on('ghost:cursor', (_e, x, y) => cb(x, y)); },
  /** Another app came to the front (Aaron clicked away from Ghost). */
  onElsewhere: (cb: () => void): void => { ipcRenderer.on('ghost:elsewhere', () => cb()); },
  onClickedThrough: (cb: () => void): void => { ipcRenderer.on('ghost:clicked-through', () => cb()); },
  onAlt: (cb: (down: boolean) => void): void => { ipcRenderer.on('ghost:alt', (_e, down: boolean) => cb(down)); },
};

export type GhostApi = typeof api;
contextBridge.exposeInMainWorld('ghost', api);
