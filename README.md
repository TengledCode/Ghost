# Ghost

A floating personal AI companion for Windows. Ghost lives in a corner of your screen as an animated shell with a glowing particle eye. You type to it, it answers out loud, and it can act on your PC: open apps, search the web, set reminders, remember things about you, and (with your one-click approval) run commands or change files.

It runs on **your existing subscriptions, not API keys.** Ghost drives the official **Claude Code CLI** (Claude Pro/Max) and the **Gemini CLI** (Google account) in the background, so usage counts against the same plan limits you already have.

![states](docs/states.png)

## Highlights

- **Subscription-powered brain.** Claude is the primary backend and Gemini the fallback, with automatic model routing: Haiku for quick things, Sonnet by default, Opus when you say "think hard". Conversations continue across messages, and a fresh one starts after 2 hours of quiet.
- **A voice with a Ghost feel.** It uses the ElevenLabs free tier and falls back automatically to free Edge neural voices. A soundalike stock voice goes through an adjustable *Ghost filter* (metallic resonance, shimmer, chorus). No voice cloning.
- **Original companion shell.** Faceted plates and blades (Three.js) surround the particle eye. The eye is [Voice Orb / Signal Orb](https://github.com/aqualang89/shipnotes-components) (MIT) and pulses with the voice. There are states for idle, typing, thinking, searching, speaking, done, awaiting approval and error, five colour themes plus a custom one, and a "classic orb" skin.
- **Stays out of the way.** Click-through when idle, corner snap or free drag across monitors, size and opacity sliders, auto-hide over fullscreen games (voice and reminders keep working), a `Ctrl+Space` summon hotkey, and start at login.
- **Safe by default.** Opening apps, URLs, searching, reminders and memory run instantly. Running commands, writing, deleting or closing apps shows a confirm card (auto-denied after 60 s).
- **Ready for a phone later.** The brain (core) and the UI talk over a token-protected local WebSocket, so a phone client can later speak the same protocol (see `src/shared/protocol.ts`).

## Quick start (Windows)

See **[docs/SETUP.md](docs/SETUP.md)** for the full walkthrough. In short:

```powershell
npm install -g @anthropic-ai/claude-code   # then run `claude` once and log in with your Pro/Max account
npm install -g @google/gemini-cli          # optional fallback: run `gemini` once, choose "Login with Google"
git clone https://github.com/TengledCode/Ghost; cd Ghost
npm install
npm run dev                                # or: npm run dist:win for an installer
```

## Architecture

```
Electron main ─┬─ Overlay window (transparent, always on top)  ── src/renderer/overlay
               ├─ Settings window                               ── src/renderer/settings
               ├─ Tray · hotkey · login item · fullscreen watcher
               └─ Ghost core (ws://127.0.0.1, token)             ── src/core
                    ├─ providers/  claude -p … | gemini … (stream-json)
                    ├─ router · persona · memory · reminders
                    ├─ approvals (confirm-risky policy)
                    ├─ tools/  ← MCP bridge (stdio) launched by the CLI
                    └─ tts/    ElevenLabs → Edge fallback, sentence-streamed
```

Every side effect goes through Ghost's own MCP tools (`src/core/tools`), never the CLIs' built-in shell or write tools, so the approval policy is the same whichever model is answering.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Run the Electron app with hot reload |
| `npm test` | Unit and integration tests (vitest) |
| `npm run typecheck` | TypeScript |
| `npm run build` | Bundle into `out/` |
| `npm run preview:ui` | Run the overlay in a normal browser against an offline mock core |
| `GHOST_PROVIDER=mock npm run dev` | Full app with the mock brain (no subscription usage) |
| `GHOST_LIVE=1 npx vitest run tests/claude.live.test.ts` | One real Claude round trip through the MCP bridge (after `npm run build`) |

The persona lives in `config/persona.md`. Edit it freely: `{{user}}` and `{{assistant}}` are filled from settings.

## Credits

Voice Orb and Signal Orb by [Ship Notes](https://github.com/aqualang89/shipnotes-components), MIT licensed (`vendor/shipnotes/LICENSE`). The shell design is original; it is inspired by, but not copied from, any game asset.
