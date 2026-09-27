import type { ClientMessage, CoreMessage } from '../../shared/protocol';
import { parseMessage } from '../../shared/protocol';

type Listener = (m: CoreMessage) => void;

/** WebSocket client for the Ghost core, with automatic reconnect. */
export class CoreClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private queue: ClientMessage[] = [];
  private retry = 500;
  onConnection: (up: boolean) => void = () => {};

  constructor(private readonly url: string, private readonly token: string) { this.open(); }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      ws.send(JSON.stringify({ type: 'hello', token: this.token, role: 'ui' } satisfies ClientMessage));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
      this.onConnection(true);
    };
    ws.onmessage = ev => { const m = parseMessage<CoreMessage>(ev.data); if (m) for (const l of this.listeners) l(m); };
    ws.onclose = () => {
      this.onConnection(false);
      setTimeout(() => this.open(), this.retry);
      this.retry = Math.min(this.retry * 2, 8000);
    };
  }

  on(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }

  send(m: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else this.queue.push(m);
  }
}
