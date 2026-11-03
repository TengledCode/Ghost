# Ghost: notes for Claude Code

Handoff from the cloud sessions that built Ghost, so a local session can carry straight on. Read this first, then `README.md` and `docs/SETUP.md`.

## Who and how

- **Aaron** (he/him) builds and uses Ghost on a Windows PC. Repo: `C:\Users\AaronTengRyzen\Ghost`, branch `claude/bold-planck-b1n6bl`.
- **Stay in sync with GitHub:** Aaron works both locally and in cloud sessions on the same branch.
  - **Before starting work,** run `git pull origin claude/bold-planck-b1n6bl`.
  - **When done,** make sure everything is committed and pushed, so the next session (local or cloud) starts from the latest code.
- Commit and push after each change. Aaron installs new versions with **Settings → Updates** (git pull → npm install → `npm run dist:win` → silent install), or by running those steps by hand.
- Explain things plainly and briefly. Ask Aaron before big or design-level changes. Make one change at a time and say what changed.
- **Test in the real app before pushing**, and say plainly what you could not test. A pushed change that broke Ghost on Windows cost Aaron a lot of time once (see "Compatible drawing" below).
  - A change can be held back: commit it locally, don't push. **Settings → Updates** builds from this folder, lists such commits as "(on this PC only)" and installs them. Push once Aaron confirms. (By hand: `npm run dist:win`, then `dist\Ghost Setup 0.1.0.exe /S --force-run`.)
- **Windows shell gotchas:**
  - PowerShell 5.1 mangles quotes in `git commit -m`: write the message to a file and use `git commit -F`.
  - Commands run through cmd (the updater's `runCommand`) lose a `^`: use git's `--not` instead of `^commit`.
  - There's no `python`; use node for scripts.
  - Test copies need a clean environment (see the security items below).

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
- **Passed (Round 3, 20 Oct 2026):**
  - click-through when idle. Three fixes, in `src/main/inputNative.ts` (user32 via koffi):
    - Ghost brightens only once he's grabbable, and a click that passes through him keeps him faded until the cursor leaves;
    - a zero-pixel mouse nudge makes the first click after the hover land on Ghost (Windows only re-hit-tests on mouse movement);
    - Alt is read from Windows, as Ghost rarely has keyboard focus;
  - drag precision, edge stick and corner snap; position remembered after a restart. Aaron has **no second monitor**;
  - all three ways to quit;
  - idle GPU about 1.7% of the 3D engine (Task Manager shows 0%).
- **Passed (Round 4, 26 Oct 2026):**
  - the first word is heard after 10+ s of silence. A new message cuts off what Ghost is still saying, by design;
  - Bluetooth "Test first word";
  - the ElevenLabs → Edge fallback. Fixed along the way:
    - **the Edge voice was broken** (403 from Microsoft): `msedge-tts` was updated to 2.1.1. Its `npx only-allow pnpm` preinstall is harmless as a dependency;
    - the overlay's "no voice came" safety net waited 0.6 s, so with Edge (~3 s to start) the whole reply flashed up first. It's now 8 s (failed sentences still arrive, silent, with their words);
    - notices stay while their reply's bubble is up, and fade with Ghost. The voice-switch notice is yellow, with plain wording per cause (`voiceFallbackNotice`);
    - Settings checks the ElevenLabs key against `/v1/user/subscription` (no credits spent) when it opens and on save. It shows works / credits used up / rejected / unreachable, plus this month's usage. A rejected key isn't saved, and a new key resets the back-off.
- **Passed (31 Oct 2026):**
  - the chat stack centres on a free-floating Ghost when it fits (`orientationForShell` → `top-center` / `bottom-center`). Free positions are saved as the shell's own spot (`customPosition.anchor: 'shell'`), so Ghost never jumps when the stack changes sides; old saves convert on first use;
  - the first update check runs 10 s after start (still only the dot).
  - Ghost hides in **TFT** with "games only" (seen in real matches on 31 Oct; `ghost.log`: "hidden … (a borderless game: TFTClient-Win64-Shipping.exe)").
    - TFT is borderless: QUNS 2, an `UnrealWindow` covering the screen.
    - `shouldHide` also hides in games mode when the window in front covers its monitor and `looksLikeGame` (engine window class or game-library folder).
    - Other games are still to check.
- **Still to do:**
  - reply timings: redo by sending a second message only after the first reply has finished;
  - a reminder over a fullscreen game;
  - memory across a restart, and "what did we talk about yesterday?";
  - live screen view and its auto-off;
  - the three Obsidian checks;
  - the provider switch when Claude hits its limit.

## Aaron's to-do list (from 27 Oct 2026)

Work through it one item at a time, asking Aaron before design-level changes.

- **Done:**
  - text box centred on a free-floating Ghost;
  - update check soon after start;
  - TFT hiding;
  - the 4 Oct memory mix-up: recall now ignores chat filler, uses the previous message for short follow-ups, and labels memories as background.
- **Done (1 Nov 2026): the brains.** Aaron's decisions:
  - Gemini slots are **matched to Claude's**, as equal as possible: Light ≈ Haiku is the newest Flash (medium); Balanced ≈ Sonnet is the strongest Gemini family at medium; Heavy ≈ Opus is the strongest at high. Today that's Gemini 3.8 Flash / 4 Argon Medium / 4 Argon High.
  - Claude's slots stay **Haiku / Sonnet / Opus**: never Fable (Aaron is on Pro and avoids usage credits). Use Gemini's best even when it's below Opus.
  - Rules are in `src/core/models.ts`; settings hints are `flash` / `top-medium` / `top-high`, and the old `pro` maps to `top-high`. `settings.geminiTopFamily` holds the chosen strongest family (pinned to Argon on the first check).
  - `src/main/modelWatcher.ts` reads `agy models` 30 s after start and every 6 h (state in `data/models.json`):
    - newer models and generations are followed automatically, with an info notice;
    - a **new family in the same generation** (e.g. Carbon beside Argon) is offered: a yellow notice, the gear dot, and **Use it / Not now** in Settings → Brain.
  - Brains report the exact model that answered (`ProviderEvent` `model`). It shows under each slot in Settings, in the reply's model label and in conversation notes.
  - Testing from source: `GHOST_EXTRA_MODELS=gemini-4-carbon-high,…` pretends agy offers more. Tested on Aaron's PC with a pretend Carbon.
  - The grab delay is a setting ("Hover before Ghost can be grabbed"), 0.6 s.
- **Open:**
  - **Next, approved by Aaron on 2 Nov (in this order):**
    1. **Ghost staring at the blinking text cursor:** look at the input only while typing (a key in the last second or two) or just after clicking into it; otherwise follow the mouse.
    2. **Starting sooner after boot:** Run-key apps are delayed by Windows. Replace the login item with a Task Scheduler "at log on" task.
    3. **Ghost changes his own settings on request:** Aaron chose **an Undo notice** (change straight away, with Undo on the notice). Safety settings, the ElevenLabs key and the vault location are off-limits.
  - **Built 3 Nov, committed on this PC only, waiting for Aaron's test, then push:**
    - **Silent lines show at once** (commit "Show 'Recording your screen.' at once"). "record my screen" never goes to a brain and the recorder starts in ~0.5 s. Ghost seemed to take 8 s because the overlay waited for a voice that never comes (its no-voice safety net). `turn_end` now carries `silent: true`.
    - **Screenshot viewer** (commit "Screenshot viewer: …"), as Aaron specified:
      - The reply says where the file went ("Screenshot saved in Pictures\Ghost and copied to the clipboard.", "Recording saved in Videos\Ghost (9 s).").
      - The same bubble shows a preview, with **Open** and **Show in folder**; clicking the preview opens it too. It stays as long as the reply.
      - Ghost "projects" it: he glances at it, a cone of light runs from his eye to the picture (`#projection` SVG), and the picture scans in cyan, then settles to full colour.
      - Recordings get the same, with a video frame (Windows' thumbnail) and a ▶.
      - **"show my last screenshot" / "previous recording"** gives "Previous screenshot saved in Pictures\Ghost (3 Nov, 9:42 pm)." with the same card.
      - How it works: `turn_end.file` carries the capture; IPC `ghost:capture-preview` / `ghost:capture-open`; `src/main/captureFiles.ts` allows only .png/.mp4/.webm inside Pictures\Ghost and Videos\Ghost.
      - Only Ghost's own commands get the card. A brain's `take_screenshot` tool reply doesn't (yet).
      - Checked in the browser preview (`npm run preview:ui`, which now has pretend captures).
      - **Aaron to check:** the update installs; "Recording your screen." shows at once; screenshot card, Open, Show in folder; "show my last screenshot".
  - **Proposed, waiting for Aaron:** leave notes-only commits (only `.md` files) out of the update list and don't rebuild for them. Aaron was confused by "CLAUDE.md: Electron 45 done…" showing as an update.
  - **Include Ghost in recordings:** a Settings switch. His voice is always recorded anyway, so this is about his picture.
  - **Secondary brain follows the primary** (Claude ↔ Gemini) when the primary is changed in Settings: done.
  - **Read-out-friendly replies** (persona).
  - **Hide Ghost:** interview Aaron first about how it should work.
  - **Google Drive,** and later the phone and its gallery. Ask what Ghost should do with it. Simplest route: Drive for desktop as a safe folder.
  - **Ghost's conversational capabilities.**
  - **Ghost's ability to self-update, bug-fix and improve.**
  - **Security items from the 1 Nov review.** Done and tested on 1 Nov:
    - (2) Settings → Updates keeps the `claude` and `agy` CLIs current: the check lists "Claude Code x → y"; Update stops the brains, runs `claude update` / `agy update` (failures non-fatal), then rebuilds, or just restarts when Ghost itself has nothing new;
    - (3) separate tokens: `core.token` (UI, memory only) and `core.mcpToken` (the relay, in the CLIs' configs), so the relay can't answer confirm cards;
    - (4) `npm audit`: 0 production vulnerabilities (fixes plus zod 4);
    - (5) uncaught errors are logged, and Ghost keeps running;
    - (6) removed the old Gemini CLI config (`data/workspace/.gemini`) and the unused `data/ack-cache`.
    - Also: `claude` is started without `ANTHROPIC_*` / `CLAUDE_*` variables (`subscriptionEnv`), so it can only use the subscription login. A test copy started from inside the Claude app had inherited them ("signed out", then "API Usage Billing"). Aaron's real login had broken on 27 Oct (no expiry or refresh token) and he signed in again on 1 Nov.
    - **Start test copies with a clean environment:** no `ANTHROPIC_*` / `CLAUDE_*`, and a normal Windows `PATH` / `SystemRoot`. A Git-Bash environment made `Start-Process notepad` show the "Select an app" box.
    - **(1) The Electron upgrade, 38 → 45: done and tested on Aaron's PC (2–3 Nov).**
      - Changes: `clipboard.writeImage` → `ClipboardItem` (screenshots); the recorder's session also allows `display-capture`; `roundedCorners: false` on the overlay; npm `allowScripts` for the install scripts. `safeStorage`'s sync methods are deprecated (removed in 46): move to the async ones before 46.
      - **Recordings had no picture on 45:** the GPU's H.264 encoder writes nothing (MediaRecorder MP4 got only the sound track; same for HEVC, even from a canvas). Ghost starts with `disable-accelerated-video-encode`, so the software encoder is used: picture, sound and length are back. It only affects encoding, not drawing.
      - Passed: no freeze, drawing, click-through, grabbing (0.6 s and Alt), Settings, fullscreen hiding, screenshots (Ghost absent, pastes into Paint), recording with sound.
    - **Updates also count commits only on this PC** (not pushed yet, e.g. held back for testing): listed as "(on this PC only)", and Update rebuilds them. Before, Update just restarted Ghost because GitHub had nothing new. Seen working on Aaron's PC on 3 Nov: two "(on this PC only)" changes were listed.
    - **The terminal flash: solved (2 Nov).** `agy` runs its own background updater (at most every 15 min), which starts `agy.exe --version` in a new console that Windows Terminal shows. Ghost now starts `agy` with `AGY_CLI_DISABLE_AUTO_UPDATE=true` (`'1'` doesn't work). Settings → Updates still runs `agy update`. Verified: no window at Ghost's start, and agy's log says auto-update is disabled.
  - **A full security sweep,** keeping security practices up to date (for example, dependency checks on each update).
  - **Last:** clear redundant logs and test leftovers, keeping core memories and facts about Aaron (list it for his approval first).

## Not yet verified on real Windows

1. **Mic with a real mic:** once Aaron has one, his voice is mixed into a recording from the moment he toggles it on.
