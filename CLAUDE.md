# Ghost: notes for Claude Code

Handoff from the cloud sessions that built Ghost, so a local session can carry straight on. Read this first, then `README.md` and `docs/SETUP.md`.

## Who and how

- **Aaron** (use they/them) builds and uses Ghost on a Windows PC. Repo: `C:\Users\AaronTengRyzen\Ghost`, branch `claude/bold-planck-b1n6bl`.
- **Stay in sync with GitHub:** Aaron works both locally and in cloud sessions on the same branch.
  - **Before starting work,** run `git pull origin claude/bold-planck-b1n6bl`.
  - **When done,** make sure everything is committed and pushed, so the next session (local or cloud) starts from the latest code.
- Commit and push after each change. Aaron installs new versions with **Settings → Updates** (git pull → npm install → `npm run dist:win` → silent install), or by running those steps by hand.
- Explain things plainly and briefly. Ask Aaron before big or design-level changes. Make one change at a time and say what changed.
- **Test in the real app before pushing**, and say plainly what you could not test. A pushed change that broke Ghost on Windows cost Aaron a lot of time once (see "Compatible drawing" below).

## What Ghost is

A floating desktop companion: a small 3D drone (or the classic orb skin) in a screen corner, with a chat bubble, text input and voice.

- **Brains, on subscriptions only (no API keys, ever):**
  - Claude, through the Claude Code CLI (`claude`, Pro/Max plan). It's kept running between messages: `providers/claudeLive.ts`.
  - Gemini, through the Antigravity CLI (`agy`, Google AI Pro): `providers/antigravity.ts`.
  - Primary and secondary brain, each with Light / Balanced / Heavy model slots.
- **Voice:** ElevenLabs (free-tier key, encrypted with DPAPI), falling back to Edge neural voices, through a "Ghost" audio filter.
- **Obsidian is the source of truth** for history and memory once a vault is connected:
  - conversation notes, Memory notes by topic, and Daily Note links;
  - with no vault, a local fallback in `%APPDATA%\Ghost\data`.
- **Also:**
  - live screen view (a snapshot with each message);
  - screenshots and screen recording;
  - reminders and PC actions with confirm cards;
  - a one-button updater.

## Layout

| Path | What |
| --- | --- |
| `src/core/ghostCore.ts` | The brain: WebSocket server on 127.0.0.1 (token auth), turns, fallback between brains, speech queue, approvals, live view, capture commands |
| `src/core/providers/` | Claude CLI (`claude.ts`, `claudeLive.ts`), Antigravity (`antigravity.ts`, `agyPlugin.ts` = its plugin and permission hook), mock |
| `src/core/tools/` | Tool definitions, executor, `fileAccess.ts` (safe folders), `mcpServer.ts` (stdio MCP bridge the CLIs launch; relays calls to the core) |
| `src/core/approvals/classify.ts` | Which tool calls need Aaron's confirmation |
| `src/core/obsidian/`, `src/core/memory/` | Vault access, index, conversation filing, memory, importer, starter layout |
| `src/main/` | Electron main: overlay window, settings window, recorder, screen capture, updater, Windows watchers (fullscreen, foreground, WinEvent hooks via koffi), log |
| `src/renderer/overlay/` | The overlay: 3D shell (Three.js), bubble, input, confirm card, LIVE/REC tags, attention (where Ghost looks) |
| `src/renderer/settings/` | Settings page (two tabs: Settings, Additional settings) |
| `src/renderer/recorder/` | Hidden page that records the screen (MediaRecorder) |
| `src/shared/` | Wire protocol and settings (with migrations in `mergeSettings`) |
| `config/persona.md` | Ghost's persona and rules for the brains |

## Commands

```
npm install
npm run typecheck
npx vitest run                     # unit + integration tests (mcpBridge test needs npm run build first)
npm run build
npm run dev                        # full app from source
set GHOST_PROVIDER=mock && npm run dev   # full app with the offline mock brain (no subscription usage)
npm run preview:ui                 # overlay + settings in a normal browser against a mock core
npm run dist:win                   # installer in dist\ (what the updater runs)
```

Logs: `%APPDATA%\Ghost\data\ghost.log` (app) and `%APPDATA%\Ghost\data\update.log` (updater).

## Rules that must keep holding

- **Risky actions confirm:**
  - running commands, writing, deleting and closing apps;
  - opening programs or scripts, and starting an app from a path;
  - writing to the vault;
  - **reading files outside the safe folders** (Ghost's own folders, the vault, Desktop, Documents, Downloads, Pictures\Ghost, Videos\Ghost).
- **No file tools of the brains' own outside the safe folders:**
  - Claude's built-in tools are only WebSearch and WebFetch; files go through Ghost's `read_file` / `list_folder`.
  - Antigravity's own file tools are limited to the safe folders by the hook in `agyPlugin.ts`.
- **The agy hook is copied into `hook.js` as source:** keep `agyHookDecision` self-contained, with **no named inner functions** (the bundler wraps them in `__name`, which doesn't exist there, and every Gemini tool call would fail). `tests/safety.test.ts` runs the real hook script.
- **One-shot model calls get no tools:** filing and summarising conversations (`claudeArgs({ oneShot: true })`).
- **The confirm card focuses Deny,** so an Enter meant for the text box never approves.
- **Ghost's windows can't navigate away or open new windows,** and the pages are sandboxed.

## Decisions Aaron made

- **Settings:**
  - Two tabs, **Settings** and **Additional settings**, always opening on Settings.
  - Everyday items in Settings (including the Live screen view on/off button and Speak replies / Volume); voice picking and tuning, models, look and feel, and the Obsidian options in Additional settings.
- **Fullscreen hiding** is a choice: all fullscreen apps / games only / never.
- **The classic orb skin stays.** Switching skin re-reports the shell position so it stays on screen.
- **Recording:**
  - screen plus PC sound by default, with a mic toggle on the REC tag (Aaron has no mic yet; it must say so and keep recording);
  - Ghost kept out of screenshots and recordings.
  - Windows records everything the PC plays, and Electron 38 can't leave Ghost's own voice out (tested: `restrictOwnAudio` and `suppressLocalAudioPlayback` do nothing for system loopback). So "Recording your screen." is shown but not spoken; anything Ghost says mid-recording is still captured. Aaron chose this over per-app Windows audio capture.
- **Compatible drawing mode was removed.** Starting Chromium without DirectComposition and GPU compositing froze Ghost on Windows. Don't retry that path.
- **The Photos blink** (Ghost vanishes for ~2 frames as Photos closes) is Windows dropping the frame. Aaron agreed it's not worth more risky attempts.
- **Watch mode** (Ghost watching and commenting, via Gemini Flash check-ins about every 60 s at 1 fps) is designed but Aaron said "not yet".
- **Later, planned by Aaron:** more recording work, including a choice to keep Ghost in or leave it out (picture and voice) and picking which screen to record. Don't start it unasked.

## Verified on Aaron's PC (11 Oct 2026)

- Ghost is absent from screenshots and recordings, and stays visible on screen.
- PC sound is in recordings.
- Recordings are H.264/AAC MP4. MediaRecorder writes fragmented MP4 with no total length, so `src/main/mp4Duration.ts` writes it into the header after saving. Media Player now shows the length and can seek.
- Mic toggle without a mic: the notice shows and recording carries on. (Mixing in a real mic is still untested: Aaron has none yet.)
- The installed app (sandboxed preloads): overlay, Settings, the updater and the recorder all work after an update.
- Updater clean-up: a running old installer is moved aside and deleted on the next build; one held open without sharing stops the build with "can't clear …", which Settings words as "Windows has the previous installer … locked".
- File reads with both brains (Gemini Flash and Claude Sonnet): "what's on my screen?" works; a file in Documents is read with no card; a file in AppData\Local shows a confirm card, and after Deny the brain says so and never sees the contents. The Antigravity hook works on Windows paths (its real `hook.cmd` also runs in `tests/safety.test.ts` on Windows).

## docs/SETUP.md manual checklist (section 7): progress

Worked through in rounds of related checks; Aaron reports, Claude checks `ghost.log` and fixes what fails.

- **Passed (12 Oct 2026, Gemini primary):**
  - startup animation and spoken greeting, and the tray icon;
  - Ctrl+Space opens the input focused, and Esc closes it;
  - replies spoken through the Ghost filter, with the shards moving like a mouth and the words appearing with the voice;
  - no "Certainly" openers, and web search works;
  - `open notepad` runs with no card, and `delete C:\temp\x.txt` shows one;
  - cursor following with the beam; no clipping or dark box; no grey shadow on a light background;
  - click boop, and the happy spin after "thanks" (fixed: it now makes a full turn);
  - fading on click-away and after hovering. The hover-only fade was shortened to 2 s at Aaron's request. Hovering doesn't reopen the text box, which is how Aaron wants it;
  - dozing after 5 minutes;
  - screenshots and recording;
  - start at login (16 Oct: started two minutes after boot). The login entry no longer passes the unused `--hidden-start`.
- **Next, Round 3 (moving and quitting):**
  - click-through when idle (hover or Alt to grab);
  - drag precision, edge stick and corner snap, never partly off-screen;
  - position remembered after a restart, and a second monitor (ask whether Aaron has one);
  - all three ways to quit;
  - low GPU when idle, and the Render quality setting.
- **Still to do after that:**
  - a reminder over a fullscreen game;
  - a bad ElevenLabs key falls back to Edge with a notice;
  - memory across a restart, and "what did we talk about yesterday?";
  - live screen view and its auto-off;
  - the first word is heard after 10+ s of silence, and Bluetooth "Test first word";
  - reply timings;
  - the three Obsidian checks;
  - the provider switch when Claude hits its limit.

## Not yet verified on real Windows

1. **Mic with a real mic:** once Aaron has one, their voice is mixed into a recording from the moment they toggle it on.
