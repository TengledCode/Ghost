# Setting up Ghost on Windows

## 1. Prerequisites

1. **Node.js 20 or newer:** <https://nodejs.org> (LTS installer).
2. **Claude Code CLI**, logged in with your subscription:
   ```powershell
   npm install -g @anthropic-ai/claude-code
   claude            # choose "Claude account with subscription", finish the browser login, then /exit
   claude auth status   # should say loggedIn: true
   ```
   Ghost never asks for an API key. If `claude` asks you to choose, pick the subscription login, not "API key".
3. **Gemini CLI (optional fallback):**
   ```powershell
   npm install -g @google/gemini-cli
   gemini            # choose "Login with Google", then /quit
   ```
4. **ElevenLabs (optional, free):** create a free account at elevenlabs.io → Profile → **API keys**, then paste the key into Ghost's settings. Without it, Ghost uses Edge voices, which are free with no key.

## 2. Run it

```powershell
git clone https://github.com/TengledCode/Ghost
cd Ghost
npm install
npm run dev
```

Ghost appears at the bottom right. Press **Ctrl+Space** (or click the shell) and type.

To install it properly, so it **starts with Windows**:

```powershell
npm run dist:win     # creates dist\Ghost Setup 0.1.0.exe
```

Run the installer. "Start with Windows" is on by default (settings → Behaviour). Login-start only applies to the installed app, not `npm run dev`.

## 3. Pick your voice

Open settings (right-click the shell, the ⚙ button, or the tray icon), go to **Voice**, and press **Preview** on each voice. The eye pulses and the Ghost filter applies, just like a real reply. Choose one ElevenLabs voice and one Edge fallback voice, then tune the **Ghost filter** slider: around 30–45 % gives a subtle synthetic shimmer, and 100 % is fully robotic.

The ElevenLabs free tier gives about 20 minutes of speech a month. When it runs out, or you're offline, Ghost switches to Edge by itself and tells you in a small notice.

## 4. Things to try

| Say | What happens |
|---|---|
| `open spotify` | Launches it (no confirm). Routed to Haiku. |
| `search for the weather in Singapore tomorrow` | The shell opens and scans while it searches the web. |
| `remind me in 20 minutes to stretch` | Speaks the reminder when it's due, even over a fullscreen game |
| `remember that my sister's birthday is 4 March` | Stored in long-term memory |
| `think hard about the best way to structure my week` | Routed to Opus |
| `clean up my Downloads folder` | Shows a confirm card before any file is touched |
| `/new` | Starts a fresh conversation |
| `Esc` while it talks | Stops it |

## 5. Where things live

`%APPDATA%\Ghost\`: `settings.json`, `secrets.json` (ElevenLabs key, encrypted with your Windows login), and `data\` (`memory.json`, `reminders.json`, and the CLI working folder). Delete `data\memory.json` to wipe Ghost's memory.

## 6. Troubleshooting

- **"I can't find the claude command-line tool"**: open a *new* terminal and run `where claude`. If nothing shows, reinstall the CLI and restart Ghost.
- **"I'm signed out"**: run `claude` in a terminal and log in again.
- **"I've reached the usage limit"**: your plan's window is used up. Ghost tries Gemini automatically if it's set as the fallback.
- **The hotkey does nothing**: another app owns `Ctrl+Space` (some IMEs do). Pick another in settings → Behaviour.
- **Ghost doesn't hide in a game**: detection uses Windows' own "fullscreen app" signal. Borderless-windowed games don't always raise it.

## 7. Manual test checklist (things only a real Windows PC can verify)

- [ ] Installed app starts at login, with the tray icon present
- [ ] Ctrl+Space opens the input bar with focus, and Esc closes it
- [ ] Reply is spoken through the Ghost filter, and the shards open and close with the voice like a mouth
- [ ] Ghost turns to follow the cursor anywhere on screen (including other monitors), with a short soft beam from its eye
- [ ] The glow and unfolded shards are never clipped at the window edge, and the glow blends over your wallpaper with no dark box
- [ ] Clicking the shell gives a little boop and opens the input; saying thanks gets a happy spin; after 5 minutes idle it dozes, and moving the cursor near wakes it
- [ ] Task Manager → GPU: Ghost stays light while idle (it caps itself at 30 fps after 30 s); settings → Look → Render quality lowers it further
- [ ] Idle shell is click-through; a brief hover or Alt makes it grabbable; drag and snap to each corner; free position is remembered after a restart
- [ ] `open notepad` runs without asking; `delete C:\temp\x.txt` shows the confirm card
- [ ] A reminder fires while Destiny 2 is fullscreen: the shell stays hidden and the voice is heard
- [ ] With a bad ElevenLabs key, it falls back to Edge with a notice
- [ ] Setting Primary to Gemini answers and can use the Ghost tools
- [ ] A second monitor: drag Ghost there and restart; it stays there
- [ ] Dragging follows the cursor exactly (no drift or "shooting off"); dropping near an edge sticks Ghost to it, near a corner snaps it into the corner, and it never ends up partly off-screen, on either monitor
- [ ] Quit: Settings → Behaviour → Quit Ghost, or Ctrl+Alt+Q (changeable), or the tray menu
- [ ] Idle: leave Ghost untouched a few seconds (or click elsewhere) and Ghost plus its text boxes fade to the Idle opacity setting; hovering or Ctrl+Space brings them straight back
- [ ] Memory: have a short chat, quit, start Ghost again and ask a follow-up; it still knows the context. Ask "what did we talk about yesterday?" a day later
- [ ] Live screen view: Ctrl+Alt+V (or type "watch my screen") shows a red LIVE tag and a magenta eye; ask "what's this error?" and it describes the monitor under your cursor; Ghost itself isn't in what it sees; "stop watching" turns it off
- [ ] Live view auto-off: enable it in Settings → Live screen view, set a short time, and check it switches off (and says so) after that long without a message
- [ ] No grey shadow or box around the text boxes on a light wallpaper
- [ ] Replies appear word by word as they're spoken, not ahead of the voice
- [ ] After 10+ s of silence, the first word of a reply is heard in full (if not, set Settings → Voice → Keep audio awake to "Always")
- [ ] Clicking into another app fades Ghost and its text box straight away; moving the cursor off it fades them after a few seconds
- [ ] Startup: the shards fly in and lock around the eye, then Ghost greets you out loud (a different line each launch; "Back so soon?" after a quick restart)
- [ ] Replies start with the answer: no "Very good" / "Certainly, Aaron." openers, and no "Noted." while it thinks
- [ ] Bluetooth: Settings → Voice → Test first word, stay quiet, and "one" is heard in full; no hum from the keep-alive tone
- [ ] Settings → Brain → Show reply timings: the bubble shows "text · voice · heard" times. The second message of a session answers noticeably faster than a cold start used to
- [ ] Provider switch: if Claude hits its limit, Ghost says so once, answers with Gemini, and shows an amber "on Gemini · Claude limit reached" chip until Claude is back
