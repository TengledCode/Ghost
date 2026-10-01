import type { CoreMessage, GhostState } from '../../shared/protocol';
import { themeColors, type Corner, type Settings } from '../../shared/settings';
import { bridge, inElectron } from '../shared/bridge';
import { CoreClient } from '../shared/coreClient';
import { VoicePlayer } from './audio/player';
import { GhostFilter } from './audio/ghostFilter';
import { GhostShell } from './shell/ghostShell';
import { moodFromMessage } from './shell/motion';
import { isIdle } from './idle';
import { Subtitles } from './subtitles';
import { attentionPoint, GLANCE_MS, relativeTo, type Box } from './attention';

type VoiceOrbEl = HTMLElement & { state: string; connect(n: AudioNode): Promise<void>; bands?: number[] };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const stage = $('#stage');
const shellEl = $('#shell');
const label = $('#shell .label');
const voiceOrb = $('voice-orb') as VoiceOrbEl;
const signalOrb = $('signal-orb');
const bubble = $('#bubble');
const bubbleText = $('#bubble .bubble-text');
const bubbleMeta = $('#bubble .meta-label');
const providerChip = $('#bubble .provider-chip');
const liveTag = $('#shell .live-tag');
const liveLeft = $('#shell .live-left');
let liveOffAt: number | undefined;

/** "LIVE · 24m" while the auto-off timer runs; just "LIVE" without one. */
function renderLiveTag(): void {
  liveLeft.textContent = liveOffAt ? `${Math.max(1, Math.ceil((liveOffAt - Date.now()) / 60_000))}m` : '';
}
setInterval(() => { if (!liveTag.hidden) renderLiveTag(); }, 15_000);
const historyEl = $('#history');
const form = $('#input') as HTMLFormElement;
const input = form.querySelector('input')!;
const confirmEl = $('#confirm');
const noticeEl = $('#notice');

let settings: Settings;
let shell = null as GhostShell | null; // (declared this way so TS does not narrow it to null inside callbacks)
let state: GhostState = 'idle';
let currentTurn = '';
let replyText = '';
let bubbleTimer = 0;
let pendingApproval: string | null = null;
let orientation: Corner = 'bottom-right';
let thankedThisTurn = false;
let materialised = false;
// Reply timings (Settings → Brain → Show reply timings), measured from when Aaron pressed Enter.
let sentAt = 0;
let timing: { text?: number; voice?: number; heard?: number } = {};
let modelLabel = '';
const standalone = (turnId: string) => /^(say|reminder|preview)-/.test(turnId);
function renderMeta(): void {
  const sec = (ms?: number) => (ms === undefined ? '–' : `${(ms / 1000).toFixed(1)}s`);
  const parts = [modelLabel];
  if (settings.showTimings && timing.text !== undefined) {
    parts.push(settings.voiceEnabled
      ? `text ${sec(timing.text)} · voice ${sec(timing.voice)} · heard ${sec(timing.heard)}`
      : `text ${sec(timing.text)} · voice off`);
  }
  else if (!settings.voiceEnabled && modelLabel) parts.push('voice off'); // so a silent reply is never a mystery
  bubbleMeta.textContent = parts.filter(Boolean).join(' · ');
}
const history: { who: 'user' | 'ghost'; text: string }[] = [];

const boot = await bridge.bootstrap();
settings = boot.settings;
// Face the right way from the first frame: the chat stack grows towards the middle of the screen.
bridge.onOrientation(c => setOrientation(c));
if (boot.orientation) setOrientation(boot.orientation);
const core = new CoreClient(boot.url, boot.token);
const player = new VoicePlayer(settings.ghostFilter, settings.volume, settings.voiceCharacter);
// While voice is on, the bubble shows the reply in step with the voice (see subtitles.ts).
const subtitles = new Subtitles(text => showBubble(text));
player.onChunkStart = (turnId, seq, at, duration) => {
  subtitles.started(turnId, seq, at, duration);
  if (sentAt && !standalone(turnId) && timing.heard === undefined) { timing.heard = at * 1000 - sentAt; renderMeta(); }
};
player.onFinished = turnId => { subtitles.revealAll(turnId); core.send({ type: 'playback_finished', turnId }); };
(function tickSubtitles() { requestAnimationFrame(tickSubtitles); subtitles.tick(); })();
if (!inElectron) (window as unknown as { ghostDebug: object }).ghostDebug = { player, subtitles, GhostFilter, showConfirm: (id: string, text: string) => showConfirm(id, text), showNotice: (t: string) => showNotice(t) }; // browser preview: inspectable
await customElements.whenDefined('voice-orb').catch(() => {});
// The orb taps the processed voice, so the eye pulses with what Aaron actually hears.
voiceOrb.connect?.(player.master).catch(() => {});

applySettings(settings);
bridge.onSettings(s => applySettings(s));
bridge.onSummon(() => { touch(); openInput(); });
// Follow the cursor anywhere on screen: positions arrive relative to this window.
bridge.onCursor((x, y) => {
  // The global feed also keeps hover detection honest once the cursor has left the window.
  lastPoint = { x, y };
  if (hoveringUi()) touch();
  if (!shell) return;
  const r = shellEl.getBoundingClientRect();
  shell.setCursor(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
});
// The shell's mouth movement follows the voice as it plays.
let lastPoint = { x: -1, y: -1 }; // last cursor position over the window (declared before the cursor feed uses it)

// Ghost watches the text caret while Aaron types: his eye settles on the box and follows the words.
const measure = document.createElement('canvas').getContext('2d')!;
function caretPoint(): { x: number; y: number } {
  const r = input.getBoundingClientRect();
  const cs = getComputedStyle(input);
  measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const before = input.value.slice(0, input.selectionStart ?? input.value.length);
  const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
  const x = r.left + padL + Math.max(0, Math.min(measure.measureText(before).width - input.scrollLeft, r.width - padL - padR));
  return { x, y: r.top + r.height / 2 };
}

// What Ghost looks at, measured from the page every frame (see attention.ts): the Allow button while
// he waits for an answer, the caret while you type, a brief glance at anything that just appeared.
let glance: { el: HTMLElement; until: number } | null = null;
function glanceAt(el: HTMLElement): void { glance = { el, until: performance.now() + GLANCE_MS }; }
const visible = (el: HTMLElement) => !el.hidden && el.getClientRects().length > 0;
const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };
function attend(): void {
  if (!shell) return;
  const allow = confirmEl.querySelector('.allow');
  const typing = document.activeElement === input && !form.hidden;
  const point = attentionPoint({
    approve: pendingApproval && visible(confirmEl) && allow ? boxOf(allow) : null,
    caret: typing ? caretPoint() : null,
    glance: glance && visible(glance.el) ? { box: boxOf(glance.el), until: glance.until } : null,
    now: performance.now(),
  });
  shell.setFocus(point ? relativeTo(point, boxOf(shellEl)) : null);
}

(function feedVoice() {
  requestAnimationFrame(feedVoice);
  shell?.setBands(player.bands());
  attend();
})();
if (!inElectron) setOrientation((new URLSearchParams(location.search).get('orient') as Corner) ?? 'bottom-right');

// ------------------------------------------------------------------ settings & look

function applySettings(s: Settings): void {
  settings = s;
  const theme = themeColors(s);
  const root = document.documentElement.style;
  root.setProperty('--shell', `${s.size}px`);
  root.setProperty('--edge', theme.edge);
  root.setProperty('--panel-border', `color-mix(in srgb, ${theme.edge} 28%, transparent)`);
  root.setProperty('--idle-opacity', String(s.idleOpacity));
  shellEl.dataset.skin = s.skin;
  // Tint the particle eye towards the theme's eye colour (the orbs' idle hue is about 250°).
  const hue = hueOf(theme.eye);
  voiceOrb.style.filter = signalOrb.style.filter = `hue-rotate(${Math.round(hue - 250)}deg)`;
  player.filter.setMix(s.ghostFilter);
  player.filter.setCharacter(s.voiceCharacter);
  player.setVolume(s.voiceEnabled ? s.volume : 0);
  player.setKeepAlive(s.voiceEnabled ? s.audioKeepAlive : 'off');
  input.placeholder = `Speak your mind, ${s.userName}…`;
  if (s.skin === 'ghost-shell' && !shell) {
    try {
      shell = new GhostShell(shellEl, theme, s.renderQuality);
      if (!materialised) { materialised = true; shell.materialise(); } // the startup entrance, once
      // A graphics driver reset (e.g. when a heavy app like Photos closes) loses the 3D context;
      // without this Ghost would stay invisible. Reload and he materialises again.
      // If the page is ever told it's hidden while Ghost should be on screen, that's the bug that
      // made him vanish; log it so it can be seen in data/ghost.log.
      document.addEventListener('visibilitychange', () => bridge.log(`page ${document.visibilityState}`));
      shellEl.querySelector('canvas')?.addEventListener('webglcontextlost', e => {
        e.preventDefault();
        bridge.log('webgl context lost');
        setTimeout(() => location.reload(), 1500);
      }, { once: true });
      shell.setState(state);
      shell.setLiveScreen(!liveTag.hidden); // a skin switch keeps the live tint
      if (!inElectron) (window as unknown as { ghostShell: GhostShell }).ghostShell = shell; // browser preview: inspectable
    } catch (e) {
      console.warn('WebGL shell unavailable, using the classic orb', e);
      shellEl.dataset.skin = 'classic-orb';
    }
  } else if (s.skin === 'classic-orb' && shell) {
    shell.dispose();
    shell = null;
  }
  shell?.setTheme(theme);
  shell?.setQuality(s.renderQuality);
}

function hueOf(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 250;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function setOrientation(c: Corner): void {
  orientation = c;
  stage.dataset.orient = c;
}

// ------------------------------------------------------------------ state

const EYE_STATE: Record<GhostState, string> = {
  idle: 'idle', listening: 'listening', thinking: 'thinking', searching: 'thinking', speaking: 'speaking', done: 'idle', approval: 'idle', error: 'idle',
};

function setState(next: GhostState, detail?: string): void {
  // Speech is coming: wake the audio output now so the first word isn't swallowed.
  if (next === 'thinking' && settings.voiceEnabled) player.wake();
  state = next;
  stage.dataset.state = next;
  voiceOrb.state = EYE_STATE[next];
  signalOrb.setAttribute('state', next === 'done' ? 'done' : 'searching');
  shell?.setState(next);
  label.textContent = detail ?? { thinking: 'Thinking', searching: 'Working', approval: 'Awaiting your word', error: 'Trouble' }[next as string] ?? '';
  if (next === 'idle') scheduleBubbleHide();
  refreshInteractivity();
}

core.onConnection = up => { if (!up) showNotice('Reconnecting to the Ghost core…', 'warn'); else hideNotice(); };

core.on((m: CoreMessage) => {
  // Anything Ghost says or asks brings the UI back from idle.
  if (m.type === 'text_delta' || m.type === 'turn_end' || m.type === 'reminder' || m.type === 'approval_request' || (m.type === 'audio' && !m.last)) touch();
  switch (m.type) {
    case 'state': setState(m.state, m.detail); break;
    case 'text_delta':
      if (m.turnId !== currentTurn) { currentTurn = m.turnId; replyText = ''; }
      replyText += m.text;
      // With voice on, the words appear as they're spoken (subtitles); otherwise straight away.
      if (!settings.voiceEnabled) showBubble(replyText);
      break;
    case 'turn_end':
      modelLabel = m.model ? `${m.provider} · ${m.model}` : '';
      if (standalone(m.turnId)) { timing = {}; sentAt = 0; }
      renderMeta();
      // No voice came for this reply at all (voice unavailable): show the text now.
      if (settings.voiceEnabled && subtitles.activeTurn !== m.turnId) setTimeout(() => { if (subtitles.activeTurn !== m.turnId) showBubble(m.text); }, 600);
      history.push({ who: 'ghost', text: m.text });
      renderHistory();
      if (thankedThisTurn) { shell?.express('happy'); thankedThisTurn = false; }
      break;
    case 'audio':
      if (!m.last && m.display !== undefined) subtitles.add(m.turnId, m.seq, m.display, !!m.data);
      player.push(m.turnId, m.seq, m.data, m.last);
      break;
    case 'reminder': {
      // Spoken reminders appear with their voice; if no voice follows, show the text anyway.
      const turnId = `reminder-${m.id}`;
      if (!settings.voiceEnabled) showBubble(m.text);
      else setTimeout(() => { if (subtitles.activeTurn !== turnId) showBubble(m.text); }, 3000);
      glanceAt(bubble); // a reminder appearing catches his eye
      history.push({ who: 'ghost', text: m.text });
      renderHistory();
      break;
    }
    case 'timing':
      timing = { ...timing, text: m.firstTextMs, voice: m.firstAudioMs };
      renderMeta();
      break;
    case 'approval_request': showConfirm(m.id, m.summary); break;
    case 'approval_resolved': if (pendingApproval === m.id) hideConfirm(); break;
    case 'notice': showNotice(m.text, m.level); break;
    case 'live_screen':
      liveTag.hidden = !m.on;
      liveOffAt = m.on ? m.offAt : undefined;
      renderLiveTag();
      shell?.setLiveScreen(m.on);
      break;
    case 'provider': {
      // Stays visible for as long as Ghost is running on its fallback brain.
      const name = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
      const why = { limit: 'limit reached', auth: 'signed out', missing: 'not installed', other: 'unavailable' };
      providerChip.hidden = !m.reason;
      providerChip.textContent = m.reason ? `on ${name(m.active)} · ${name(m.primary)} ${why[m.reason]}` : '';
      if (m.reason) { bubble.hidden = false; touch(); }
      break;
    }
    default: break;
  }
});

// ------------------------------------------------------------------ bubble, history, notices

function renderMarkdownLite(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```[\w-]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2) { const pre = document.createElement('pre'); pre.textContent = part.replace(/\n$/, ''); frag.append(pre); }
    else frag.append(document.createTextNode(part));
  });
  return frag;
}

function showBubble(text: string): void {
  clearTimeout(bubbleTimer);
  bubble.hidden = false;
  bubbleText.replaceChildren(renderMarkdownLite(text));
  bubbleText.scrollTop = bubbleText.scrollHeight;
  refreshInteractivity();
}

function scheduleBubbleHide(): void {
  clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => {
    if (bubble.matches(':hover') || !historyEl.hidden) return scheduleBubbleHide();
    bubble.hidden = true;
    refreshInteractivity();
  }, 9000);
}

function renderHistory(): void {
  historyEl.replaceChildren(...history.slice(-30).map(h => {
    const p = document.createElement('p');
    p.className = `msg ${h.who}`;
    p.append(renderMarkdownLite(h.text));
    return p;
  }));
  historyEl.scrollTop = historyEl.scrollHeight;
}

$('.history-toggle').addEventListener('click', () => {
  historyEl.hidden = !historyEl.hidden;
  renderHistory();
  refreshInteractivity();
});

let noticeTimer = 0;
function showNotice(text: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  noticeEl.textContent = text;
  noticeEl.className = level;
  noticeEl.hidden = false;
  glanceAt(noticeEl);
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(hideNotice, level === 'error' ? 9000 : 4500);
}
function hideNotice(): void { noticeEl.hidden = true; }

// ------------------------------------------------------------------ input

function openInput(): void {
  touch();
  form.hidden = false;
  refreshInteractivity();
  requestAnimationFrame(() => input.focus());
  void player.ctx.resume();
}

function closeInput(): void {
  form.hidden = true;
  input.value = '';
  core.send({ type: 'typing', active: false });
  bridge.dismissed();
  refreshInteractivity();
}

form.addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  history.push({ who: 'user', text });
  renderHistory();
  // A small reaction while Ghost works on it: a curious tilt for questions, a happy spin after thanks.
  const mood = moodFromMessage(text);
  if (mood === 'curious') shell?.express('curious');
  thankedThisTurn = mood === 'happy';
  core.send({ type: 'user_message', text });
  input.value = '';
  replyText = '';
  showBubble('…');
  sentAt = performance.now();
  timing = {};
  modelLabel = '';
  renderMeta();
});

let typingTimer = 0;
input.addEventListener('input', () => {
  core.send({ type: 'typing', active: input.value.length > 0 });
  clearTimeout(typingTimer);
  typingTimer = window.setTimeout(() => core.send({ type: 'typing', active: false }), 8000);
});

input.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (state === 'thinking' || state === 'searching' || state === 'speaking') { core.send({ type: 'cancel' }); player.stop(); subtitles.revealAll(); }
    else closeInput();
  }
});

form.querySelector('.gear')!.addEventListener('click', () => bridge.openSettings());
// A quiet dot on the gear when an update is ready (details in Settings → Updates).
const gear = form.querySelector('.gear') as HTMLElement;
const showUpdate = (s: { state: string }) => { gear.classList.toggle('has-update', s.state === 'available'); gear.title = s.state === 'available' ? 'Settings · an update is ready' : 'Settings'; };
bridge.onUpdate(showUpdate);
void bridge.updateStatus().then(showUpdate);

// ------------------------------------------------------------------ approvals

function showConfirm(id: string, summary: string): void {
  pendingApproval = id;
  confirmEl.querySelector('.confirm-summary')!.textContent = summary;
  confirmEl.hidden = false;
  bridge.setInteractive(true);
  (confirmEl.querySelector('.allow') as HTMLButtonElement).focus();
}
function hideConfirm(): void { pendingApproval = null; confirmEl.hidden = true; refreshInteractivity(); }
function answer(approved: boolean): void {
  if (!pendingApproval) return;
  core.send({ type: 'approval_response', id: pendingApproval, approved });
  hideConfirm();
}
confirmEl.querySelector('.allow')!.addEventListener('click', () => answer(true));
confirmEl.querySelector('.deny')!.addEventListener('click', () => answer(false));
confirmEl.addEventListener('keydown', e => { if (e.key === 'Escape') answer(false); });

// ------------------------------------------------------------------ click-through, drag, click

// The window ignores the mouse except over UI. With "click-through when idle", the idle shell
// only becomes clickable after a short hover or while Alt is held, so it never steals a stray click.
let interactive = false;
let hoverSince = 0;
let altDown = false;

function wantsMouse(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  if (el.closest('.interactive')) return true;
  if (el.closest('#shell')) {
    if (!settings.clickThroughWhenIdle || state !== 'idle' || altDown || !form.hidden) return true;
    if (!hoverSince) hoverSince = performance.now();
    return performance.now() - hoverSince > 350;
  }
  hoverSince = 0;
  return false;
}

function refreshInteractivity(): void {
  const want = dragging || wantsMouse(lastPoint.x, lastPoint.y);
  if (want !== interactive) { interactive = want; bridge.setInteractive(want); }
}

window.addEventListener('mousemove', e => {
  lastPoint = { x: e.clientX, y: e.clientY };
  refreshInteractivity();
  if (hoveringUi()) touch();
});
setInterval(refreshInteractivity, 200); // completes hover-intent without further mouse movement

// ------------------------------------------------------------------ true idle
// Idle means untouched: not busy, not hovered, and nothing typed, said or shown for a few seconds.
// Only then do Ghost and its panels drop to the "Idle opacity" from Settings. Clicking away
// (the window losing focus) counts as done with it straight away.
const ACTIVE_HOLD_MS = 6000;
const HIDE_INPUT_MS = 30000;
let lastActive = performance.now();

function touch(): void { lastActive = performance.now(); updateIdle(); }

function hoveringUi(): boolean {
  const el = document.elementFromPoint(lastPoint.x, lastPoint.y);
  return !!el?.closest('#shell, #stack .panel');
}

function busy(): boolean {
  return state === 'thinking' || state === 'searching' || state === 'speaking' || state === 'approval' || state === 'listening' || !confirmEl.hidden || dragging;
}

function updateIdle(): void {
  const quiet = performance.now() - lastActive;
  const idle = isIdle({ busy: busy(), hovering: hoveringUi(), quietMs: quiet, holdMs: ACTIVE_HOLD_MS });
  if (idle) stage.dataset.idle = ''; else delete stage.dataset.idle;
  // A long-idle, empty input bar tucks itself away; the hotkey or a click brings it back.
  if (idle && quiet > HIDE_INPUT_MS && !form.hidden && !input.value) closeInput();
}

setInterval(updateIdle, 250);
// Clicking away counts as done with Ghost: the window losing focus, or (even when Ghost never had
// focus) another app coming to the front, reported by the main process.
const clickedAway = () => { lastActive = 0; updateIdle(); };
window.addEventListener('blur', clickedAway);
bridge.onElsewhere(clickedAway);
document.addEventListener('mouseleave', () => { lastPoint = { x: -1, y: -1 }; });
input.addEventListener('focus', touch);
input.addEventListener('keydown', touch);
window.addEventListener('keydown', e => { if (e.key === 'Alt') { altDown = true; refreshInteractivity(); } });
window.addEventListener('keyup', e => { if (e.key === 'Alt') { altDown = false; refreshInteractivity(); } });
window.addEventListener('blur', () => { altDown = false; });

let dragging = false;
let dragStart: { x: number; y: number } | null = null;

// Dragging is driven by the main process from the real cursor position; the page only decides
// whether a press is a click (open the input, boop) or a drag (moved more than a few pixels).
shellEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  shellEl.setPointerCapture(e.pointerId);
  dragStart = { x: e.screenX, y: e.screenY };
  bridge.dragArm();
});
shellEl.addEventListener('pointermove', e => {
  if (!dragStart || dragging) return;
  if (Math.hypot(e.screenX - dragStart.x, e.screenY - dragStart.y) > 5) { dragging = true; bridge.dragStart(); }
});
const release = (click: boolean) => {
  if (dragging) bridge.dragEnd();
  else if (click && dragStart) {
    if (form.hidden) { shell?.boop(); openInput(); }
    else closeInput();
  }
  dragging = false;
  dragStart = null;
};
shellEl.addEventListener('pointerup', () => release(true));
shellEl.addEventListener('pointercancel', () => release(false));

// Tell the main process where the shell sits inside the window, so it snaps the shell itself
// (not the window's transparent padding) to the screen edges.
const reportShellRect = () => {
  const r = shellEl.getBoundingClientRect();
  bridge.shellRect({ x: r.left, y: r.top, width: r.width, height: r.height });
};
new ResizeObserver(() => requestAnimationFrame(reportShellRect)).observe(stage);
new MutationObserver(() => requestAnimationFrame(reportShellRect)).observe(stage, { attributes: true, attributeFilter: ['data-orient'] });
requestAnimationFrame(reportShellRect);
shellEl.addEventListener('contextmenu', e => { e.preventDefault(); bridge.openSettings(); });

setState('idle');
