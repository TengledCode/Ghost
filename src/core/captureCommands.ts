// Recognises "take a screenshot", "record my screen" and "stop recording" said plainly, so they happen
// at once without a model call (like switching live screen view).

export type CaptureCommand = 'screenshot' | 'record' | 'stop' | null;

const LEAD = String.raw`^(?:(?:please|ghost|hey ghost|ok|okay|can you|could you)[,\s]+)*`;
const TAIL = String.raw`(?:[,\s]+(?:please|now|for me))*[.!?]*$`;
const SCREENSHOT = new RegExp(String.raw`${LEAD}(?:(?:take|grab|capture|snap|get)(?: me)? (?:a |another |an? )?screen ?shot(?: of (?:my |the |this )?screen)?|screen ?shot(?: (?:my |the |this )?screen)?)${TAIL}`, 'i');
const RECORD = new RegExp(String.raw`${LEAD}(?:(?:start |begin )?(?:screen ?)?record(?:ing)?(?: (?:my|the) screen)?|(?:start|begin) (?:a )?(?:screen )?recording|screen ?record)${TAIL}`, 'i');
const STOP = new RegExp(String.raw`${LEAD}(?:stop|end|finish|save) (?:the |my )?(?:screen ?)?recording${TAIL}`, 'i');

export function parseCaptureCommand(text: string): CaptureCommand {
  const t = text.trim();
  if (STOP.test(t)) return 'stop';
  if (SCREENSHOT.test(t)) return 'screenshot';
  if (RECORD.test(t)) return 'record';
  return null;
}

/** "2 min 14 s", "48 s" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}
