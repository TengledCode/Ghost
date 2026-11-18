# Running Ghost from source on Aaron's laptop: issues met (18 Nov 2026)

Aaron set up Ghost on his Windows laptop (Windows 11 Pro Education, build 26300) on 18 Nov 2026, to run it from source with `npm run dev` while the home PC keeps the installed copy. It took far longer than it should have. This file records every problem met, what it looked like, what caused it, and how it was fixed, so a later session (on the laptop or on a new machine) can recognise them quickly. Read CLAUDE.md first; this file only covers setup.

The laptop at the time: Node.js 26.13.1, npm 11.20.0, Git 2.56.0.windows.4, Claude Code 2.1.327, Antigravity (`agy`) 1.5.9.

## Quick checklist for a new machine

Do these in order; each line links to the issue below that it prevents.

1. Put the repo where it will stay **before** `npm install`, and never move it with Explorer afterwards (issue 5). The location doesn't matter to Ghost.
2. `npm install`, then check `node_modules\electron\dist\electron.exe` exists; if not, `node node_modules/electron/install.js` (issue 1).
3. In Aaron's own PowerShell, use `npm.cmd` instead of `npm` unless the script policy allows scripts (issue 2).
4. Start the mock with `$env:GHOST_PROVIDER='mock'; npm.cmd run dev`, then start the real brains in a **new** window (issue 3).
5. After the real start, check the reply's model label (or the newest `%APPDATA%\Ghost\data\conversations\*.jsonl`, field `provider`): if the primary is Claude but the reply says Gemini, Claude failed silently (issue 4).

## 1. Electron's program was never downloaded

- **Seen:** after a successful `npm install`, `npm run build` and the tests, Aaron's `npm run dev` showed nothing working. There was no `%APPDATA%\Ghost` folder at all, so no `ghost.log`: Ghost had never got as far as starting its main process.
- **Cause:** `node_modules\electron\dist\electron.exe` and `node_modules\electron\path.txt` were missing. The `electron` package downloads its binary in its own install script (`install.js`). It didn't run, or failed silently, during `npm install`. Why is still unknown: `package.json`'s `allowScripts` has `"electron": true`, and `npm config get ignore-scripts` was `false`. It may be npm 11's handling of install scripts on a first install. The build and the tests don't need the binary, so they passed and hid the problem.
- **Fix:** `node node_modules/electron/install.js` (exit 0, `path.txt` then says `electron.exe`). After that, Ghost started.
- **Check for it:** `Test-Path node_modules\electron\dist\electron.exe`. A later `npm install` in the moved folder kept the binary.

## 2. PowerShell blocks `npm` (script policy)

- **Seen:** likely part of the same failed first start; Aaron didn't paste the error text, so this was inferred rather than seen.
- **Cause:** `Get-ExecutionPolicy -List` showed every scope `Undefined`, so Windows' client default (Restricted) applies. Typing `npm` in PowerShell runs `npm.ps1`, which Restricted refuses ("running scripts is disabled on this system").
- **A trap for Claude:** Claude Code's own PowerShell tool runs with `Process: Bypass`, so `npm` works there and the problem is invisible from Claude's side. Always check `Get-ExecutionPolicy -List` rather than trusting that npm works in Claude's shell.
- **Fix:** Aaron uses `npm.cmd run dev`. The alternative, `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, changes a security setting, so it's Aaron's to run, not Claude's. After issues 1 and 2 were addressed, the mock run worked.

## 3. The "real" run was still the mock

- **Seen:** Ghost replied "This is the offline mock, so no subscription usage was spent."
- **Cause:** `$env:GHOST_PROVIDER='mock'` lasts until that PowerShell window closes, and Aaron started the real run in the same window. `src/main/index.ts` uses the mock when `process.env.GHOST_PROVIDER === 'mock'` **or** `settings().provider === 'mock'`. His `settings.json` said `provider: claude`, `fallbackProvider: gemini`, and no user or machine variable was set, so the window's variable was the only source.
- **Fix:** close the window and open a new one, or run `Remove-Item Env:GHOST_PROVIDER` before `npm.cmd run dev`.

## 4. Claude failed silently and Gemini answered

- **Seen:** Aaron said Claude didn't respond. Ghost did answer the weather question correctly, but the conversation file showed `"provider":"gemini","model":"gemini-3.8-flash-medium"`: Claude had failed and Ghost fell back. **Nothing in `ghost.log` said why**, and the model probe in the same minute ("Claude's subscription includes haiku, sonnet, opus") showed the `claude` CLI itself worked.
- **Cause:** the half-done folder move (issue 5). At every start Ghost writes `%APPDATA%\Ghost\data\ghost-mcp.json`, which tells the CLIs to run the tool relay from the repo: `<repo>\node_modules\electron\dist\electron.exe <repo>\out\main\mcpServer.js`. The move had taken `out\` and `node_modules\` away from `Desktop\Ghost`, so Claude's live session couldn't start its MCP server. Gemini's web search is agy's own tool, so Gemini still answered.
- **Fix:** finish the move and rebuild in the new folder (issue 5). `ghost-mcp.json` is rewritten with the new path at the next start.
- **Worth improving (not done, ask Aaron):** a brain failing and falling back left no reason in `ghost.log`. Logging the primary's error when Ghost falls back would have found this at once.

## 5. Moving the repo with File Explorer split it in two

- **Why it was moved:** Aaron thought the Ghost folder had to sit inside `Desktop\Playground`, "where Claude operates", for Claude to answer. **That's not so:** Ghost's brains run in Ghost's own folder, `%APPDATA%\Ghost\data\workspace`, wherever the code is. A Claude Code session can also be pointed at any folder. The code can live anywhere, as long as it's all in one place. He chose to keep it in Playground.
- **Seen:** dragging `Desktop\Ghost` into `Desktop\Playground` in Explorer failed with a message that git was open.
- **What actually happened:** Explorer had moved almost everything (about 16,000 files, `node_modules` included) into `Desktop\Playground\Ghost`, but `.git` stayed behind in `Desktop\Ghost`. `git status` in the old folder showed every file as deleted, and the new folder wasn't a repo. Nothing was lost: every file was in git or in the new copy, and nothing was uncommitted.
- **Fix:**
  1. Checked that no process had either folder open (`Win32_Process` command lines).
  2. `Move-Item .git` into `Playground\Ghost`. It copied everything but then failed to delete the source folders ("insufficient access rights"): git keeps object files read-only, and Claude's shell had its working folder there.
  3. Checked the new copy: `git status` clean and level with `origin`, `git fsck --connectivity-only` exit 0, the same single branch (`claude/bold-planck-b1n6bl` at `905ec70`).
  4. Switched the Claude session to the new folder, then `npm install` and `npm run build` there.
  5. The old `.git` turned out to hold no files, only empty folders. They were removed, but the empty `Desktop\Ghost` folder itself was "in use by another process" (probably Explorer or the Claude app, which had the session's old working folder). Aaron can delete it once nothing holds it.
- **Lesson:** don't move a working repo with Explorer while git, an editor, a Claude session or Ghost has it open. If it must move: quit Ghost, close editors and shells in it, move it whole, then `npm install` and `npm run build` in the new place (`out\` and `ghost-mcp.json` hold absolute paths).

## 6. Playground is a cloud-synced folder

- **Seen:** `Desktop\Playground` and its folders carry the attribute `0x80000` (Pinned, a cloud-files attribute), and some folders (for example `src`) are also reparse points (`0x400`). So some sync tool appears to manage Playground; which one wasn't checked.
- **Why it matters:** `node_modules` (about 16,000 files) and `out\` would be synced too, which is slow and pointless, and a sync client holding files open can make moves and deletes fail like issue 5. If syncing causes trouble, exclude `node_modules`, `out` and `dist` in that tool, or keep the repo outside Playground.

## 7. One test fails on this laptop only

- **Test:** `tests/antigravity.test.ts`, "stops a reply by ending agy, then carries on in the same conversation". It fails every run here (also run alone); the other 278 tests pass and 3 are skipped.
- **Failure:** expected `[gemini-3.8-flash-high] next`, got the same reply with `<recent_conversation>\nAaron: hi\n</recent_conversation>` in front.
- **Likely cause (not proven):** the test cancels the "slow one" message 300 ms after sending it and assumes the fake agy (`tests/fixtures/fake-agy.mjs`, started through a `.cmd` shim from `tests/fakeCli.ts`) has sent its `init` by then. On this laptop the fake takes about 140-270 ms just to start, more under load. If the cancel arrives first, `AntigravityProvider.send` returns before sending (the "cancelled while agy is starting" path), the agy process stays alive with `fresh = true`, and the next message rightly includes the history. So the provider looks right; the test's timing is too tight for slower machines.
- **Not changed:** Aaron's rule is no code changes to make tests pass without asking. A possible fix is to cancel only after `init` has arrived (or after the first `step_update`), instead of a fixed 300 ms.

## 8. Smaller things noticed

- **`npm audit`:** 13 vulnerabilities (5 moderate, 8 high) in dev and build tools, 0 in what ships (`npm audit --omit=dev`). As well as the known minimatch ones under electron-builder, picomatch now has a high-rated one, under vitest and the build tools. CLAUDE.md's "six moderate" line is out of date.
- **Build warnings:** `npm run build` prints that `../shipnotes/voice-orb.js` and `signal-orb.js` "can't be bundled without type=module". That's expected: the vendored orb scripts are loaded as plain files.
- **Checking sign-ins from Claude's shell:** Claude's shell has `CLAUDE_*` variables. Strip `ANTHROPIC_*` and `CLAUDE_*` before `claude auth status` so it reports the real subscription login. Both CLIs were already signed in on the laptop: `claude` on the claude.ai login with **subscriptionType `pro`**, and `agy -p "/usage" --output-format json` (from PowerShell, never Git Bash) answered at once.
- **Pro plan on the laptop:** the laptop's model probe found only haiku, sonnet and opus (`claude-*-5-5`), no Fable. `data/models.json` and the model offers are per machine, so the laptop and the PC can legitimately differ.
- **Voice:** no ElevenLabs key on the laptop (keys are DPAPI-encrypted per PC), so the log shows "ElevenLabs failed, using Edge … No ElevenLabs key configured" at each start. That's expected.
- **Startup log lines not looked into:** "overlay health not visible" 5 s after the first start, and one "hidden: a fullscreen app is in front (code 2)" a minute later, shown again 8 s after. Probably harmless (something fullscreen briefly, or the first window not yet painted), but not checked.
- **Starting Ghost:** always in Aaron's own PowerShell window, never from Claude's shell or the Claude app's terminal panel, which inherit variables that once signed `claude` out of the subscription (CLAUDE.md, "Start test copies with a clean environment").

## 9. Git can't commit or push on a fresh laptop

- **Seen:** the first commit on the laptop failed with "Author identity unknown … Cannot prompt because user interactivity has been disabled", and `git push` failed with "could not read Username for 'https://github.com': terminal prompts disabled".
- **Cause:** a fresh Git install has no `user.name` / `user.email`, and the laptop had never signed in to GitHub. Git's credential helper is Git Credential Manager (`credential.helper=manager`, from `C:/Program Files/Git/etc/gitconfig`), which signs in through a browser window, but only from a terminal it can prompt in. Claude's shell can't prompt, so Claude can never do the first sign-in. `gh` isn't installed.
- **Fix:** set the identity the PC's commits use (`TengledCode`, the same email as on the PC) with `git config user.name` / `user.email`, in the repo or with `--global`. Aaron's call. Then Aaron runs `git push origin claude/bold-planck-b1n6bl` once in his own PowerShell window; Git Credential Manager opens the GitHub sign-in and remembers it, and after that Claude's pushes work.
- **Commit messages from PowerShell 5.1:** `Set-Content -Encoding utf8` writes a byte-order mark, which ends up as an invisible first character of the commit message. Write the `git commit -F` file with `[IO.File]::WriteAllText(path, text, (New-Object Text.UTF8Encoding $false))` instead.

## Status at the end of 18 Nov

- The mock run works on the laptop.
- The real run after the move is **not yet tried**: Claude answering from `Desktop\Playground\Ghost` is the first check next time.
- No code was changed that day; only this file and a pointer in CLAUDE.md were added.
