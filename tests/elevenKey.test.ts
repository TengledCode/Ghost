import { describe, expect, it } from 'vitest';
import { checkElevenLabsKey } from '../src/core/tts/elevenlabs';
import { voiceFallbackNotice } from '../src/core/tts/service';

// Answers as ElevenLabs gives them (the invalid-key body is the real one, captured 26 Oct 2026).
const reply = (status: number, body: unknown) => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('checking an ElevenLabs key in Settings', () => {
  it('says a working key works, with this month\'s usage', async () => {
    const c = await checkElevenLabsKey('k', reply(200, { character_count: 4210, character_limit: 10000, next_character_count_reset_unix: 1793000000 }));
    expect(c).toEqual({ status: 'ok', used: 4210, limit: 10000, resetsAt: 1793000000000 });
  });
  it('says when the free credits are used up', async () => {
    expect((await checkElevenLabsKey('k', reply(200, { character_count: 10000, character_limit: 10000 }))).status).toBe('quota');
    expect((await checkElevenLabsKey('k', reply(401, { detail: { status: 'quota_exceeded' } }))).status).toBe('quota');
  });
  it('rejects a wrong key', async () => {
    const body = { detail: { type: 'authentication_error', code: 'unauthorized', message: 'Invalid API key', status: 'invalid_api_key' } };
    expect((await checkElevenLabsKey('k', reply(401, body))).status).toBe('invalid');
  });
  it('accepts a real key that is only allowed to make speech', async () => {
    expect((await checkElevenLabsKey('k', reply(401, { detail: { status: 'missing_permissions', message: 'missing the permission user_read' } }))).status).toBe('ok');
  });
  it("can't tell when ElevenLabs is unreachable or failing", async () => {
    expect((await checkElevenLabsKey('k', (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch)).status).toBe('offline');
    expect((await checkElevenLabsKey('k', reply(503, 'busy'))).status).toBe('offline');
  });
});

describe('the chat notice when the voice switches to Edge', () => {
  it('names the usual reason plainly', () => {
    expect(voiceFallbackNotice('quota', 'x')).toMatch(/free credits are used up/);
    expect(voiceFallbackNotice('auth', 'x')).toMatch(/Check the key in Settings/);
    expect(voiceFallbackNotice('network', 'x')).toMatch(/can't be reached/);
    expect(voiceFallbackNotice('other', 'ElevenLabs error 500')).toMatch(/\(ElevenLabs error 500\)/);
  });
});
