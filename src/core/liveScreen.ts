// Recognises Aaron switching live screen view on or off in plain words, and one-off requests to
// look at the screen, so these never cost a model call.

export type ScreenCommand = 'on' | 'off' | 'once' | null;

const SCREEN = String.raw`(?:my |the )?(?:screen|monitor|display)`;
const ON = [
  new RegExp(String.raw`^(?:please |ghost,? )*(?:start |begin |keep )?(?:watching|watch|monitor|monitoring|keep an eye on|look at|looking at|view|viewing) ${SCREEN}(?:\s+(?:from now on|continuously|constantly|for (?:a while|now)|live))?[.!]?$`, 'i'),
  new RegExp(String.raw`\b(?:watch|monitor|look at|view|see) ${SCREEN} (?:from now on|continuously|constantly|live)\b`, 'i'),
  /\blive (?:screen|view)(?: mode)? on\b/i,
  /^(?:turn|switch) on live (?:screen|view)\b/i,
];
const OFF = [
  new RegExp(String.raw`^(?:please |ghost,? |ok,? |okay,? )*(?:stop|quit|end|cease) (?:watching|looking|monitoring|viewing)(?: at)?(?: ${SCREEN})?[.!]?$`, 'i'),
  new RegExp(String.raw`\b(?:stop|quit|end) (?:watching|looking at|monitoring|viewing) ${SCREEN}\b`, 'i'),
  new RegExp(String.raw`\b(?:don'?t|do not) (?:watch|look at|monitor) ${SCREEN}\b`, 'i'),
  /\blive (?:screen|view)(?: mode)? off\b/i,
  /^(?:turn|switch) off live (?:screen|view)\b/i,
];
const ONCE = [
  new RegExp(String.raw`\b(?:look at|see|check|read|what'?s on|what is on|what am i looking at on|glance at|have a look at) ${SCREEN}\b`, 'i'),
  new RegExp(String.raw`\bon ${SCREEN}\b.*\?`, 'i'),
  /\bwhat(?:'s| is) this (?:error|window|page)\b/i,
];

export function parseScreenCommand(text: string): ScreenCommand {
  const t = text.trim();
  if (OFF.some(r => r.test(t))) return 'off';
  // A standing instruction ("watch my screen", "... from now on") switches the mode on.
  if (ON.some(r => r.test(t))) return 'on';
  if (ONCE.some(r => r.test(t))) return 'once';
  return null;
}

/** A short command handled entirely by Ghost (vs. a real question that also mentions the screen). */
export function isPureCommand(text: string, cmd: ScreenCommand): boolean {
  return (cmd === 'on' || cmd === 'off') && text.trim().split(/\s+/).length <= 9;
}
