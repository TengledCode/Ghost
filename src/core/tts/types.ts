export interface TtsResult { audio: Buffer; mime: string }

/** ElevenLabs delivery options (Edge ignores them). */
export interface SynthOptions { model?: string; stability?: number; style?: number }

export interface TtsEngine {
  readonly id: 'elevenlabs' | 'edge';
  synthesize(text: string, voice: string, signal?: AbortSignal, opts?: SynthOptions): Promise<TtsResult>;
}

export class TtsError extends Error {
  constructor(message: string, readonly kind: 'quota' | 'auth' | 'network' | 'other') { super(message); }
}
