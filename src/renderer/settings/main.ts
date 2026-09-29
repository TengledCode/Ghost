import { EDGE_VOICES, ELEVENLABS_VOICES, type VoiceOption } from '../../shared/voices';
import { SLOT_LABELS, THEMES, type BrainId, type Settings, type SlotModels } from '../../shared/settings';
import { bridge } from '../shared/bridge';
import { CoreClient } from '../shared/coreClient';

const boot = await bridge.bootstrap();
let settings: Settings = boot.settings;
const core = new CoreClient(boot.url, boot.token);

async function update(patch: Partial<Settings>): Promise<void> {
  settings = await bridge.updateSettings(patch);
  render();
}

// Generic bindings: data-key inputs map straight onto settings fields.
for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')) {
  const key = el.dataset.key as keyof Settings;
  const read = () => {
    if (el instanceof HTMLInputElement && el.type === 'checkbox') return el.checked;
    if ('num' in el.dataset) return Number(el.value);
    if ('nullable' in el.dataset && el.value === '') return null;
    return el.value;
  };
  el.addEventListener(el instanceof HTMLInputElement && el.type === 'range' ? 'input' : 'change', () => {
    const patch: Partial<Settings> = { [key]: read() };
    if (key === 'corner') patch.customPosition = null;
    void update(patch);
  });
}

function render(): void {
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]')) {
    const value = settings[el.dataset.key as keyof Settings];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!value;
    else if (document.activeElement !== el || el.type === 'range') el.value = value == null ? '' : String(value);
    const out = el.parentElement?.querySelector('output');
    if (out) out.textContent = el.dataset.key === 'size' ? `${value}px` : `${Math.round(Number(value) * 100)}%`;
  }
  for (const box of document.querySelectorAll<HTMLInputElement>('[data-hotkey]')) box.value = String(settings[box.dataset.hotkey as 'hotkey' | 'quitHotkey' | 'liveScreenHotkey']).replace(/\+/g, ' + ');
  (document.getElementById('liveScreenAutoOffMinutes') as HTMLInputElement).disabled = !settings.liveScreenAutoOff;
  renderBrains();
  renderThemes();
  renderVoices('elevenVoices', ELEVENLABS_VOICES, 'elevenlabs', settings.elevenLabsVoiceId);
  renderVoices('edgeVoices', EDGE_VOICES, 'edge', settings.edgeVoice);
}

// ---- Brain: each brain's Light / Balanced / Heavy slots list the models that brain offers.
type ModelList = { id: string; label: string }[];
const modelLists = new Map<string, ModelList | 'loading' | { error: string }>();
core.on(m => {
  if (m.type !== 'models') return;
  modelLists.set(m.provider, m.error && !m.models.length ? { error: m.error } : m.models);
  renderBrains();
});

function renderBrains(): void {
  // A brain can't back itself up.
  for (const opt of (document.getElementById('secondaryBrain') as HTMLSelectElement).options) opt.disabled = !!opt.value && opt.value === settings.provider;
  const pairs: [string, string | null][] = [['primary', settings.provider], ['secondary', settings.fallbackProvider]];
  for (const [which, brain] of pairs) {
    const wrap = document.querySelector<HTMLElement>(`[data-brain-slots="${which}"]`)!;
    if (!brain || brain === 'mock') { wrap.hidden = true; wrap.replaceChildren(); continue; }
    wrap.hidden = false;
    let list = modelLists.get(brain);
    if (list === undefined) { list = 'loading'; modelLists.set(brain, list); core.send({ type: 'list_models', provider: brain }); }
    const slots = settings.brainModels[brain as BrainId];
    wrap.replaceChildren(...(Object.keys(SLOT_LABELS) as (keyof SlotModels)[]).map(slot => {
      const label = document.createElement('label');
      label.append(SLOT_LABELS[slot]);
      const select = document.createElement('select');
      const options: ModelList = Array.isArray(list) ? [...list] : [];
      // Keep the saved choice visible even if the list couldn't be loaded or no longer has it.
      if (!options.some(o => o.id === slots[slot])) {
        const why = list === 'loading' ? 'loading the list…' : !Array.isArray(list) ? "couldn't load the list" : list.length ? 'not available' : '';
        options.unshift({ id: slots[slot], label: why ? `${slots[slot]} (${why})` : slots[slot] });
      }
      for (const o of options) select.append(new Option(o.label, o.id, false, o.id === slots[slot]));
      select.onchange = () => void update({ brainModels: { ...settings.brainModels, [brain]: { ...slots, [slot]: select.value } } });
      label.append(select);
      return label;
    }));
    if (list !== 'loading' && !Array.isArray(list)) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = `Couldn't read the model list: ${list.error}`;
      wrap.append(hint);
    }
  }
}

function renderThemes(): void {
  const wrap = document.getElementById('themes')!;
  wrap.replaceChildren(...[...Object.entries(THEMES), ['custom', settings.customTheme] as const].map(([name, t]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.setAttribute('aria-pressed', String(settings.theme === name));
    const dot = document.createElement('i');
    dot.style.background = t.shell;
    dot.style.borderColor = t.edge;
    b.append(dot, name[0].toUpperCase() + name.slice(1));
    b.onclick = () => void update({ theme: name });
    return b;
  }));
  const custom = document.getElementById('customTheme')!;
  custom.hidden = settings.theme !== 'custom';
  for (const input of custom.querySelectorAll<HTMLInputElement>('[data-custom]')) {
    const k = input.dataset.custom as keyof Settings['customTheme'];
    input.value = settings.customTheme[k];
    input.oninput = () => void update({ customTheme: { ...settings.customTheme, [k]: input.value } });
  }
}

function renderVoices(id: string, list: VoiceOption[], engine: 'elevenlabs' | 'edge', selected: string): void {
  document.getElementById(id)!.replaceChildren(...list.map(v => {
    const row = document.createElement('div');
    row.className = `voice${v.id === selected ? ' selected' : ''}`;
    const pick = document.createElement('input');
    pick.type = 'radio';
    pick.name = id;
    pick.checked = v.id === selected;
    pick.onchange = () => void update(engine === 'edge' ? { edgeVoice: v.id } : { elevenLabsVoiceId: v.id });
    const text = document.createElement('div');
    text.innerHTML = `<strong></strong><br /><small></small>`;
    text.querySelector('strong')!.textContent = v.label;
    text.querySelector('small')!.textContent = v.note;
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = 'Preview';
    play.onclick = () => core.send({ type: 'voice_preview', engine, voice: v.id });
    row.append(pick, text, play);
    return row;
  }));
}

// ElevenLabs key: stored encrypted by the main process and never sent back to the page.
const keyStatus = document.getElementById('keyStatus')!;
const showKeyStatus = (has: boolean) => {
  keyStatus.textContent = has
    ? 'Key saved (encrypted with your Windows account).'
    : 'No key yet. Create a free account at elevenlabs.io, then Profile → API keys. Without a key, Ghost uses Edge voices.';
};
showKeyStatus(boot.hasElevenLabsKey);
document.getElementById('saveKey')!.addEventListener('click', async () => {
  const input = document.getElementById('elevenKey') as HTMLInputElement;
  showKeyStatus(await bridge.setSecret('elevenlabs', input.value.trim()));
  input.value = '';
});

document.getElementById('newConversation')!.addEventListener('click', () => core.send({ type: 'new_conversation' }));
document.getElementById('previewCustomVoice')!.addEventListener('click', () => {
  const voice = (document.getElementById('customVoice') as HTMLInputElement).value.trim();
  if (voice) core.send({ type: 'voice_preview', engine: 'elevenlabs', voice });
});

// Checks that the first word survives a long silence (Bluetooth headsets tend to swallow it).
const testButton = document.getElementById('testFirstWord') as HTMLButtonElement;
const testStatus = document.getElementById('testFirstWordStatus')!;
testButton.addEventListener('click', () => {
  testButton.disabled = true;
  let left = 12;
  const tick = () => {
    if (left > 0) { testStatus.textContent = `Stay quiet… Ghost counts to four in ${left}s. Listen for "one".`; left--; setTimeout(tick, 1000); return; }
    testStatus.textContent = 'Did you hear "one"? If not, try Keep audio awake: Always.';
    testButton.disabled = false;
    const engine = settings.ttsEngine;
    core.send({ type: 'voice_preview', engine, voice: engine === 'edge' ? settings.edgeVoice : settings.elevenLabsVoiceId, text: 'One, two, three, four.' });
  };
  tick();
});

// Two-step confirm inside the page (dialogs like confirm() aren't used in Ghost's windows).
const clearBtn = document.getElementById('clearHistory') as HTMLButtonElement;
let clearArmed = 0;
clearBtn.addEventListener('click', () => {
  if (Date.now() - clearArmed > 4000) { clearArmed = Date.now(); clearBtn.textContent = 'Click again to clear'; return; }
  core.send({ type: 'clear_history' });
  clearArmed = 0;
  clearBtn.textContent = 'History cleared';
  setTimeout(() => { clearBtn.textContent = 'Clear conversation history'; }, 2500);
});

// Hotkey capture → Electron accelerator syntax (summon and quit share the same capture).
for (const box of document.querySelectorAll<HTMLInputElement>('[data-hotkey]')) {
  box.addEventListener('keydown', e => {
    e.preventDefault();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[];
    if (!mods.length) return; // a bare key would hijack normal typing
    const key = e.code === 'Space' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    void update({ [box.dataset.hotkey!]: [...mods, key].join('+') } as Partial<Settings>);
  });
}

document.getElementById('quit')!.addEventListener('click', () => bridge.quit());

render();
