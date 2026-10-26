import type { SynthOptions, TtsEngine, TtsResult } from './types';
import { TtsError } from './types';

// ElevenLabs free tier: 10k credits a month. Flash v2.5 costs 0.5 credit per character, so that
// is roughly 20k characters (~20 minutes of speech); the more expressive Multilingual v2 and v3
// cost about twice that. The key comes from a free account.

/** Request body for a model. v3 takes stability only, in three steps (creative / natural / robust). */
export function elevenLabsBody(text: string, opts: SynthOptions = {}): Record<string, unknown> {
  const model = opts.model || 'eleven_flash_v2_5';
  const stability = clamp01(opts.stability ?? 0.45);
  if (model === 'eleven_v3') return { text, model_id: model, voice_settings: { stability: Math.round(stability * 2) / 2 } };
  return {
    text, model_id: model,
    voice_settings: { stability, similarity_boost: 0.75, style: clamp01(opts.style ?? 0.25), use_speaker_boost: true },
  };
}

function clamp01(v: number): number { return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5)); }

/** Whether a key works, checked against the account (no speech made, no credits spent). */
export interface KeyCheck {
  status: 'ok' | 'quota' | 'invalid' | 'offline';
  used?: number; limit?: number; resetsAt?: number; // credits this month; reset time in ms
}

export async function checkElevenLabsKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyCheck> {
  let res: Response;
  try {
    res = await fetchImpl('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { status: 'offline' };
  }
  const body = await res.text().catch(() => '');
  if (res.ok) {
    try {
      const s = JSON.parse(body) as { character_count?: number; character_limit?: number; next_character_count_reset_unix?: number };
      const used = s.character_count, limit = s.character_limit;
      const usage = { used, limit, resetsAt: s.next_character_count_reset_unix ? s.next_character_count_reset_unix * 1000 : undefined };
      return { status: limit && used !== undefined && used >= limit ? 'quota' : 'ok', ...usage };
    } catch {
      return { status: 'ok' };
    }
  }
  if (/quota_exceeded/.test(body)) return { status: 'quota' };
  // A key restricted to speech can't read the account, but it is a real, working key.
  if (/missing_permissions/.test(body)) return { status: 'ok' };
  if (res.status === 401 || res.status === 403) return { status: 'invalid' };
  return { status: 'offline' }; // ElevenLabs is having trouble: can't tell either way
}
export class ElevenLabsTts implements TtsEngine {
  readonly id = 'elevenlabs' as const;
  constructor(private readonly apiKey: () => string, private readonly fetchImpl: typeof fetch = fetch) {}

  async synthesize(text: string, voice: string, signal?: AbortSignal, opts?: SynthOptions): Promise<TtsResult> {
    const key = this.apiKey();
    if (!key) throw new TtsError('No ElevenLabs key configured', 'auth');
    if (!voice) throw new TtsError('No ElevenLabs voice selected', 'other');
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify(elevenLabsBody(text, opts)),
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
