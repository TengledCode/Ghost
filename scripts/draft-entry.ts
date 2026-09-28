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
  idle: 'Shut and hovering. Glances around on its own; follows your cursor.',
  listening: 'You are typing. Turns to the input bar, plates ease open, iris widens.',
  thinking: 'Plates unlock with a twist and the two sets counter-rotate. Amber core.',
  searching: 'Fully unfolded, rear set orbits, body sweeps; the core becomes scan rings.',
  speaking: 'Plates, iris and glow pulse with the voice. Press Play voice.',
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
const endDrag = () => { dragging = false; stage.classList.remove('dragging'); };
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
$('#resetView').onclick = () => { orbitYaw = orbitPitch = 0; shell.setViewOrbit(0, 0); };

// ---- voice demo: a synthesised vowel line through the same band analysis the app uses
let ctx: AudioContext | null = null;
let meter: BandMeter | null = null;
let voiceUntil = 0;
function playVoice(): void {
  ctx ??= new AudioContext();
  void ctx.resume();
  const analyser = ctx.createAnalyser();
  meter = new BandMeter(analyser);
  const out = ctx.createGain();
  out.gain.value = 0.18;
  out.connect(analyser);
  analyser.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.05;
  const vowels = [[730, 1090], [270, 2290], [530, 1840], [300, 870], [660, 1720], [440, 1020], [390, 1990]];
  const syllables = 16;
  for (let i = 0; i < syllables; i++) {
    const start = t0 + i * 0.23 + (i % 5 === 4 ? 0.25 : 0);
    const dur = 0.17 + (i % 3) * 0.03;
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(118 + Math.sin(i * 1.7) * 18, start);
    src.frequency.linearRampToValueAtTime(104 + Math.cos(i) * 12, start + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(1, start + 0.03);
    env.gain.setTargetAtTime(0, start + dur - 0.05, 0.03);
    const [f1, f2] = vowels[i % vowels.length];
    const mix = ctx.createGain();
    for (const [f, q, g] of [[f1, 8, 1], [f2, 10, 0.6], [2600, 12, 0.25]]) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const gain = ctx.createGain(); gain.gain.value = g;
      src.connect(bp).connect(gain).connect(mix);
    }
    mix.connect(env).connect(out);
    src.start(start);
    src.stop(start + dur + 0.2);
  }
  voiceUntil = performance.now() + (syllables * 0.23 + 1.2) * 1000;
  setState('speaking');
}
$('#voice').onclick = playVoice;
(function pump() {
  requestAnimationFrame(pump);
  if (meter && performance.now() < voiceUntil) shell.setBands(meter.read());
  else if (meter) { shell.setBands([0, 0, 0]); meter = null; if (state === 'speaking') setState('done'); }
})();

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
