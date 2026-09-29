import type { TtsEngine, TtsResult } from './types';
import { TtsError } from './types';

export interface TtsChoice {
  engine: 'elevenlabs' | 'edge'; elevenLabsVoiceId: string; edgeVoice: string;
  elevenLabsModel?: string; stability?: number; style?: number;
}
export interface SpokenAudio extends TtsResult { engine: 'elevenlabs' | 'edge' }

/**
 * ElevenLabs first when chosen and healthy. On quota/auth/network trouble it falls back to Edge and
 * backs off from ElevenLabs for a while, so each sentence doesn't pay for a failing request.
 */
export class TtsService {
  private elevenBlockedUntil = 0;
  onFallback: (reason: string) => void = () => {};

  constructor(private readonly eleven: TtsEngine, private readonly edge: TtsEngine, private readonly now: () => number = Date.now) {}

  async speak(text: string, choice: TtsChoice, signal?: AbortSignal): Promise<SpokenAudio> {
    if (choice.engine === 'elevenlabs' && this.now() >= this.elevenBlockedUntil) {
      try {
        return { ...(await this.eleven.synthesize(text, choice.elevenLabsVoiceId, signal, { model: choice.elevenLabsModel, stability: choice.stability, style: choice.style })), engine: 'elevenlabs' };
      } catch (e) {
        if (signal?.aborted) throw e;
        const err = e instanceof TtsError ? e : new TtsError(String(e), 'other');
        const backoff = { quota: 6 * 3600_000, auth: 3600_000, network: 60_000, other: 60_000 }[err.kind];
        this.elevenBlockedUntil = this.now() + backoff;
        this.onFallback(err.message);
      }
    }
    return { ...(await this.edge.synthesize(text, choice.edgeVoice, signal)), engine: 'edge' };
  }

  resetBackoff(): void { this.elevenBlockedUntil = 0; }
}
