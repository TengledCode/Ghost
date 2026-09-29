export type ProviderEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string }
  | { type: 'done'; text: string; sessionId?: string }
  | { type: 'error'; message: string; kind?: 'auth' | 'limit' | 'missing' | 'other' };

export interface SendRequest {
  prompt: string;
  model: string;
  personaFile: string; // stable system prompt, written to disk by the core
  persona: string;
  sessionId?: string;
  mcpConfigPath: string;
  workspace: string; // cwd for the CLI, so it never picks up an unrelated project's CLAUDE.md
  signal: AbortSignal;
  oneShot?: boolean;
  /** Recent lines of the conversation, for a brain whose own conversation may not hold them (Google). */
  history?: { lines: string[]; inSync: boolean }; // a standalone run outside the ongoing conversation (e.g. summarising an old chat)
}

export interface Provider {
  readonly id: 'claude' | 'gemini' | 'mock';
  isAvailable(): Promise<boolean>;
  send(req: SendRequest): AsyncIterable<ProviderEvent>;
  /** Models this brain offers, for the slot dropdowns in Settings. */
  listModels?(): Promise<ModelOption[]>;
}

export interface ModelOption { id: string; label: string }

/** Classifies CLI error text so Ghost can say something useful ("I've hit the usage limit"). */
export function classifyError(text: string): 'auth' | 'limit' | 'missing' | 'other' {
  if (/ENOENT|not recognized as an internal|command not found|is not recognized/i.test(text)) return 'missing';
  if (/usage limit|rate.?limit|quota|limit reached|resets at|too many requests|429|resource.?exhausted|weekly limit/i.test(text)) return 'limit';
  if (/log ?in|logged out|not logged in|auth|unauthori[sz]ed|401|credential|oauth/i.test(text)) return 'auth';
  return 'other';
}
