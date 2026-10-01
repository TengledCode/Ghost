# Ghost: notes for Claude Code

Handoff from the cloud sessions that built Ghost, so a local session can carry straight on. Read this first, then `README.md` and `docs/SETUP.md`.

## Who and how

- **Aaron** (use they/them) builds and uses Ghost on a Windows PC. Repo: `C:\Users\AaronTengRyzen\Ghost`, branch `claude/bold-planck-b1n6bl`.
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
- **Compatible drawing mode was removed.** Starting Chromium without DirectComposition and GPU compositing froze Ghost on Windows. Don't retry that path.
- **The Photos blink** (Ghost vanishes for ~2 frames as Photos closes) is Windows dropping the frame. Aaron agreed it's not worth more risky attempts.
- **Watch mode** (Ghost watching and commenting, via Gemini Flash check-ins about every 60 s at 1 fps) is designed but Aaron said "not yet".

## Not yet verified on real Windows

These were built in a Linux cloud container and tested there with Electron under Xvfb. Check each on Aaron's PC:

1. **Ghost absent from screenshots and recordings** (`setContentProtection` → WDA_EXCLUDEFROMCAPTURE): say "take a screenshot" and "record my screen". Ghost must not appear in either, but stays visible on screen.
2. **PC sound in recordings** (desktop loopback in `src/renderer/recorder/main.ts`): play a video while recording; the MP4 should have its sound.
3. **Recording format:** the recorder picks H.264/AAC MP4 if supported, else VP9/Opus MP4. Check which one `ghost.log` reports ("recording started"), and that the file plays in Media Player with the full length.
4. **Mic toggle:** without a mic, a notice says so and recording continues. Once Aaron has a mic, his voice should be mixed in from the moment he toggles it.
5. **Sandboxed preload in the packaged app:** overlay, Settings and the recorder all work after `npm run dist:win`.
6. **File reads with both brains:**
   - live view or "what's on my screen?" still works, with the model seeing the image via `read_file`;
   - "read C:\Users\…\AppData\…\something.txt" shows a confirm card.
7. **Antigravity hook on Windows paths:** with Gemini as primary, reading a file in Documents works without a card. Reading outside the safe folders is refused by the hook, and the model uses `read_file` (confirm) instead.
8. **Updater:** a locked old installer in `dist\` is moved aside (`scripts/clear-old-installers.mjs`), and update failures name the real error.
