// Finding the app Aaron means by "open Claude", among the apps Windows itself lists in the Start
// menu (`Get-StartApps`): desktop programs and Store apps alike, each with the id Windows starts it by.
//
// open_app only ever starts something from that list. It used to fall back to handing the bare name
// to Windows, which runs whatever command is called that: "claude" found the command-line tool's
// claude.ps1 (a "Select an app" box), and "logoff" would have signed Aaron out, with no confirm card.

export interface StartApp { name: string; id: string }

// What people call a few Windows tools, by the name the Start menu gives them.
const ALIASES: Record<string, string> = {
  cmd: 'command prompt', 'command line': 'command prompt', explorer: 'file explorer', files: 'file explorer', taskmgr: 'task manager',
  calc: 'calculator', mspaint: 'paint', regedit: 'registry editor', control: 'control panel', vscode: 'visual studio code', 'vs code': 'visual studio code',
  'snip tool': 'snipping tool', 'windows terminal': 'terminal',
};

const tidy = (s: string) => s.toLowerCase().replace(/\.exe$/, '').replace(/[^\p{L}\p{N}+#.]+/gu, ' ').trim();

/**
 * Entries that aren't "the app": uninstallers and repair tools (starting one by a loose name match
 * would be a nasty surprise) and links to web pages. They can still be started by path, with a card.
 */
export function launchable(app: StartApp): boolean {
  if (/\b(uninstall(er)?|remove|repair|reset)\b/i.test(app.name)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(app.id) || /unins\w*\.exe$/i.test(app.id)) return false;
  return !!app.name.trim() && !!app.id.trim();
}

/**
 * The app a name means, and other close ones (to offer when there's no clear match). The exact name
 * wins, then names that start with it, then names with it as a whole word ("code" → Visual Studio
 * Code), then names that merely contain it; the shortest name wins a tie ("PowerShell" before its ISE).
 */
export function findApp(query: string, apps: StartApp[]): { app: StartApp | null; near: string[] } {
  let q = tidy(query);
  q = ALIASES[q] ?? q;
  if (!q) return { app: null, near: [] };
  const words = q.split(' ');
  const scored: { app: StartApp; score: number }[] = [];
  for (const app of apps.filter(launchable)) {
    const name = tidy(app.name);
    const nameWords = name.split(' ');
    const wholeWords = nameWords.some((_, i) => words.every((w, k) => nameWords[i + k] === w));
    const score = name === q ? 0 : name.startsWith(`${q} `) ? 1 : wholeWords ? 2 : q.length >= 3 && name.includes(q) ? 3 : -1;
    if (score >= 0) scored.push({ app, score });
  }
  scored.sort((a, b) => a.score - b.score || a.app.name.length - b.app.name.length || a.app.name.localeCompare(b.app.name));
  const names = [...new Set(scored.map(s => s.app.name))];
  if (scored.length) return { app: scored[0].app, near: names.slice(1, 4) };
  // Nothing fits: the nearest by a shared word, so Ghost can ask "did you mean…".
  const near = apps.filter(launchable).filter(a => tidy(a.name).split(' ').some(w => w.length >= 3 && words.some(x => x.length >= 3 && (w.startsWith(x) || x.startsWith(w)))));
  return { app: null, near: [...new Set(near.map(a => a.name))].slice(0, 4) };
}

/** `Get-StartApps | ConvertTo-Json` output → apps (one app comes as an object, not a list). */
export function parseStartApps(json: string): StartApp[] {
  try {
    const data = JSON.parse(json.slice(json.search(/[[{]/)));
    return (Array.isArray(data) ? data : [data])
      .map(a => ({ name: String(a?.Name ?? ''), id: String(a?.AppID ?? '') }))
      .filter(a => a.name && a.id);
  } catch { return []; }
}
