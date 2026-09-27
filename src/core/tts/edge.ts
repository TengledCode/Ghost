import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { TtsEngine, TtsResult } from './types';
import { TtsError } from './types';

// Microsoft Edge "Read aloud" neural voices: free, no key, needs internet.
export class EdgeTts implements TtsEngine {
  readonly id = 'edge' as const;

  async synthesize(text: string, voice: string, signal?: AbortSignal): Promise<TtsResult> {
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      // A touch higher and quicker than stock makes the voice sound smaller and more lively, like a Ghost.
      const { audioStream } = tts.toStream(escapeXml(text), { pitch: '+4%', rate: '+3%' });
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const abort = () => { audioStream.destroy(); reject(new TtsError('aborted', 'other')); };
        signal?.addEventListener('abort', abort, { once: true });
        audioStream.on('data', (c: Buffer) => chunks.push(c));
        audioStream.on('end', () => resolve());
        audioStream.on('close', () => resolve());
        audioStream.on('error', reject);
      });
      const audio = Buffer.concat(chunks);
      if (!audio.length) throw new TtsError('Edge TTS returned no audio', 'network');
      return { audio, mime: 'audio/mpeg' };
    } catch (e) {
      throw e instanceof TtsError ? e : new TtsError(`Edge TTS failed: ${String(e)}`, 'network');
    } finally {
      tts.close();
    }
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
