import type { TtsEngine, TtsResult } from './types';
import { TtsError } from './types';

// ElevenLabs free tier: 10k credits a month. Flash v2.5 costs 0.5 credit per character, so that
// is roughly 20k characters (~20 minutes of speech). The key comes from a free account.
export class ElevenLabsTts implements TtsEngine {
  readonly id = 'elevenlabs' as const;
  constructor(private readonly apiKey: () => string, private readonly fetchImpl: typeof fetch = fetch) {}

  async synthesize(text: string, voice: string, signal?: AbortSignal): Promise<TtsResult> {
    const key = this.apiKey();
    if (!key) throw new TtsError('No ElevenLabs key configured', 'auth');
    if (!voice) throw new TtsError('No ElevenLabs voice selected', 'other');
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true },
        }),
        signal,
      });
    } catch (e) {
      throw new TtsError(`ElevenLabs unreachable: ${String(e)}`, 'network');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (/quota_exceeded|insufficient|credits/i.test(body)) throw new TtsError('ElevenLabs monthly quota used up', 'quota');
      if (res.status === 401 || res.status === 403) throw new TtsError('ElevenLabs key rejected', 'auth');
      if (res.status === 429) throw new TtsError('ElevenLabs is rate limiting', 'network');
      throw new TtsError(`ElevenLabs error ${res.status}: ${body.slice(0, 200)}`, 'other');
    }
    return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' };
  }
}
