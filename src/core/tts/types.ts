export interface TtsResult { audio: Buffer; mime: string }

export interface TtsEngine {
  readonly id: 'elevenlabs' | 'edge';
  synthesize(text: string, voice: string, signal?: AbortSignal): Promise<TtsResult>;
}

export class TtsError extends Error {
  constructor(message: string, readonly kind: 'quota' | 'auth' | 'network' | 'other') { super(message); }
}
