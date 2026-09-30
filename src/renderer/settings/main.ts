import { EDGE_VOICES, ELEVENLABS_VOICES, type VoiceOption } from '../../shared/voices';
import { SLOT_LABELS, THEMES, type BrainId, type Settings, type SlotModels } from '../../shared/settings';
import type { CoreMessage } from '../../shared/protocol';
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
  renderObsidian();
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

// ---- Obsidian
type ObsidianStatusInfo = Extract<CoreMessage, { type: 'obsidian_status' }>['status'];
let obsidian: ObsidianStatusInfo | null = null;
const vaultSelect = document.getElementById('vaultSelect') as HTMLSelectElement;
const PICK = '__pick__';
core.on(m => { if (m.type === 'obsidian_status') { obsidian = m.status; renderObsidian(); } });
core.send({ type: 'obsidian_status' });

const setObsidian = (patch: Partial<Settings['obsidian']>) => void update({ obsidian: { ...settings.obsidian, ...patch } });

vaultSelect.addEventListener('change', async () => {
  if (vaultSelect.value !== PICK) { setObsidian({ vaultPath: vaultSelect.value || null }); return; }
  const path = await bridge.pickFolder('Choose your Obsidian vault folder');
  if (path) setObsidian({ vaultPath: path }); else renderObsidian();
});
const folderInput = document.getElementById('obsFolder') as HTMLInputElement;
folderInput.addEventListener('change', () => setObsidian({ folder: folderInput.value }));
for (const box of document.querySelectorAll<HTMLInputElement>('[data-obs]')) {
  box.addEventListener('change', () => setObsidian({ [box.dataset.obs!]: box.checked } as Partial<Settings['obsidian']>));
}
document.getElementById('openObsidian')!.addEventListener('click', () => {
  const name = obsidian?.connected?.name;
  if (name) bridge.openObsidian(`obsidian://search?vault=${encodeURIComponent(name)}&query=${encodeURIComponent(`path:"${settings.obsidian.folder}/"`)}`);
});
document.getElementById('importHistory')!.addEventListener('click', () => core.send({ type: 'obsidian_import' }));
let starterBusy = false;
document.getElementById('starterGo')!.addEventListener('click', () => { starterBusy = true; core.send({ type: 'obsidian_starter' }); renderObsidian(); });
document.getElementById('starterNo')!.addEventListener('click', () => core.send({ type: 'obsidian_starter_dismiss' }));
const deleteBackupBtn = document.getElementById('deleteBackup') as HTMLButtonElement;
let deleteArmed = 0;
deleteBackupBtn.addEventListener('click', () => {
  if (Date.now() - deleteArmed > 4000) { deleteArmed = Date.now(); deleteBackupBtn.textContent = 'Click again to delete'; return; }
  core.send({ type: 'obsidian_delete_backup' });
  deleteArmed = 0;
  deleteBackupBtn.textContent = 'Delete it';
});

function renderObsidian(): void {
  const current = settings.obsidian.vaultPath;
  const vaults = obsidian?.vaults ?? [];
  const options: [string, string][] = [['', 'Not connected: keep history on this PC']];
  for (const v of vaults) options.push([v.path, `${v.name}${v.open ? ' (open in Obsidian)' : ''}`]);
  if (current && !vaults.some(v => v.path === current)) options.push([current, current]);
  options.push([PICK, 'Choose a folder…']);
  vaultSelect.replaceChildren(...options.map(([value, label]) => new Option(label, value, false, value === (current ?? ''))));

  const status = document.getElementById('vaultStatus')!;
  const c = obsidian?.connected;
  status.textContent = !current
    ? (vaults.length ? 'Pick your vault to move Ghost\'s history into Obsidian. A backup of the local copy is kept.' : "Obsidian doesn't seem to be set up on this PC yet. You can still choose a vault folder.")
    : obsidian?.error ?? (c ? `Connected to ${c.name} · ${c.notes.toLocaleString()} notes${c.waiting ? ' · some changes waiting to be written' : ''}` : 'Connecting…');

  (document.getElementById('obsidianOptions') as HTMLElement).hidden = !current;
  if (document.activeElement !== folderInput) folderInput.value = settings.obsidian.folder;
  for (const box of document.querySelectorAll<HTMLInputElement>('[data-obs]')) box.checked = !!settings.obsidian[box.dataset.obs as keyof Settings['obsidian']];

  const starter = current ? obsidian?.starter : null;
  if (starter === 'done') starterBusy = false;
  (document.getElementById('starterCard') as HTMLElement).hidden = !starter && !starterBusy;
  (document.getElementById('starterButtons') as HTMLElement).hidden = starter !== 'offer' || starterBusy;
  document.getElementById('starterTitle')!.textContent = starterBusy ? 'Setting up your vault…' : starter === 'done' ? 'Your vault is set up.' : 'Your vault is nearly empty. Set up a simple structure?';
  if (starter === 'done') document.getElementById('starterText')!.textContent = 'Restart Obsidian (or reopen the vault) so it picks up the new settings. Start from the Home note.';

  const imp = obsidian?.import;
  const importStatus = document.getElementById('importStatus')!;
  importStatus.textContent = !imp ? '' : {
    conversations: `Importing your history: ${imp.done} of ${imp.total} conversations…`,
    facts: 'Importing what Ghost knows about you…',
    paused: `Import paused at ${imp.done} of ${imp.total}: no brain was available to summarise. It continues automatically, or press Import.`,
    finished: imp.total ? `Your earlier history is in Obsidian (${imp.total} conversation${imp.total === 1 ? '' : 's'}).` : '',
  }[imp.phase];
  (document.getElementById('importHistory') as HTMLElement).hidden = imp?.phase !== 'paused';

  const backup = obsidian?.backupBytes;
  (document.getElementById('backupRow') as HTMLElement).hidden = !current || backup == null;
  if (backup != null) {
    const size = backup > 1e6 ? `${(backup / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(backup / 1e3))} KB`;
    document.getElementById('backupText')!.textContent = `The old local copy of your history is kept as a backup (${size}). Once you've checked your notes in Obsidian:`;
  }
  document.getElementById('clearHint')!.textContent = current
    ? "Conversations are notes in Obsidian, so Ghost picks up after a restart and can recall past chats. Clearing moves Ghost's conversation notes to Obsidian's trash; your Memory notes are kept."
    : 'Conversations are kept on this PC so Ghost can pick up after a restart and recall past chats. Clearing keeps the lasting facts it has learned about you.';
}

// ---- Updates
type UpdateStatus = Awaited<ReturnType<typeof bridge.updateStatus>>;
const updateRun = document.getElementById('updateRun') as HTMLButtonElement;
const updateCheck = document.getElementById('updateCheck') as HTMLButtonElement;
function renderUpdate(u: UpdateStatus): void {
  const ago = u.checkedAt ? ` · checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  document.getElementById('updateVersion')!.textContent = u.state === 'unavailable'
    ? "Updates aren't available for this copy (it wasn't built with npm run dist:win)."
    : `Ghost ${u.version}${u.commit ? ` (${u.commit})` : ''}${ago}`;
  const n = u.changes.length;
  document.getElementById('updateState')!.textContent = {
    unavailable: '', idle: '', checking: 'Checking for updates…', 'up-to-date': 'Ghost is up to date.',
    available: `${n} update${n === 1 ? '' : 's'} available:`, updating: `${u.step ?? 'Updating'}…`, error: u.error ?? 'Something went wrong.',
  }[u.state];
  const list = document.getElementById('updateChanges')!;
  list.hidden = u.state !== 'available';
  list.replaceChildren(...u.changes.slice(0, 12).map(c => Object.assign(document.createElement('li'), { textContent: c })));
  const bar = document.getElementById('updateProgress') as HTMLProgressElement;
  bar.hidden = u.state !== 'updating';
  bar.value = u.progress ?? 0;
  updateRun.hidden = !(u.state === 'available' || (u.state === 'error' && n > 0));
  updateRun.disabled = !u.canInstall;
  updateRun.title = u.canInstall ? '' : 'Running from source: use git pull and npm run dev instead.';
  updateCheck.disabled = u.state === 'checking' || u.state === 'updating' || u.state === 'unavailable';
}
bridge.onUpdate(renderUpdate);
void bridge.updateStatus().then(renderUpdate);
updateCheck.addEventListener('click', () => void bridge.checkForUpdates().then(renderUpdate));
updateRun.addEventListener('click', () => bridge.runUpdate());

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
