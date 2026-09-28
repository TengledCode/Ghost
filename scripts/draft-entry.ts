// Ghost Shell Lab: the production GhostShell running standalone, with controls for design review.
import { BandMeter } from '../src/renderer/overlay/audio/bands';
import { GhostShell, type RenderQuality } from '../src/renderer/overlay/shell/ghostShell';
import type { GhostState } from '../src/shared/protocol';
import { THEMES } from '../src/shared/settings';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const stage = $('#stage');
const host = $('#ghost');
let themeName = 'classic';
const shell = new GhostShell(host, THEMES[themeName]);

// ---- states
const DESCRIPTIONS: Record<GhostState, string> = {
  idle: 'Shards float on their magnetic field. Glances, blinks and follows your cursor. Click it: the field repels the shards.',
  listening: 'You are typing. Turns to the input bar, plates ease open, iris widens.',
  thinking: 'Plates unlock with a twist and the two sets counter-rotate. Amber core.',
  searching: 'Fully unfolded, rear set orbits, body sweeps; the core becomes scan rings.',
  speaking: 'Shards pulse in a wave on each word and inflection. Press Play voice sample.',
  done: 'Snaps shut with a flash and a small nod.',
  approval: 'Half open, seams go amber, looks up at the confirm card.',
  error: 'Red flicker and a quick shake.',
};
let state: GhostState = 'idle';
const setState = (s: GhostState) => {
  state = s;
  shell.setState(s);
  document.querySelectorAll<HTMLButtonElement>('[data-state]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.state === s)));
  $('#stateName').textContent = s;
  $('#stateNote').textContent = DESCRIPTIONS[s];
  if (s === 'done') setTimeout(() => state === 'done' && setState('idle'), 1400);
};
document.querySelectorAll<HTMLButtonElement>('[data-state]').forEach(b => b.addEventListener('click', () => setState(b.dataset.state as GhostState)));

// ---- themes
const swatches = $('#themes');
for (const [name, t] of Object.entries(THEMES)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch';
  b.title = name;
  b.setAttribute('aria-label', `${name} theme`);
  b.style.setProperty('--c', t.edge);
  b.setAttribute('aria-pressed', String(name === themeName));
  b.onclick = () => {
    themeName = name;
    shell.setTheme(t);
    document.documentElement.style.setProperty('--glow', t.edge);
    swatches.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  };
  swatches.append(b);
}

// ---- backdrop
document.querySelectorAll<HTMLButtonElement>('[data-bg]').forEach(b => b.addEventListener('click', () => {
  stage.dataset.bg = b.dataset.bg!;
  document.querySelectorAll('[data-bg]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
}));

// ---- quality
const qualitySel = $('#quality') as HTMLSelectElement;
qualitySel.onchange = () => shell.setQuality(qualitySel.value as RenderQuality);

// ---- cursor follow (anywhere on the page) and drag-to-orbit
let follow = true;
const followBox = $('#follow') as HTMLInputElement;
followBox.onchange = () => { follow = followBox.checked; if (!follow) shell.setCursor(0, 0); };
window.addEventListener('pointermove', e => {
  if (!follow || dragging) return;
  const r = host.getBoundingClientRect();
  shell.setCursor(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
});
let dragging = false, orbitYaw = 0, orbitPitch = 0, lastX = 0, lastY = 0;
stage.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; stage.setPointerCapture(e.pointerId); stage.classList.add('dragging'); });
stage.addEventListener('pointermove', e => {
  if (!dragging) return;
  orbitYaw -= (e.clientX - lastX) * 0.008;
  orbitPitch = Math.max(-1.2, Math.min(1.2, orbitPitch + (e.clientY - lastY) * 0.008));
  lastX = e.clientX; lastY = e.clientY;
  shell.setViewOrbit(orbitYaw, orbitPitch);
});
let downAt = { x: 0, y: 0 };
stage.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });
const endDrag = (e: PointerEvent) => {
  dragging = false;
  stage.classList.remove('dragging');
  // A click on the Ghost itself (not a drag) boops it.
  const r = host.getBoundingClientRect();
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 4 && Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) < r.height * 0.22) shell.boop();
};
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
$('#resetView').onclick = () => { orbitYaw = orbitPitch = 0; shell.setViewOrbit(0, 0); };

// ---- voice demo: the browser's own speech voice. Speech synthesis can't be routed into Web Audio,
// so the bands are driven from its word-boundary events plus a syllable-rate envelope. In the app,
// the real ElevenLabs/Edge audio drives them through the analyser instead.
const LINE = 'Good evening, Aaron. Your jacket is pressed, your calendar is clear, and I am at your service. Shall I open Spotify, or would you prefer some quiet?';
let speakingNow = false;
let env = 0, syllable = 0, swing = 0, lastBoundary = 0;
function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  const prefs = [/Andrew/i, /Ryan/i, /Guy/i, /Brian/i, /Google UK English Male/i, /Daniel/i, /en-GB/i, /en-US/i, /^en/i];
  for (const re of prefs) { const v = voices.find(v => re.test(v.name) || re.test(v.lang)); if (v) return v; }
  return voices[0];
}
function playVoice(): void {
  if (!('speechSynthesis' in window)) { $('#voiceNote').textContent = 'This browser has no speech voice; try Edge or Chrome.'; return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(LINE);
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.02;
  u.pitch = 1.08;
  u.onstart = () => { speakingNow = true; setState('speaking'); };
  u.onboundary = e => {
    // Each word: a burst of energy; punctuation before it: a pitch swing (an inflection).
    const before = LINE.slice(Math.max(0, e.charIndex - 2), e.charIndex);
    env = 1;
    swing = /[,.?!]/.test(before) ? 1 : 0.35;
    lastBoundary = performance.now();
  };
  u.onend = u.onerror = () => { speakingNow = false; env = 0; shell.setBands([0, 0, 0]); if (state === 'speaking') setState('done'); };
  speechSynthesis.speak(u);
  $('#voiceNote').textContent = v ? `Voice: ${v.name}` : '';
}
$('#voice').onclick = playVoice;
let lastT = performance.now();
(function pump() {
  requestAnimationFrame(pump);
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (!speakingNow) return;
  // No boundary events for a while (some voices don't send them): keep a steady syllable rhythm.
  if (now - lastBoundary > 450) { env = Math.max(env, 0.6); swing = Math.max(swing, 0.2 * Math.random()); }
  syllable += dt * 5.5 * Math.PI * 2;
  env *= Math.exp(-dt / 0.35);
  swing *= Math.exp(-dt / 0.12);
  const s = Math.abs(Math.sin(syllable));
  shell.setBands([0.35 + 0.4 * env * s, 0.3 + 0.55 * env * s + 0.2 * swing, 0.15 + 0.35 * swing + 0.15 * env * s]);
})();

// ---- reactions
document.querySelectorAll<HTMLButtonElement>('[data-mood]').forEach(b => b.addEventListener('click', () => {
  const mood = b.dataset.mood!;
  if (mood === 'boop') shell.boop();
  else if (mood === 'doze') { setState('idle'); shell.doze(); }
  else shell.express(mood as 'happy' | 'curious' | 'sad');
}));

// ---- readouts
let frames = 0, t = performance.now();
(function fps() {
  requestAnimationFrame(fps);
  frames++;
  const now = performance.now();
  if (now - t > 1000) {
    $('#fps').textContent = String(Math.round((frames * 1000) / (now - t)));
    $('#level').textContent = shell.qualityLevel;
    frames = 0; t = now;
  }
})();

// Keyboard: 1–8 switch states.
const order: GhostState[] = ['idle', 'listening', 'thinking', 'searching', 'speaking', 'done', 'approval', 'error'];
window.addEventListener('keydown', e => { const i = Number(e.key) - 1; if (i >= 0 && i < order.length) setState(order[i]); });
setState('idle');
