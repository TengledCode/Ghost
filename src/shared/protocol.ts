// Wire protocol between the Ghost core (brain) and any client: the desktop overlay today,
// a phone client later. Keep this free of Electron / Node imports.

export type GhostState =
  | 'idle'
  | 'listening' // Aaron is typing
  | 'thinking'
  | 'searching' // a tool / web lookup is running
  | 'speaking'
  | 'done'
  | 'approval' // waiting for Aaron to confirm a risky action
  | 'error';

export type ClientRole = 'ui' | 'mcp';

export type ClientMessage =
  | { type: 'hello'; token: string; role: ClientRole }
  | { type: 'user_message'; text: string }
  | { type: 'typing'; active: boolean }
  | { type: 'cancel' }
  | { type: 'approval_response'; id: string; approved: boolean }
  | { type: 'playback_finished'; turnId: string }
  | { type: 'voice_preview'; engine: TtsEngineId; voice: string; text?: string }
  | { type: 'new_conversation' }
  | { type: 'clear_history' }
  | { type: 'toggle_live_screen' }
  // Settings asks which models a brain offers (for the Light / Balanced / Heavy dropdowns).
  | { type: 'list_models'; provider: string }
  // Sent by the MCP bridge process on behalf of the model.
  | { type: 'tool_call'; id: string; tool: string; args: Record<string, unknown> };

export type CoreMessage =
  | { type: 'welcome'; name: string; userName: string }
  | { type: 'state'; state: GhostState; detail?: string }
  | { type: 'text_delta'; turnId: string; text: string }
  | { type: 'turn_end'; turnId: string; text: string; provider: string; model: string }
  // `display` is the reply text this audio speaks, revealed in step with it (empty `data` = nothing to say).
  | { type: 'audio'; turnId: string; seq: number; mime: string; data: string; engine: TtsEngineId; last: boolean; display?: string }
  | { type: 'approval_request'; id: string; tool: string; summary: string; args: Record<string, unknown> }
  | { type: 'approval_resolved'; id: string; approved: boolean }
  | { type: 'reminder'; id: string; text: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  // Live screen view: while on, every message carries a snapshot of the monitor under the cursor.
  | { type: 'live_screen'; on: boolean; offAt?: number }
  // Which brain is answering. `reason` is set while Ghost has fallen back from the primary.
  | { type: 'provider'; active: string; primary: string; reason: 'limit' | 'auth' | 'missing' | 'other' | null }
  | { type: 'tool_result'; id: string; ok: boolean; result: string }
  | { type: 'models'; provider: string; models: { id: string; label: string }[]; error?: string }
  // How long a reply took: ms from the message to its first text and to its first synthesised audio.
  | { type: 'timing'; turnId: string; firstTextMs?: number; firstAudioMs?: number };

export type TtsEngineId = 'elevenlabs' | 'edge' | 'none';

export function parseMessage<T>(raw: unknown): T | null {
  try {
    const value = JSON.parse(String(raw));
    return value && typeof value === 'object' && typeof value.type === 'string' ? (value as T) : null;
  } catch {
    return null;
  }
}
