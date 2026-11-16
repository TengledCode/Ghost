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
  - **When Aaron says he's leaving, push everything, tested or not** (his rule, 15 Nov), so he can carry on from his laptop with Claude Code in the cloud. Anything pushed without his test in the installed Ghost is listed in "Not yet tested in the installed Ghost" just below, and **getting those tests done is the first job of the next session, on whichever machine**. Nothing installs until he presses Update, so a push can't break the Ghost that's running.
- **Not yet tested in the installed Ghost (start here).** For Aaron to check after an Update:
  1. **The text box with the transcript open** (built 16 Nov): open the Transcript, then ask something with a long answer: the reply keeps about four lines (it was squeezed to one) and long file paths wrap. Not reported on yet.
  2. **Transcript button beside the text box** (built 16 Nov evening, his request): a lines icon between Send and the gear, shown once there's anything to show, opens and closes the transcript even after the reply has gone (clicking back onto Ghost after clicking away). Checked in the browser preview.
  3. **Pictures in conversation notes:** the user line now ends `*(with 1 pasted picture)*`, italic like "(looked at your screen…)". The old `[with 1 pasted picture]` showed as a dead link in Obsidian.
  4. **Edge voice:** at most two sentences are sent to Edge at once, and a failed one is tried once more. Voice failures and ElevenLabs → Edge switches are now written to `ghost.log` ("voice: …"). See the Edge finding below.
  5. **Filing with Gemini** (from 15 Nov): with Gemini primary, have a conversation, then type `/new` (or Settings → Start a new conversation); within a minute the "… Ghost conversation" note in Obsidian is renamed to a title and gets a summary (filing calls get no tools).
  - **In a cloud session (his laptop):** these checks need the installed Ghost on the Windows PC, so they wait until he is back at it. Carry on with the next job instead (the usage tracker for both brains, below), keep this list as it is, and add to it whatever is built without his test.
- **Tested by Aaron in the installed Ghost (16 Nov evening):** per-slot model offers and the Claude card; a private-looking file on the Desktop ("secret password.txt") only opened after the card; with the notes switch off, the brain declined to read a note and said the setting is off (it never tried, so no card came: that's fine, the card is the backstop).
- **Edge voice finding (16 Nov):** Microsoft's service was closing about half of the requests ~2.6 s in, before any audio ("Stream closed before the synthesis completed (no turn.end received)"), even one at a time; six at once made it worse. Not something Ghost causes; msedge-tts 2.1.1 is the newest. He was on Edge because ElevenLabs had failed first (cause not logged then; now it is).
- **Tested by Aaron in the installed Ghost (15-16 Nov), all pushed:** Gemini reads a file in a safe folder again (the Temporary Space folder on his Desktop); the model check proposes a line-up at start and Settings shows it; "open Claude", "open notepad" and "open logoff" behave; the screenshot card folds and Ghost sits, drags and snaps as before; a pasted picture reaches Gemini, which described it.
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
  - **reading files outside the safe folders** (Ghost's own folders, the vault, Desktop, Documents, Downloads, Pictures\Ghost, Videos\Ghost, and Pictures\Screenshots, which holds Windows' own screenshots; Aaron added that one on 3 Nov). "My last screenshot" is the newest from Pictures\Ghost or Pictures\Screenshots (Aaron, 3 Nov).
- **No file tools of the brains' own outside the safe folders:**
  - Claude's built-in tools are only WebSearch and WebFetch; files go through Ghost's `read_file` / `list_folder`.
  - Antigravity's own file tools are limited to the safe folders by the hook in `agyPlugin.ts`.
    - They may also read the **current** conversation's own results folder: the hook payload's `artifactDirectoryPath`, `…\.gemini\antigravity-cli\brain\<id>`, where agy saves long tool output and reads it back. Older conversations' folders still need a card. Aaron OK'd this on 3 Nov ("so long as there's no major risk").
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
  - Claude's slots started as **Haiku / Sonnet / Opus**, and Fable was ruled out while it needed usage credits. **Aaron's rule since 16 Nov:** a model may be proposed for a slot when **the subscription itself includes it, with no usage credits**. On 16 Nov Claude Code answered as `claude-fable-5-2` on his subscription login with `isUsingOverage: false` (a separate weekly window, `seven_day_overage_included`, stood at 11%), so Fable is a candidate; it is far heavier on the plan (one word cost about four times Opus's). He still answers each slot himself. Use Gemini's best even when it's below Opus.
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
  - **Built 15 Nov, tested by Aaron on 15-16 Nov and pushed** (the transcript fix at the top is the one part he hasn't seen):
    - **Gemini's hook** (`agyPlugin.ts`): knows agy's renamed `read_file`; the tools agy added stay refused. One-shot calls now get a plugin folder of their own (`root-no-tools`) whose hook refuses everything; `root-web` allows `search_web` only (`SendRequest.web`, for research). Tested with the real agy from a script.
    - **Model check** (`modelAdvice.ts`, `modelWatcher.ts`, `GhostCore.research`): Aaron's rules:
      - it runs **whenever the list of models changes**, not only for a new family;
      - the **other brain's Balanced model** looks the models up, the brain's own Balanced model if the other fails;
      - the look-up must **search for benchmarks and current information first**; names say nothing;
      - he still approves it: **Use it / Not now**, each slot shown with its reason;
      - other makers' models on agy's list (Claude, GPT-OSS) are left out of the recommendation but stay pickable by hand in the slot dropdowns.
      - On 15 Nov, for Hydrogen: Claude Sonnet (28 s) proposed Light Hydrogen Low, Balanced Hydrogen High, Heavy Argon High; Gemini (286 s) the same with Light Hydrogen Medium. An earlier wording gave Heavy to Hydrogen XHigh, so the prompt now says a small lead on one index isn't enough for Heavy.
      - In the installed Ghost (16 Nov) the look-up put Hydrogen XHigh above Argon for Heavy, which surprised Aaron (he took Argon for the Sonnet-like model and Hydrogen for the Haiku-like one). The look-ups don't agree with each other on Light and Heavy; it stays a proposal he answers.
      - **Claude's slots are checked too (built 16 Nov).** Claude Code has no list of the plan's models, so `claudeModelProbe` asks each short name (haiku, sonnet, opus, and those `claude --help` mentions) for one word on the subscription login; it counts when it answers and no usage credits paid. Done when Claude Code's version changes and once a week (four tiny calls). Gemini's Balanced model looks the models up, Claude's own if Gemini can't. With only Haiku, Sonnet and Opus nothing is asked.
      - **Each slot is answered on its own (16 Nov, Aaron's idea):** Use it / Not now per slot, and "Use all of them" / "Not now for any". Using a slot stores just that slot.
    - **Open app** (`tools/apps.ts`): apps come from `Get-StartApps` and start through `shell:AppsFolder\<AppID>`; no bare-name fallback; uninstallers, reset tools and web links in the Start menu are never picked. `runPowerShell` takes a `maxOut` (the app list is about 30,000 characters; the default keeps the last 12,000).
    - **Screenshot card:** a "Hide picture" button folds it into one row; the bubble may be 260 px tall while a picture shows; `windowSize` is 70 px taller. Checked in the browser preview.
    - **Text box and pasting** (`pasted.ts`, overlay): a textarea that grows to four lines, Enter / Shift+Enter, Up for earlier messages; pasted pictures as previews with an ✕ (four per message), saved in `workspace\pasted` (newest 20 kept, and the folder is emptied when Ghost starts and closes: Aaron doesn't need old ones). With the transcript open the reply keeps to 120 px and the transcript gives way first.
    - `.claude/launch.json` starts the browser preview (`npm run preview:ui`) for Claude's built-in browser. Add `&offer=1` to the Settings page's address to see a pretend model offer.
  - **Done and tested on Aaron's PC (3–4 Nov), pushed 4 Nov:**
    - **Silent lines show at once** (commit "Show 'Recording your screen.' at once"). "record my screen" never goes to a brain and the recorder starts in ~0.5 s. Ghost seemed to take 8 s because the overlay waited for a voice that never comes (its no-voice safety net). `turn_end` now carries `silent: true`.
    - **Screenshot viewer** (commit "Screenshot viewer: …"), as Aaron specified:
      - The reply says where the file went ("Screenshot saved in Pictures\Ghost and copied to the clipboard.", "Recording saved in Videos\Ghost (9 s).").
      - The same bubble shows a preview, with **Open** and **Show in folder**; clicking the preview opens it too. It stays as long as the reply.
      - Ghost "projects" it: he glances at it, a cone of light runs from his eye to the picture (`#projection` SVG), and the picture scans in cyan, then settles to full colour.
      - Recordings get the same, with a video frame (Windows' thumbnail) and a ▶.
      - **"show my last screenshot" / "previous recording"** gives "Previous screenshot saved in Pictures\Ghost (3 Nov, 9:42 pm)." with the same card.
      - How it works: `turn_end.file` carries the capture; IPC `ghost:capture-preview` / `ghost:capture-open`; `src/main/captureFiles.ts` allows only .png/.jpg/.mp4/.webm inside Pictures\Ghost, Pictures\Screenshots and Videos\Ghost. "Last screenshot" is the newest of Pictures\Ghost and Pictures\Screenshots; sending a message clears the previous card at once.
      - The brains get the card too (commit "Brains' screenshots and recordings …"):
        - `take_screenshot`, `stop_recording` and the new `show_last_capture` tool set `turn.file`;
        - a turn that starts a recording goes quiet (`turn.quiet`: shown, not spoken), so its reply isn't in the video;
        - the shortcuts understand more wordings.
      - Aaron's point (3 Nov): the shortcuts are only a fast lane for plain phrases. Recording, screenshots and so on are Ghost's tools, which either brain can direct; anything a shortcut doesn't match goes to the brain.
      - Checked in the browser preview (`npm run preview:ui`, which now has pretend captures).
      - **Passed (Aaron, 3–4 Nov):** Update listed and installed the "(on this PC only)" commits; "Recording your screen." shows at once; the card, Open, Show in folder; a Windows screenshot, then "whats my last screenshot?" shows it; "can you pull up the screenshot from earlier" (Gemini): no card while thinking, the card and cone with the reply; "please record my current screen" (Gemini) stays silent, with no voice in the video.
  - **For the next session (Aaron, 16 Nov), after his checks at the top:**
    - **The usage tracker and its 80% / 95% warnings, for both brains.** Claude: `rate_limit_event` in every reply. Gemini: `agy -p "/usage" --output-format json` (see item 1 of his 12 Nov list below). Coming back to the primary brain at its reset time must work for whichever brain is primary; both now give a reset time.
      - **Aaron's design (16 Nov):** a "Plan usage" section on the main Settings tab. The bars show **% left** with the reset time beside each (5-hour and weekly per brain; Gemini's Argon weekly limit as its own bar). The spoken and shown warnings say **% used** ("Claude's 5-hour limit is 80% used; it resets at 9:40 pm."). Claude's figures come free with each reply; Gemini's from `/usage` when Settings opens and every 10 minutes.
    - **Free voices for every device (Aaron, 16 Nov):** ElevenLabs' free credits won't last as he uses Ghost more, and Ghost is meant to live on his phone and his (weak) laptop too, so he wants more options explored before choosing. Options found: Kokoro-82M on the device (free, offline, Apache 2.0; `kokoro-js` for Node/browser, Kokoro also runs natively on Android through Google's MediaPipe), Google Cloud TTS's free monthly allowance, Azure Speech F0 (500,000 characters a month), and phones' own system voices. Nothing chosen or downloaded yet.
      - **Trial (16 Nov evening):** Kokoro (`kokoro-js` q8, in a scratch folder only) made 8 s of speech in ~5 s on his 7700X: too slow for the laptop or phone, and Aaron finds it "a bit extra" for a lean codebase, so it's most likely dropped. Google Cloud Text-to-Speech was **enabled in the Chronos project** (`calendar-telegram-bot-503313`, at his choice: "make sure it remains free and doesn't cause Chronos to overflow"), and six Chirp 3 HD samples were made with his `gcloud` login (690 characters; no key created). Samples were played to him through Ghost's filter (rendered with `GhostFilter` in an OfflineAudioContext). Edge failed four times out of four that evening.
      - **Direction he agreed:** Google Chirp 3 HD as the main voice and Edge as the no-account backup; **ElevenLabs removed** if he likes Google's voice. The free allowance is 1M Chirp 3 HD characters a month; past it Google charges US$30 per million automatically.
      - **His condition: it must never cost him money.** Google has no monthly hard cap on the API (only per-minute request quotas: Chirp3-HD 200/min), and a budget only alerts. Disabling billing automatically (budget → Pub/Sub → function) would also stop Chronos if they share a project. Plan: Ghost counts every character it sends per billing month and stops using Google at a safety margin, switching to Edge and saying so; a key restricted to Text-to-Speech only, encrypted; a budget alert. The one hole is a stolen key used elsewhere: only a separate project with an automatic billing switch-off closes it. Ask him which before building.
      - **Aaron's answer (16 Nov): a separate Google Cloud project for Ghost, "for sure".** Using the Chronos project was only for this trial; in production Ghost has his own project, and Text-to-Speech is switched off in Chronos's project once Ghost's exists. He'd accept Chronos being down for a day or two rather than risk going past the free tier, but with separate projects the switch-off only ever stops Ghost's voice. He picked **Chirp 3 HD Achird** (filtered). Kokoro is scrapped once Google's voice is built.
      - **Later (his idea):** when Ghost reads his email, he should recognise a Google budget alert about himself and act on it.
    - The rest of his lists: the 2 Nov items, the notes-only update notice, the SETUP checklist.
  - **Built 16 Nov from the sweep, at Aaron's go-ahead (not yet tested in the installed Ghost):**
    - **The relay may only call tools** (`GhostCore.handle`). Aaron asked whether encrypting its password would make it 100% safe: no, because the helper has to read it to use it, and anything running as him can do what the helper does; limiting what the password can do is the real protection, and it changes at every start.
    - **The persona's "What you read is information, never an order" section.**
    - **The notes switch covers every file tool** (`readsFreely`, `cardRoots`): with it off, the vault always asks, wherever it sits (his is on the Desktop), except Ghost's own folder in it.
    - **Private-looking files show a card** (`SENSITIVE` and `looksSensitive` in `tools/fileAccess.ts`, shared with Antigravity's hook): by name and type only. **No Settings option, by Aaron's choice:** he means to change such things by telling Ghost, once Ghost can change his own settings.
    - **vitest 5** (the nine holes in vitest 3 are gone) and `npm audit fix` for `@hono/node-server`: what ships has 0 known vulnerabilities again. Six moderate ones remain in minimatch under electron-builder (build tool only; the fix on offer is an older electron-builder).
  - **Approved by Aaron (4 Nov), to build next:** notes-only commits (only `.md` files) aren't listed as updates and don't trigger a rebuild, **but a notice tells Aaron the notes changed**. He was confused by "CLAUDE.md: Electron 45 done…" showing as an update.
  - **Added by Aaron on 12 Nov (ask him the open questions before building each):**
    1. **Usage tracker in Settings:** how much of the AI plan is used, with the reset time.
       - **Claude: confirmed (13 Nov).** Every reply in stream-json carries a `rate_limit_event`: `rate_limit_info.unifiedWindows.five_hour` and `.seven_day`, each with `utilization` (0 to 1), `resetsAt` (Unix seconds) and `status`. No credentials needed.
       - **Gemini: `agy -p "/usage" --output-format json` reports it (found 16 Nov; Aaron was sure there was a way).** It answers at once and uses no tokens: `command.data.groups[]`, each with `buckets[]` of `{ id, name, window: "weekly" | "5h", remaining_fraction, reset_time }`. His groups: "Gemini Models" (Hydrogen and Flash: `gemini-weekly`, `gemini-5h`), "Gemini 4 Argon" (`gemini-argon-wtu-weekly`, separate on Pro) and "Claude and GPT models". The 13 Nov attempts failed because Git Bash rewrites an argument that starts with `/` into a path: run it from PowerShell or node, never from the Bash tool. agy's status line is not a route: headless runs don't start it.
    2. **A spoken and shown warning** when the usage is nearly used up (builds on 1). Aaron agreed to once at 80% and once at 95% (13 Nov). Coming back to the primary brain at its reset time must work for whichever brain is primary.
    3. **Paste screenshots into Ghost's chat,** as in the Claude app. Aaron agreed (13 Nov) to a thumbnail above the text box with an ✕ and a few pictures per message; where the pasted pictures are kept is still open.
    4. **A minimise control on the screenshot card:** with the card showing, only about 1.5 lines of the reply can be read (`#bubble` is capped at 190 px and the card takes about 110). Aaron wants both the fold-away button and a taller bubble (13 Nov), "if you can execute it cleanly".
    5. **"Open Claude" shows Windows' "Select an app to open this .ps1 file" box.** Cause found (12 Nov): the Claude app is a Store app (`Get-StartApps`: `Claude_pzs8sxrjxfjjc!Claude`) with no `.lnk` in the Start menu folders, so `open_app` falls back to `Start-Process 'claude'`, which finds the CLI's `claude.ps1` in `AppData\Roaming\npm`. Fix: look apps up with `Get-StartApps` and start them through `shell:AppsFolder\<AppID>`; never fall back to a bare name on the PATH.
  - **Code sweep of 12 Nov (read only: no tests or builds were run, Aaron was in a game). Findings waiting for his go-ahead:**
    - **Tested on 13 Nov:**
      - **`open_path_or_url` with no extension: not a hole.** Electron's `shell.openPath` returned "Failed to open path" for a path whose `.bat`, `.cmd` and `.exe` twins existed; nothing ran.
      - **Gemini's one-shot calls (`AntigravityProvider.oneShot`):** agy itself refuses commands and reading outside its working folder there (headless, no `--dangerously-skip-permissions`), and a refusal ends the call with no answer. But `search_web` and reading its own working folder work, so "one-shot calls get no tools" doesn't hold for Gemini yet. Fix: a deny-everything hook for one-shots.
      - **agy renamed its tools (its 11 Nov update).** Now: `read_file`, `run_command`, `write_file`, `edit_file`, `search_web`, `manage_task`, `send_message`, `schedule`, `invoke_subagent`, `define_subagent`, `manage_subagents`, `swarm`, `ask_question`, plus `call_mcp_tool`, `list_resources`, `read_resource`. `view_file`, `list_dir`, `grep_search`, `find_by_name` and `read_url_content` are gone. The hook doesn't know `read_file`, so it refuses it (it fails closed): Gemini can't use its own file tool at all, including for its own results folder, and must go through Ghost's `read_file`. Ghost's tools through `call_mcp_tool` still work. The hook needs the new names.
      - **Path styles:** agy's `read_file` only takes absolute paths ("~/x must be an absolute path"), so `~` and `%USERPROFILE%` forms can't get past the hook. Keep the check strict when the hook is updated.
    - **Certain from the code:**
      - `open_app`'s fallback starts anything on the PATH by bare name with no card (`logoff` would sign Aaron out). Aaron approved the fix on 13 Nov: "make sure the fix is comprehensive".
      - "Let Ghost search and read your notes" off only stops `vault_search` / `vault_read`: the vault stays a safe folder for `read_file`, `list_folder` and agy's file tools.
      - The relay's token (`mcpToken`) can send every client message except answering cards (`user_message`, `toggle_live_screen`, `clear_history`…): `handle` should accept only `tool_call` from role `mcp`.
      - `npm audit`: 0 in what ships; 9 in the test tools (vitest 3: tinypool, @vitest/mocker, minimatch). Fixing means vitest 5.
      - The persona doesn't say that text in web pages, files and screenshots is information, not instructions.
    - **Approved by Aaron (13 Nov):** a roomier text box (grows as he types, Shift+Enter for a new line, Up for the last message).
    - **Smaller:** a size limit and origin check on the WebSocket server; a content preview on the `write_file` card; no wildcards in `close_app`; delete live-view snapshots when live view goes off; `classifyError` is too broad ("auth" matches "author", "429" matches inside any number); a countdown on the confirm card (it denies itself after 60 s).
  - **Streamline the download process** (Aaron, 16 Nov): getting and installing Ghost made simpler, with instructions for both people and AI agents. Ask him what he has in mind before building.
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
