// Recognises "take a screenshot", "record my screen", "stop recording" and "show my last screenshot"
// said plainly, so they happen at once without a model call (like switching live screen view).

export type CaptureCommand = 'screenshot' | 'record' | 'stop' | 'last-screenshot' | 'last-recording' | null;

const LEAD = String.raw`^(?:(?:please|ghost|hey ghost|ok|okay|can you|could you)[,\s]+)*`;
const TAIL = String.raw`(?:[,\s]+(?:please|now|for me))*[.!?]*$`;
// "my screen", "the current screen", "this whole screen"
const SCREEN = String.raw`(?:my |the |this )?(?:current |whole |entire |full )?screen`;
const SCREENSHOT = new RegExp(String.raw`${LEAD}(?:(?:take|grab|capture|snap|get)(?: me)? (?:a |another |an? )?screen ?shot(?: of ${SCREEN})?|screen ?shot(?: ${SCREEN})?)${TAIL}`, 'i');
const RECORD = new RegExp(String.raw`${LEAD}(?:(?:start |begin )?(?:screen ?)?record(?:ing)?(?: ${SCREEN})?|(?:start|begin) (?:a )?(?:screen )?recording(?: of ${SCREEN})?|screen ?record)${TAIL}`, 'i');
const STOP = new RegExp(String.raw`${LEAD}(?:stop|end|finish|save) (?:the |my )?(?:screen ?)?recording${TAIL}`, 'i');
// "show me my last screenshot", "whats my previous recording?", "the screenshot I just took"
const KIND = String.raw`(screen ?shot|(?:screen )?recording)`;
const LAST = new RegExp(String.raw`${LEAD}(?:(?:show|open|find|get|bring up|pull up)(?: me)? |where(?:'s| is| did you save) |what(?:'s|s| is) )?(?:my |the )?(?:(?:last|previous|latest|most recent|newest) ${KIND}(?: (?:i|you) took)?|${KIND} (?:i|you) (?:just )?took)(?: again)?${TAIL}`, 'i');

export function parseCaptureCommand(text: string): CaptureCommand {
  const t = text.trim();
  const last = t.match(LAST);
  if (last) return /shot/i.test(last[1] ?? last[2]) ? 'last-screenshot' : 'last-recording';
  if (STOP.test(t)) return 'stop';
  if (SCREENSHOT.test(t)) return 'screenshot';
  if (RECORD.test(t)) return 'record';
  return null;
}

/** "Pictures\Ghost" for a file in C:\Users\Aaron\Pictures\Ghost: the folder as Aaron knows it. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).slice(-3, -1).join('\\');
}

/** "3 Nov, 9:42 pm" */
export function when(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours() % 12 || 12;
  const month = d.toLocaleString('en-GB', { month: 'short' });
  return `${d.getDate()} ${month}, ${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`;
}

/** "2 min 14 s", "48 s" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}
