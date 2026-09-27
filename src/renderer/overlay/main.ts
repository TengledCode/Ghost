import type { CoreMessage, GhostState } from '../../shared/protocol';
import { themeColors, type Corner, type Settings } from '../../shared/settings';
import { bridge, inElectron } from '../shared/bridge';
import { CoreClient } from '../shared/coreClient';
import { VoicePlayer } from './audio/player';
import { GhostShell } from './shell/ghostShell';

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
const historyEl = $('#history');
const form = $('#input') as HTMLFormElement;
const input = form.querySelector('input')!;
const confirmEl = $('#confirm');
const noticeEl = $('#notice');

let settings: Settings;
let shell: GhostShell | null = null;
let state: GhostState = 'idle';
let currentTurn = '';
let replyText = '';
let bubbleTimer = 0;
let pendingApproval: string | null = null;
let orientation: Corner = 'bottom-right';
const history: { who: 'user' | 'ghost'; text: string }[] = [];

const boot = await bridge.bootstrap();
settings = boot.settings;
const core = new CoreClient(boot.url, boot.token);
const player = new VoicePlayer(settings.ghostFilter, settings.volume);
player.onFinished = turnId => core.send({ type: 'playback_finished', turnId });
await customElements.whenDefined('voice-orb').catch(() => {});
// The orb taps the processed voice, so the eye pulses with what Aaron actually hears.
voiceOrb.connect?.(player.master).catch(() => {});

applySettings(settings);
bridge.onSettings(s => applySettings(s));
bridge.onOrientation(c => setOrientation(c));
bridge.onSummon(() => openInput());
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
  player.setVolume(s.voiceEnabled ? s.volume : 0);
  input.placeholder = `Speak your mind, ${s.userName}…`;
  if (s.skin === 'ghost-shell' && !shell) {
    try {
      shell = new GhostShell(shellEl, theme);
      shell.audioLevel = () => { const b = voiceOrb.bands; return b ? Math.min(1, b[0] * 0.7 + b[1] * 0.5) : 0; };
      shell.setState(state);
    } catch (e) {
      console.warn('WebGL shell unavailable, using the classic orb', e);
      shellEl.dataset.skin = 'classic-orb';
    }
  } else if (s.skin === 'classic-orb' && shell) {
    shell.dispose();
    shell = null;
  }
  shell?.setTheme(theme);
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
  switch (m.type) {
    case 'state': setState(m.state, m.detail); break;
    case 'text_delta':
      if (m.turnId !== currentTurn) { currentTurn = m.turnId; replyText = ''; }
      replyText += m.text;
      showBubble(replyText);
      break;
    case 'turn_end':
      bubbleMeta.textContent = m.model ? `${m.provider} · ${m.model}` : '';
      history.push({ who: 'ghost', text: m.text });
      renderHistory();
      break;
    case 'audio':
      player.push(m.turnId, m.seq, m.data, m.last);
      break;
    case 'reminder':
      showBubble(m.text);
      history.push({ who: 'ghost', text: m.text });
      renderHistory();
      break;
    case 'approval_request': showConfirm(m.id, m.summary); break;
    case 'approval_resolved': if (pendingApproval === m.id) hideConfirm(); break;
    case 'notice': showNotice(m.text, m.level); break;
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
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(hideNotice, level === 'error' ? 9000 : 4500);
}
function hideNotice(): void { noticeEl.hidden = true; }

// ------------------------------------------------------------------ input

function openInput(): void {
  form.hidden = false;
  refreshInteractivity();
  requestAnimationFrame(() => input.focus());
  void player.ctx.resume();
}

function closeInput(): void {
  form.hidden = true;
  input.value = '';
  core.send({ type: 'typing', active: false });
  shell?.setLean(0);
  bridge.dismissed();
  refreshInteractivity();
}

form.addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  history.push({ who: 'user', text });
  renderHistory();
  core.send({ type: 'user_message', text });
  input.value = '';
  shell?.setLean(0);
  replyText = '';
  showBubble('…');
  bubbleMeta.textContent = '';
});

let typingTimer = 0;
input.addEventListener('input', () => {
  core.send({ type: 'typing', active: input.value.length > 0 });
  shell?.setLean(input.value ? (orientation.endsWith('right') ? -1 : 1) : 0);
  clearTimeout(typingTimer);
  typingTimer = window.setTimeout(() => core.send({ type: 'typing', active: false }), 8000);
});

input.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (state === 'thinking' || state === 'searching' || state === 'speaking') { core.send({ type: 'cancel' }); player.stop(); }
    else closeInput();
  }
});

form.querySelector('.gear')!.addEventListener('click', () => bridge.openSettings());

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
let lastPoint = { x: -1, y: -1 };

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

window.addEventListener('mousemove', e => { lastPoint = { x: e.clientX, y: e.clientY }; refreshInteractivity(); });
setInterval(refreshInteractivity, 200); // completes hover-intent without further mouse movement
window.addEventListener('keydown', e => { if (e.key === 'Alt') { altDown = true; refreshInteractivity(); } });
window.addEventListener('keyup', e => { if (e.key === 'Alt') { altDown = false; refreshInteractivity(); } });
window.addEventListener('blur', () => { altDown = false; });

let dragging = false;
let dragStart: { x: number; y: number; last: { x: number; y: number } } | null = null;

shellEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  shellEl.setPointerCapture(e.pointerId);
  dragStart = { x: e.screenX, y: e.screenY, last: { x: e.screenX, y: e.screenY } };
});
shellEl.addEventListener('pointermove', e => {
  if (!dragStart) return;
  if (!dragging && Math.hypot(e.screenX - dragStart.x, e.screenY - dragStart.y) > 5) dragging = true;
  if (dragging) {
    bridge.dragBy(e.screenX - dragStart.last.x, e.screenY - dragStart.last.y);
    dragStart.last = { x: e.screenX, y: e.screenY };
  }
});
shellEl.addEventListener('pointerup', () => {
  if (dragging) bridge.dragEnd();
  else if (form.hidden) openInput();
  else closeInput();
  dragging = false;
  dragStart = null;
});
shellEl.addEventListener('contextmenu', e => { e.preventDefault(); bridge.openSettings(); });

setState('idle');
