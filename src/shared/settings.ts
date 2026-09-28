import type { TtsEngineId } from './protocol';

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type ProviderId = 'claude' | 'gemini' | 'mock';
export type ModelTier = 'auto' | 'fast' | 'balanced' | 'deep';
export type Skin = 'ghost-shell' | 'classic-orb';
export type RenderQuality = 'auto' | 'high' | 'medium' | 'low';

export interface ThemeColors {
  shell: string; // shard base colour
  edge: string; // shard edge / rim light
  eye: string; // eye tint (applied as a hue shift over the particle orb)
}

export const THEMES: Record<string, ThemeColors> = {
  classic: { shell: '#d9dde4', edge: '#7fd4ff', eye: '#7fd4ff' },
  gilded: { shell: '#2a2320', edge: '#e8b85c', eye: '#ffc46b' },
  crimson: { shell: '#1d1c22', edge: '#ff4f5e', eye: '#ff5c6c' },
  void: { shell: '#1b1830', edge: '#b58cff', eye: '#b58cff' },
  frost: { shell: '#eef4f8', edge: '#9fe8ff', eye: '#bff4ff' },
};

export interface Settings {
  userName: string;
  assistantName: string;
  // Placement
  corner: Corner;
  cornerDisplayId: number | null; // which monitor the corner is on (null = primary)
  customPosition: { x: number; y: number; displayId: number } | null;
  size: number; // px, shell diameter
  idleOpacity: number; // 0.2 - 1
  clickThroughWhenIdle: boolean;
  theme: string; // key of THEMES or 'custom'
  customTheme: ThemeColors;
  skin: Skin;
  renderQuality: RenderQuality;
  // Behaviour
  hotkey: string;
  quitHotkey: string;
  launchAtLogin: boolean;
  hideOnFullscreen: boolean;
  // Brain
  provider: ProviderId;
  fallbackProvider: ProviderId | null;
  modelTier: ModelTier;
  // Voice
  voiceEnabled: boolean;
  ttsEngine: Exclude<TtsEngineId, 'none'>;
  elevenLabsVoiceId: string;
  edgeVoice: string;
  ghostFilter: number; // 0 - 1 wet mix of the Ghost FX chain
  volume: number; // 0 - 1
}

export const DEFAULT_SETTINGS: Settings = {
  userName: 'Aaron',
  assistantName: 'Ghost',
  corner: 'bottom-right',
  cornerDisplayId: null,
  customPosition: null,
  size: 180,
  idleOpacity: 0.85,
  clickThroughWhenIdle: true,
  theme: 'classic',
  customTheme: THEMES.classic,
  skin: 'ghost-shell',
  renderQuality: 'auto',
  hotkey: 'Control+Space',
  quitHotkey: 'Control+Alt+Q',
  launchAtLogin: true,
  hideOnFullscreen: true,
  provider: 'claude',
  fallbackProvider: 'gemini',
  modelTier: 'auto',
  voiceEnabled: true,
  ttsEngine: 'elevenlabs',
  elevenLabsVoiceId: 'TX3LPaxmHKxFdv7VOQHJ', // Liam; change in settings after auditioning
  edgeVoice: 'en-US-AndrewMultilingualNeural',
  ghostFilter: 0.35,
  volume: 0.9,
};

export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  merged.size = clamp(merged.size, 90, 420);
  merged.idleOpacity = clamp(merged.idleOpacity, 0.2, 1);
  merged.ghostFilter = clamp(merged.ghostFilter, 0, 1);
  merged.volume = clamp(merged.volume, 0, 1);
  return merged;
}

export function themeColors(s: Pick<Settings, 'theme' | 'customTheme'>): ThemeColors {
  return s.theme === 'custom' ? s.customTheme : THEMES[s.theme] ?? THEMES.classic;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
