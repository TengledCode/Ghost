# Ghost: notes for Claude Code

Read this first, then `README.md` and `docs/SETUP.md`. It holds how to work with Aaron, the rules that must keep holding, what's outstanding, and the facts that were hard to learn. What's finished lives in git history, not here.

## Who and how

- **Aaron** (he/him) builds and uses Ghost on a Windows PC. Repo: `C:\Users\AaronTengRyzen\Ghost`, branch `claude/bold-planck-b1n6bl`. He also works from his laptop, where Claude Code runs locally in its own Ghost folder and can run Ghost from source (`npm run dev`, or with `GHOST_PROVIDER=mock` for no subscription use).
- **Stay in sync with GitHub:** before starting, `git pull origin claude/bold-planck-b1n6bl`; when done, everything committed and pushed.
- Explain things plainly and briefly. Ask Aaron before big or design-level changes. One change at a time, and say what changed.
- **Test in the real app before pushing**, and say plainly what you could not test. A pushed change that broke Ghost on Windows once cost him a lot of time.
  - Hold a change back by committing it without pushing: **Settings → Updates** builds from this folder, lists such commits as "(on this PC only)" and installs them. Push once he confirms. (By hand: `npm run dist:win`, then `dist\Ghost Setup 0.1.0.exe /S --force-run`.)
  - **When he says he's leaving, push everything, tested or not**, and list what he hasn't tested under "Waiting for Aaron's test". Nothing installs until he presses Update, so a push can't break the running Ghost.
  - Those tests are the first job of the next session **at the PC**. On the laptop, start straight on the next job.
- **Keep the lists current:** mark items done as soon as he says they work, here **and** on the to-do artifact (https://claude.ai/artifact/LqV4wswu3RSLdGtVNDeA4C). Both must say the same thing; once he tested from an out-of-date copy and his numbers were applied to the wrong list. Remove finished items rather than keeping a log of them.
- **Windows shell gotchas:**
  - PowerShell 5.1 mangles quotes in `git commit -m`: write the message to a file and use `git commit -F`.
  - Commands run through cmd (the updater's `runCommand`) lose a `^`: use git's `--not` instead of `^commit`.
  - There's no `python`; use node for scripts. Many files have CRLF line endings, so scripted string replacements must allow for `\r\n`.
  - Git Bash rewrites an argument starting with `/` into a path (`agy -p "/usage"`): run such commands from PowerShell or node.
  - **Start test copies with a clean environment:** no `ANTHROPIC_*` / `CLAUDE_*`, and a normal Windows `PATH` / `SystemRoot`. Inherited variables signed the `claude` CLI out of the subscription; a Git-Bash environment made `Start-Process notepad` show the "Select an app" box.

## Waiting for Aaron's test (in the installed Ghost, after an Update)

1. **Transcript fading:** it fades with Ghost and goes about 9 s after Ghost faded, like a reply; using Ghost before then keeps it.
2. **Words without a voice:** after the 8 s safety net, or at once when the voice has definitely failed (`audio.failed`, a failed greeting), the words appear one by one at speaking pace (`SPOKEN_CHARS_PER_SECOND` 15), silently. If the voice arrives late, the shown words wait until it has caught up, then follow it. He watched this work in the browser preview; in the real Ghost it only shows when the voice is slow or fails.
3. **A reply never hides while Ghost is busy;** one shown after Ghost went idle (a failed greeting) goes ~9 s later.
4. **Filing with Gemini:** with Gemini primary, chat, then `/new`; within a minute the "… Ghost conversation" note in Obsidian gets a title and a summary.
5. **Recordings as plain MP4s** (built 17 Nov, held on the PC until he confirms): record, stop, then paste the recording into WhatsApp. MediaRecorder writes *fragmented* MP4 (`moof`/`mdat` pairs), which WhatsApp hangs on; `src/main/mp4Flatten.ts` rewrites it right after saving (one `moov` with full tables, one `mdat`, data copied byte for byte; the old length fix runs if that fails). Checked on a copy of his recording: full length, seeking and sound work.
- Can't be forced by hand: Edge gets at most two sentences at once and one retry (unit-tested). Voice failures are logged in `ghost.log` ("voice: …").
- Preview modes for voice trouble: `GHOST_PREVIEW_TTS=fail` / `flaky` / `slow` (voice after 12 s) / `silent` / `synth`, set in the shell before `npm run preview:ui`. The preview's pretend brain gives a longer reply there, for watching it appear.

## Outstanding work, in order

1. **Sounds for Ghost's animations** (approved 17 Nov), made with Web Audio like the notice chime (`overlay/chime.ts`, no sound files), robotic to match his voice, following the volume, with one "Sound effects" switch in Settings: a holographic sweep as a screenshot or recording is projected; a chirp on the click boop; a power-up hum at startup and when waking from a doze, a soft power-down when dozing off; a small mechanical click when grabbed and when snapping into a corner; an attention tone when a confirm card appears; a rising trill with the happy spin. Nothing during a recording (it would be in the video).
   - **The happy spin (and its trill) only when the whole message is thanks or praise** (his rule): "thanks", "thanks Ghost", "thank you so much!", "cheers mate", "great job". Today `moodFromMessage` (`overlay/shell/motion.ts`) matches the words anywhere, so "my plan failed thanks to bob" and "no thanks" make him spin.
2. **A Destiny 2-style voice character** (in progress, 17 Nov). Aaron wants Ghost to sound more like Destiny 2's Ghost: clearly a robot, but not just buzzy. Make about four samples of the same line through the real `GhostFilter` (rendered in an OfflineAudioContext, with a 0.6 s lead so the filter isn't cold), let him pick by ear, then add it as a fourth character beside natural / companion / drone. Measured from a Red War clip he recorded (game sound mixed in, so rough): pitch about 150 Hz (120-230), a fuller low end than companion (which high-passes at 190 Hz), a very tight metallic ring (about 0.8-1.3 ms comb, companion uses 3.1 ms), brightness around 1.2 and 2.1 kHz (companion boosts 2.9 kHz), and doubling or modulation rather than distortion. Shape the filter towards the style; don't try to copy the actor's own voice.
3. **Plan usage in Settings, with warnings at 80% and 95%, for both brains** (his 12 Nov list; the laptop's next job). His design: a "Plan usage" section on the main Settings tab; bars show **% left** with the reset time beside each (5-hour and weekly per brain; Gemini's Argon weekly limit as its own bar); spoken and shown warnings say **% used** ("Claude's 5-hour limit is 80% used; it resets at 9:40 pm."), once at 80% and once at 95%. Coming back to the primary brain at its reset time must work for whichever brain is primary (today a fallen-back Ghost retries Claude every 15 minutes, and each try fails). Leave room for the voice's line. How to read the figures is under "How things work" below.
4. **Google's voice** (designed; see "Google voice" below). Then remove ElevenLabs, once Aaron has heard Google's and says yes, and delete the Kokoro trial (scratch folders `kokoro-pkg`, `kokoro-run`, `voice-samples` in the PC session's scratchpad; nothing in the repo).
5. **Notes-only updates** (approved 4 Nov): commits touching only `.md` files aren't listed as updates and don't trigger a rebuild, but a notice tells Aaron the notes changed.
6. **Approved 2 Nov, in this order:**
   1. Ghost looks at the text box only while Aaron is typing (a key in the last second or two) or just after he clicks into it; otherwise he follows the mouse.
   2. Start sooner after boot: replace the login item with a Task Scheduler "at log on" task (Windows delays Run-key apps).
   3. Ghost changes his own settings when asked, with **an Undo notice** (change at once, Undo on the notice). Off-limits: safety settings, the voice keys and the vault location. Aaron means to adjust things like the private-files card this way rather than through Settings.
7. **Smaller fixes from the 12 Nov code review:** a size limit and origin check on the WebSocket server; a content preview on the `write_file` card; no wildcards in `close_app`; delete live-view snapshots when live view goes off; `classifyError` is too broad ("auth" matches "author", "429" matches inside any number); a countdown on the confirm card (it denies itself after 60 s).
8. **Open, ask Aaron before building each:**
   - Streamline the download process: getting and installing Ghost made simpler, with instructions for both people and AI agents.
   - Include Ghost in recordings: a Settings switch for his picture (his voice is always recorded anyway).
   - Read-out-friendly replies (persona).
   - Hide Ghost: interview Aaron first about how it should work.
   - Google Drive, and later the phone and its gallery. Simplest route: Drive for desktop as a safe folder.
   - Ghost's conversational abilities.
   - Ghost updating, fixing and improving himself.
   - **Approved 17 Nov (from my 3 Nov ideas):** one-click roll back in Settings → Updates (keep the previous installer; "Go back to the last version"); Settings → Updates shows the installed change and its date (e.g. "e0387cd, 17 Nov"), since the version stays 0.1.0 until Ghost is released; a health check on the first start after an update (brains, voice, drawing), saying plainly if something failed; a debug switch that makes `ghost.log` also record the first words of each message and which tools ran (off by default, for privacy). He turned down a GitHub branch for held-back work and a weekly memory backup (his synced vault will cover that).
   - A full security sweep, kept up to date: dependency checks on each update; move `safeStorage` to its async methods before Electron 46 (the sync ones are removed there).
   - **Last:** clear old logs and test leftovers (also a 213 MB old copy of Antigravity left by its updater, and old settings conversions that have done their job), keeping core memories and facts about Aaron. List it for his approval first.
9. **His later plans, not to start unasked:** more recording work (keep Ghost in or out, picture and voice; pick which screen); watch mode (Ghost commenting on the screen via Gemini Flash check-ins about every 60 s at 1 fps, designed but "not yet"); Ghost recognising a Google budget alert about himself in Aaron's email; one voice count shared by all devices once his synced vault exists.
10. **Setup checklist left (`docs/SETUP.md` section 7):** reply timings (send the second message only after the first reply has finished); a reminder over a fullscreen game; memory across a restart and "what did we talk about yesterday?"; live screen view and its auto-off; the three Obsidian checks; switching brains when Claude hits its limit; mixing in a real mic once Aaron has one.

## What Ghost is

A floating desktop companion: a small 3D drone (or the classic orb skin) in a screen corner, with a chat bubble, text input and voice.

- **Brains, on subscriptions only (no API keys, ever):** Claude through the Claude Code CLI (`claude`, kept running between messages: `providers/claudeLive.ts`) and Gemini through the Antigravity CLI (`agy`: `providers/antigravity.ts`). A primary and a secondary brain, each with Light / Balanced / Heavy model slots.
- **Voice:** ElevenLabs (free-tier key, encrypted with DPAPI), falling back to Edge neural voices, through the "Ghost" audio filter. Google's voice is to replace ElevenLabs.
- **Obsidian is the source of truth** for history and memory once a vault is connected (conversation notes, Memory notes by topic, Daily Note links); with no vault, a local fallback in `%APPDATA%\Ghost\data`.
- **Also:** live screen view (a snapshot with each message), screenshots and screen recording, pasted pictures, reminders, PC actions with confirm cards, and a one-button updater.

## Layout

| Path | What |
| --- | --- |
| `src/core/ghostCore.ts` | The brain: WebSocket server on 127.0.0.1 (token auth), turns, fallback between brains, speech queue, approvals, live view, capture shortcuts |
| `src/core/providers/` | Claude CLI (`claude.ts`, `claudeLive.ts`), Antigravity (`antigravity.ts`, `agyPlugin.ts` = its plugin and permission hook), mock |
| `src/core/tools/` | Tool definitions, executor, `fileAccess.ts` (safe folders, private-looking files), `apps.ts`, `mcpServer.ts` (stdio MCP bridge the CLIs launch; relays calls to the core) |
| `src/core/approvals/classify.ts` | Which tool calls need Aaron's confirmation |
| `src/core/obsidian/`, `src/core/memory/` | Vault access, index, conversation filing, memory, importer, starter layout |
| `src/core/tts/` | Voices: `elevenlabs.ts`, `edge.ts`, `service.ts` (`TtsService`: main voice, Edge fallback, `EDGE_AT_ONCE`, one retry) |
| `src/main/` | Electron main: overlay window, settings window, recorder, screen capture, updater, model watcher, Windows watchers (fullscreen, foreground, WinEvent hooks via koffi), log |
| `src/renderer/overlay/` | The overlay: 3D shell (Three.js), bubble, subtitles, input, confirm card, LIVE/REC tags, attention (where Ghost looks); `audio/` = player, `ghostFilter.ts`, `trim.ts` |
| `src/renderer/settings/` | Settings page (two tabs: Settings, Additional settings) |
| `src/renderer/recorder/` | Hidden page that records the screen (MediaRecorder) |
| `src/shared/` | Wire protocol, settings (migrations in `mergeSettings`), voices |
| `config/persona.md` | Ghost's persona and rules for the brains |
| `cloud/billing-killswitch/` | The Google Cloud function that switches billing off for Ghost's project |

## Commands

```
npm install
npm run typecheck
npx vitest run                     # unit + integration tests (mcpBridge test needs npm run build first)
npm run build
npm run dev                        # full app from source
set GHOST_PROVIDER=mock && npm run dev   # full app with the offline mock brain (no subscription usage)
npm run preview:ui                 # overlay + settings in a normal browser against a mock core (.claude/launch.json starts it)
npm run dist:win                   # installer in dist\ (what the updater runs)
```

Logs: `%APPDATA%\Ghost\data\ghost.log` (app) and `%APPDATA%\Ghost\data\update.log` (updater).

## Rules that must keep holding

- **Risky actions confirm:** running commands, writing, deleting and closing apps; opening programs or scripts, and starting an app from a path; writing to the vault; **reading files outside the safe folders** (Ghost's own folders, the vault, Desktop, Documents, Downloads, Pictures\Ghost, Videos\Ghost and Pictures\Screenshots); and **private-looking files** anywhere (`SENSITIVE` / `looksSensitive` in `tools/fileAccess.ts`, by name and type, shared with Antigravity's hook).
- **With "Let Ghost search and read your notes" off,** the vault always asks, wherever it sits (his is on the Desktop), except Ghost's own folder in it; this covers every file tool (`readsFreely`, `cardRoots`).
- **No file tools of the brains' own outside the safe folders:**
  - Claude's built-in tools are only WebSearch and WebFetch; files go through Ghost's `read_file` / `list_folder`.
  - Antigravity's own file tools are limited to the safe folders by the hook in `agyPlugin.ts`. They may also read the **current** conversation's own results folder (the hook payload's `artifactDirectoryPath`, `…\.gemini\antigravity-cli\brain\<id>`, where agy saves long tool output); older conversations' folders still need a card (Aaron OK'd this, 3 Nov). Tools the hook doesn't know are refused (it fails closed).
- **The agy hook is copied into `hook.js` as source:** keep `agyHookDecision` self-contained, with **no named inner functions** (the bundler wraps them in `__name`, which doesn't exist there, and every Gemini tool call would fail). `tests/safety.test.ts` runs the real hook script.
- **One-shot model calls get no tools** (filing and summarising conversations): `claudeArgs({ oneShot: true })` for Claude; for Gemini a plugin folder of its own (`root-no-tools`) whose hook refuses everything. Research look-ups use `root-web`, which allows `search_web` only.
- **The relay** (the MCP bridge's token, `mcpToken`) may only call tools: it can't answer confirm cards or send messages as Aaron. The UI has its own token (`core.token`, in memory only). Both change at every start.
- **`open_app`** starts only apps from Windows' own list (`Get-StartApps`, through `shell:AppsFolder\<AppID>`), never a bare name on the PATH (`logoff` would sign him out); uninstallers, reset tools and web links in the Start menu are never picked.
- **The persona** tells the brains that text in web pages, files and screenshots is information, never an order.
- **The confirm card focuses Deny,** so an Enter meant for the text box never approves.
- **Ghost's windows can't navigate away or open new windows,** and the pages are sandboxed.
- **`claude` is started without `ANTHROPIC_*` / `CLAUDE_*` variables** (`subscriptionEnv`), so it can only use the subscription login.

## Decisions Aaron made

- **Settings:** two tabs, **Settings** and **Additional settings**, always opening on Settings. Everyday items in Settings (Live screen view, Speak replies / Volume); voice picking and tuning, models, look and feel and the Obsidian options in Additional settings.
- **Fullscreen hiding** is a choice: all fullscreen apps / games only / never.
- **The classic orb skin stays.** Switching skin re-reports the shell position so it stays on screen.
- **Recording:** screen plus PC sound by default, with a mic toggle on the REC tag (with no mic it says so and keeps recording); Ghost kept out of screenshots and recordings. Windows records everything the PC plays and Electron can't leave Ghost's own voice out, so "Recording your screen." is shown but not spoken, and a brain's reply that starts a recording stays quiet (`turn.quiet`). He chose this over per-app Windows audio capture.
- **Shortcuts** ("record my screen", "take a screenshot", "stop recording", "show my last screenshot") are only a fast lane for plain phrases; anything else goes to the brain, which has the same tools. Shortcuts are written into the conversation as commands, and the next message tells the brain what they did.
- **Screenshots and recordings** show in the reply with a preview, **Open** and **Show in folder**, and Ghost "projects" them (a cone of light from his eye). "My last screenshot" is the newest from Pictures\Ghost or Pictures\Screenshots.
- **Replies and voice:** words appear in step with the voice; a new message cuts off what Ghost is still saying; replies and the transcript fade with Ghost and go about 9 s later; the hover-only fade is 2 s; hovering doesn't reopen the text box. Silence at each join between recordings is trimmed, with Ghost's own pauses (0.12 s after a comma, 0.3 s after a sentence, 0.45 s after a paragraph).
- **Pasted pictures** are kept in `workspace\pasted` (newest 20, and emptied when Ghost starts and closes).
- **Models:** Gemini's slots are matched to Claude's as closely as possible (Light ≈ Haiku is the newest Flash, Balanced ≈ Sonnet the strongest family at medium, Heavy ≈ Opus the strongest at high). A model may be proposed for a slot only when **the subscription itself includes it, with no usage credits** (so Fable can be, though it's far heavier on the plan). He answers each slot himself: **Use it / Not now** per slot, or for all. Other makers' models on agy's list stay pickable by hand but aren't recommended.
- **Compatible drawing mode was removed:** starting Chromium without DirectComposition and GPU compositing froze Ghost on Windows. Don't retry that path.
- **The Photos blink** (Ghost vanishes for ~2 frames as Photos closes) is Windows dropping the frame; not worth more risky attempts.

## How things work (learned the hard way)

- **Brains and models:**
  - `src/core/models.ts` holds the slot rules (hints `flash` / `top-medium` / `top-high`; the old `pro` maps to `top-high`; `settings.geminiTopFamily` holds the chosen strongest family).
  - `src/main/modelWatcher.ts` reads `agy models` 30 s after start and every 6 h (state in `data/models.json`). Newer models are followed automatically with a notice. **Whenever the list changes**, the other brain's Balanced model (or the brain's own) looks the models up, searching for benchmarks first (`modelAdvice.ts`, `GhostCore.research`), and the line-up is offered in Settings → Brain. Claude Code has no model list, so `claudeModelProbe` asks each short name for one word on the subscription login when Claude Code's version changes and once a week.
  - Brains report the exact model that answered (`ProviderEvent` `model`): shown under each slot, in the reply's label and in conversation notes.
  - `GHOST_EXTRA_MODELS=gemini-4-carbon-high,…` pretends agy offers more models; add `&offer=1` to the preview's Settings address to see a pretend offer.
  - agy's tools since its 11 Nov update: `read_file`, `run_command`, `write_file`, `edit_file`, `search_web`, `manage_task`, `send_message`, `schedule`, `invoke_subagent`, `define_subagent`, `manage_subagents`, `swarm`, `ask_question`, plus `call_mcp_tool`, `list_resources`, `read_resource`. Its `read_file` takes only absolute paths; keep the hook's path check strict.
  - Ghost starts `agy` with `AGY_CLI_DISABLE_AUTO_UPDATE=true` (`'1'` doesn't work): its own updater flashed a terminal window. Settings → Updates runs `claude update` / `agy update` instead.
- **Plan usage figures:** Claude's come free in every stream-json reply as a `rate_limit_event`: `rate_limit_info.unifiedWindows.five_hour` and `.seven_day`, each with `utilization` (0 to 1), `resetsAt` (Unix seconds) and `status`. Gemini's come from `agy -p "/usage" --output-format json` (instant, no tokens): `command.data.groups[]`, each with `buckets[]` of `{ id, name, window: "weekly" | "5h", remaining_fraction, reset_time }`. His groups: "Gemini Models" (`gemini-weekly`, `gemini-5h`), "Gemini 4 Argon" (`gemini-argon-wtu-weekly`) and "Claude and GPT models". agy's status line is no route: headless runs don't start it.
- **Voice:**
  - Edge (`msedge-tts` 2.1.1, the newest; its `npx only-allow pnpm` preinstall is harmless): Microsoft often closes the stream ~2.6 s in, before any audio ("Stream closed before the synthesis completed"), worse with many requests at once. Not Ghost's doing.
  - Settings checks the ElevenLabs key against `/v1/user/subscription` (no credits spent): works / credits used up / rejected / unreachable; a rejected key isn't saved.
  - The overlay waits 8 s for a voice before revealing words silently; `turn_end.silent` shows silent lines at once. The voice-switch notice is yellow, worded per cause (`voiceFallbackNotice`).
  - Bluetooth headsets swallow first words when asleep: a 20 Hz keep-alive tone and a pre-roll after silence (`audio/player.ts`).
- **Google voice (to build):**
  - Chirp 3 HD **Achird** (`en-US-Chirp3-HD-Achird`), through the Ghost filter, with Edge as backup. `POST https://texttospeech.googleapis.com/v1/text:synthesize?key=…` with `{ input: { text }, voice: { languageCode: 'en-US', name }, audioConfig: { audioEncoding: 'MP3' } }`; the reply's `audioContent` is base64. At most 5,000 bytes of text a request; Google bills spaces and newlines too.
  - **It must never cost Aaron money.** The free allowance is 1M Chirp 3 HD characters a month (US$30 per million after). Ghost's meter counts every character sent, per Pacific-time month (resetting on the 1st, with Google's allowance), warns at 80% and 95% of **750,000** (600,000 and 712,500), and at 750,000 switches to Edge and says so. Long replies are spoken in full. Settings' usage section shows the voice's % left and reset date. The count lives in `data/` until his synced vault exists.
  - The project allows **10 requests a minute** (his number): send the first sentence alone so the voice starts quickly, then the rest in groups, pacing under the limit.
  - **The key:** restricted to Text-to-Speech, in project `ghost-companion-680387`, made with `gcloud services api-keys create --display-name="Ghost voice" --api-target=service=texttospeech.googleapis.com --project=ghost-companion-680387` or in the Cloud Console (APIs & Services → Credentials → API key, restricted to "Cloud Text-to-Speech API"). Aaron pastes it into Settings himself; never print it or put it in the repo. Store it like the ElevenLabs key (`src/main/settingsStore.ts`, DPAPI via `safeStorage`; use the async methods), with a check that costs nothing.
  - Suggested order: a `GoogleTts` engine with unit tests (pretend `fetch`), the key box, grouping and pacing, the meter, then let him hear it.
- **Ghost's Google Cloud project:** `ghost-companion-680387` (name "Ghost", number 982929934948) on his billing account `0101A0-6E90DA-5BE729` (he's Billing Admin; currency SGD). Kept separate from Chronos (`calendar-telegram-bot-503313`, his team's Telegram bot): don't touch Chronos; Text-to-Speech is off there.
  - Text-to-Speech is on, limited to 10 requests a minute ("All requests" and Chirp3-HD).
  - Budget "Ghost $0 cap (switches billing off)": SGD 0, this project only, net of free-tier credits only (`INCLUDE_SPECIFIED_CREDITS` + `FREE_TIER`), emails at 100%, reports to Pub/Sub topic `billing-killswitch`.
  - Function `ghost-billing-killswitch` (Cloud Run functions, asia-southeast1, source in `cloud/billing-killswitch/`): on any report with a cost above 0 it unlinks billing from the project. Its service account holds only Project Billing Manager, Run Invoker and Eventarc Event Receiver on this project. Tested 16 Nov: a 0 report changed nothing, an SGD 0.01 report switched billing off within seconds (relinked by hand). Redeploy with the `gcloud functions deploy` line in its commit; publish test reports through the Pub/Sub REST API (PowerShell garbles JSON in `--message`).
  - Its image repository keeps the newest two images. A fraction-of-a-cent storage or build cost could still trip the switch-off one day: that only stops Ghost's Google voice (Edge takes over); billing is relinked by hand.
  - Built-in spend caps don't cover Text-to-Speech (only Gemini API, Agent Platform, Cloud Run and Cloud Run functions), hence the function. His billing account also has a "$0 Monthly Budget Alert" over every project and a "Chronos Spend Cap".
- **Recording:** Electron 45's GPU H.264 encoder writes no picture, so Ghost starts with `disable-accelerated-video-encode`. MediaRecorder writes fragmented MP4 with no total length; `src/main/mp4Duration.ts` writes the length into the header after saving. `src/main/captureFiles.ts` allows previews only of .png/.jpg/.mp4/.webm in the capture folders.
- **Electron 45 changes:** screenshots use `ClipboardItem`; the recorder's session allows `display-capture`; `roundedCorners: false` on the overlay; npm `allowScripts` for the install scripts.
- **Click-through and grabbing** (`src/main/inputNative.ts`, user32 via koffi): Ghost brightens only once grabbable (after "Hover before Ghost can be grabbed", 0.6 s); a zero-pixel mouse nudge makes the first click land (Windows re-hit-tests only on movement); Alt is read from Windows.
- **Fullscreen games:** `shouldHide` also hides in games mode when the window in front covers its monitor and `looksLikeGame` (engine window class or game-library folder). Seen working over TFT (borderless, an `UnrealWindow`) and Dying Light 2. He has no second monitor.
- **Chat stack placement:** it centres on a free-floating Ghost when it fits (`orientationForShell`); free positions are saved as the shell's own spot (`customPosition.anchor: 'shell'`) so Ghost never jumps.
- **Updater:** counts commits on this PC that aren't pushed ("(on this PC only)") as well as GitHub's; a running old installer is moved aside and deleted on the next build; one held open stops the build with a plain message.
- **Memory recall** ignores chat filler, uses the previous message for short follow-ups, and labels memories as background.
- `npm audit`: 0 known vulnerabilities in what ships; six moderate ones in minimatch under electron-builder (build tool only).
