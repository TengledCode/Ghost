import type { Provider, ProviderEvent, SendRequest } from './types';

// Offline stand-in for UI development and tests (GHOST_PROVIDER=mock). Uses no subscription.
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>(resolve => { const t = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });

export class MockProvider implements Provider {
  readonly id = 'mock' as const;
  async isAvailable(): Promise<boolean> { return true; }

  async *send(req: SendRequest): AsyncIterable<ProviderEvent> {
    const ask = req.prompt.split('</context>').pop()!.trim();
    yield { type: 'session', sessionId: 'mock-session' };
    await sleep(500, req.signal);
    if (/search|look up|weather|news/i.test(ask)) {
      yield { type: 'tool_start', name: 'WebSearch' };
      await sleep(1200, req.signal);
      yield { type: 'tool_end', name: 'WebSearch' };
    }
    const reply = `Understood, Aaron. You said: "${ask.slice(0, 80)}". This is the offline mock, so no subscription usage was spent. Everything else is in working order.`;
    for (const word of reply.split(/(?<= )/)) {
      if (req.signal.aborted) return;
      yield { type: 'text_delta', text: word };
      await sleep(35, req.signal);
    }
    yield { type: 'done', text: reply, sessionId: 'mock-session' };
  }
}
