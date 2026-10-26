import type { TtsEngine, TtsResult } from './types';
import { TtsError } from './types';

export interface TtsChoice {
  engine: 'elevenlabs' | 'edge'; elevenLabsVoiceId: string; edgeVoice: string;
  elevenLabsModel?: string; stability?: number; style?: number;
}
export interface SpokenAudio extends TtsResult { engine: 'elevenlabs' | 'edge' }

/** What the chat notice says when ElevenLabs fails and Ghost switches to the Edge voice. */
export function voiceFallbackNotice(kind: TtsError['kind'], reason: string): string {
  switch (kind) {
    case 'quota': return "ElevenLabs free credits are used up for this month, so I'm using the Edge voice until they reset.";
    case 'auth': return "ElevenLabs didn't accept the key, so I'm using the Edge voice. Check the key in Settings.";
    case 'network': return "ElevenLabs can't be reached right now, so I'm using the Edge voice.";
    default: return `ElevenLabs had a problem (${reason}), so I'm using the Edge voice.`;
  }
}

/**
 * ElevenLabs first when chosen and healthy. On quota/auth/network trouble it falls back to Edge and
 * backs off from ElevenLabs for a while, so each sentence doesn't pay for a failing request.
 */
export class TtsService {
  private elevenBlockedUntil = 0;
  onFallback: (reason: string, kind: TtsError['kind']) => void = () => {};

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
        this.onFallback(err.message, err.kind);
      }
    }
    return { ...(await this.edge.synthesize(text, choice.edgeVoice, signal)), engine: 'edge' };
  }

  resetBackoff(): void { this.elevenBlockedUntil = 0; }
}
