import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpokenAudio, TtsChoice, TtsService } from './service';

/**
 * Short fixed lines (acknowledgements) are synthesised once per voice and kept on disk, so they play
 * instantly and cost ElevenLabs characters only the first time.
 */
export class AckAudioCache {
  private memory = new Map<string, SpokenAudio>();

  constructor(private readonly dir: string, private readonly tts: TtsService) { mkdirSync(dir, { recursive: true }); }

  async get(text: string, choice: TtsChoice): Promise<SpokenAudio> {
    const hit = this.read(text, choice.engine, voiceOf(choice, choice.engine));
    if (hit) return hit;
    const audio = await this.tts.speak(text, choice);
    // Stored under the engine that actually spoke it (ElevenLabs may have fallen back to Edge).
    this.write(text, audio.engine, voiceOf(choice, audio.engine), audio);
    return audio;
  }

  /** Record every line ahead of time, one at a time, skipping ones already cached. */
  async prewarm(lines: string[], choice: TtsChoice): Promise<void> {
    for (const line of lines) {
      if (this.read(line, choice.engine, voiceOf(choice, choice.engine))) continue;
      try { await this.get(line, choice); } catch { return; } // voice unavailable: try again next launch
    }
  }

  private file(text: string, engine: string, voice: string): string {
    const hash = createHash('sha1').update(`${engine}|${voice}|${text}`).digest('hex').slice(0, 16);
    return join(this.dir, `${engine}-${hash}.mp3`);
  }

  private read(text: string, engine: 'elevenlabs' | 'edge', voice: string): SpokenAudio | null {
    const path = this.file(text, engine, voice);
    const cached = this.memory.get(path);
    if (cached) return cached;
    try {
      const audio: SpokenAudio = { audio: readFileSync(path), mime: 'audio/mpeg', engine };
      this.memory.set(path, audio);
      return audio;
    } catch { return null; }
  }

  private write(text: string, engine: 'elevenlabs' | 'edge', voice: string, audio: SpokenAudio): void {
    const path = this.file(text, engine, voice);
    this.memory.set(path, audio);
    try { writeFileSync(path, audio.audio); } catch { /* cache is best effort */ }
  }
}

function voiceOf(choice: TtsChoice, engine: 'elevenlabs' | 'edge'): string {
  return engine === 'elevenlabs' ? choice.elevenLabsVoiceId : choice.edgeVoice;
}
