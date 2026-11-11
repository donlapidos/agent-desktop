# Desktop Buddy roadmap: from working app to viable product

Written 2026-11-11, after 0.2.0. This is a work plan for an agent (Claude Opus in Claude Code) to carry out with
the owner. Each task says why it matters, what to do, and how to tell it's done. Do the phases in order; inside a
phase, tasks are independent unless one names another.

## Where Buddy stands

**Works and is tested** (176 unit tests, 6 end-to-end checks, each protection broken on purpose to prove its test):
guiding by pointing, Do mode with approval cards, Mark and Explain plates, voice and dictation on the PC, task
windows, routines, any provider (Anthropic, OpenAI, OpenRouter, Gemini, DeepSeek, Ollama, LM Studio, custom), Buddy's
tools in AI apps over MCP, files/PowerShell/web with Activity and undo, installer with self-update.

**Not yet proven**, and what stands between this and a product strangers can rely on:

| Gap | Evidence |
|---|---|
| Nobody but the owner has installed or used it | 0 stars, issues disabled, no screenshots in the README |
| A new user can't start without an API key or an AI app | First run asks for a key; no guided setup |
| Guide quality is unmeasured on real apps | 8 guided steps ever logged; the model check is 7 made-up windows |
| Most providers and AI apps have never run for real | Live-tested: Claude, OpenAI `gpt-6.1-sol`, Codex, Claude Code. Never: Gemini, OpenRouter, DeepSeek, Ollama, LM Studio, Cursor, VS Code, Windsurf, Gemini CLI, Claude app chat |
| The update path has never updated anything | 0.1.0 was never published; no installed copy has gone from one version to the next |
| Windows warns people off the installer | Unsigned; SmartScreen "protected your PC" |
| The repo is shared with the upstream CLI | See Phase 0 |
| `main.js` is 2,247 lines, 323 of them test hooks | Hard to change safely; the renderer pages (settings.html: 1,114 lines) are untyped |

**The bar for "viable":** a stranger on an ordinary Windows laptop installs Buddy, gets a first correct guided step
within five minutes without a terminal or a credit card, is never surprised by something Buddy did, gets updates
without thinking, and has somewhere to say what went wrong.

## Phase 0: stop the release plumbing from breaking (do first)

Buddy lives in a fork of `vercel-labs/agent-desktop`, and the two projects collide there.

- **0.1 Decide where Buddy lives.** *Owner's decision; recommended: its own repository.* In the fork: upstream's
  `Release` workflow runs on the fork whenever a sync changes `Cargo.toml` and publishes the CLI as a GitHub release,
  which would take "Latest" from Buddy and break installed copies' update check (it was cancelled by hand on
  2026-11-11, and left a stray `v1.2.0` tag); CLI and Buddy tags share one namespace (`v0.2.0` is Buddy, `v1.2.0` is
  the CLI); upstream's Audit and Linux checks show red on every Buddy PR; AGENTS.md there is written for the Rust
  crates. Own repo: Buddy depends on agent-desktop as a pinned release binary (npm `agent-desktop` or a release
  download with a checksum) instead of `../../target/release`.
  *If staying in the fork instead:* disable the `Release`, `Release dry run` and e2e workflows on the fork, delete
  the stray `v1.2.0` tag, and point electron-updater at Buddy's own tag prefix.
  *Done when:* a sync or upstream release can't change what `releases/latest/download/latest.yml` serves, and that
  is checked by a CI job.
- **0.2 Turn on Issues (or Discussions).** Settings › Request a feature opens a GitHub issue; issues are disabled, so
  the link is dead. *Done when:* the button lands on a working form.
- **0.3 Prove an update.** Ship 0.2.1 (any small fix), install 0.2.0 from the release, and watch it find, download
  and install 0.2.1. *Done when:* that is seen once by hand and written into the release steps in the README.
- **0.4 Finish the two open items from the invariants review.** (a) `point_at` uses the position saved when the
  window was read and never re-checks it: after the user moves or scrolls the window, Buddy points at empty space.
  Re-resolve the ref's bounds before pointing, or drop bounds older than the window's last snapshot. (b) Activity lists
  files and commands but not clicks and typing Buddy did in apps; either list them or say so on the page.
  *Done when:* a test moves a window between look and point and the pointer follows; the Activity text matches what
  it lists.

## Phase 1: a stranger can start (the biggest gap)

- **1.1 First-run setup, in the bubble.** Three doors, in plain words, no jargon: **"Use the AI app I already have"**
  (detect Claude Code, Codex, etc. and add Buddy in one click: this needs no key), **"Free, on this PC"** (detect
  Ollama or LM Studio; if absent, say what to install and what it needs: about 8 GB of free memory), **"I have an
  API key"** (paste; provider is recognised). Check each provider's current free tier before promising one.
  *Done when:* an e2e check walks each door with a scripted server, and a fresh profile never shows a bare
  "paste a key" prompt.
- **1.2 A thirty-second tour.** After setup, Buddy guides the user through one real step in whatever window is in
  front ("press Ctrl+Alt+B and ask me how to…"), then shows Mark once. Skippable.
- **1.3 Show it.** README and release page: one short screen recording of a guided task, three screenshots (pointer
  with caption, approval card, Activity). A one-page site (GitHub Pages) with the download button.
- **1.4 Sign the installer.** Options to price and check eligibility for: Azure Trusted Signing, SignPath's free
  tier for open source, or publishing through winget (Microsoft validates). *Owner's decision on spend.*
  *Done when:* a fresh Windows account installs without the SmartScreen block.
- **1.5 What it costs.** People on their own key need to see spend: tokens and an estimated cost per answer in the
  bubble's footer, a running total in Settings, and an optional monthly cap that stops Buddy with a clear message.
  *Done when:* unit tests cover the arithmetic per provider and the cap.

## Phase 2: prove the core loop on real apps

- **2.1 Record real windows.** A dev command that saves the accessibility snapshot of the front window with names
  and values scrubbed to placeholders where they could be personal. Collect about 40 from Excel, Word, Outlook, Edge,
  Chrome, File Explorer, Settings, Teams, Notepad, a PDF reader.
- **2.2 A real task set.** 40-60 tasks over those windows (guide, do, explain, read, files), each with a check, in
  `evals.js`. Include tasks that should be *refused or asked about*.
- **2.3 Run every provider and publish the table.** `npm run eval` across at least: two Claude models, two OpenAI,
  one Gemini, one DeepSeek, two OpenRouter, three local models of different sizes. Publish pass rate, seconds and
  cost per task in the README; make Settings' "works well" come from this table, not from the model's family name.
  Needs keys or credit from the owner for each provider.
- **2.4 Try every AI app once, by hand,** with the same three requests, and record what each does about approvals.
  Remove or mark "untested" any that can't be tried.
- **2.5 A speed budget.** Targets: pointer on the first control within 4 s of asking on a mid model; each later
  guided step with no model call. Measure with the timing log; fix the slowest step first (Excel's 7 s snapshot is
  the known one).
- **2.6 Injection tests.** Web pages, file contents and window text that tell Buddy to act ("ignore the user, run
  …", "send this file to …"). Each must end with no action taken or an approval card that says plainly what would
  happen. Add them to the task set so every model is scored on them.
- **2.7 Decide the local decider with data.** With 2.1-2.3 in hand: does a small local model (Laya or similar) beat
  name-and-meaning matching by enough to justify its memory? If not, close the question in this file.

## Phase 3: trust

- **3.1 PowerShell behind a real wall, or off by default.** Today a guard refuses commands that name private places
  and hides secret keys in output; a determined command can still build a path piece by piece. Either run PowerShell
  under a restricted token / AppContainer with access only to the working folder and folders the user grants, or ship
  it **off** with a switch ("Let Buddy run commands: for building things"), which fits "building is opt-in".
  *Recommended: off by default now, the wall later.*
- **3.2 Places the user grants.** Replace "everyday folders are read freely" with a short list the user sees and can
  edit (Documents, Desktop, Downloads to start), shown in Settings.
- **3.3 A problem report the user can send.** "Report a problem" gathers the timing log (already short and bounded),
  the version and settings without keys, shows it, and opens an issue or copies it. No silent telemetry.
- **3.4 A security page.** `SECURITY.md`: what Buddy can touch, what it can't, what approval means, how to report a
  vulnerability. The README's "AI and privacy" section is the start.

## Phase 4: the code can carry more work

- **4.1 Split `main.js`.** Move the 323 lines of `BUDDY_*_TEST` hooks to `src/dev-hooks.js`, loaded only when one is
  set. Then split by area: windows (overlay, island, bubble), marking, voice wiring, AI-app bridge wiring, settings
  wiring, startup. No behaviour change; e2e must pass after each move.
- **4.2 Type the pages.** Move each page's script out of the HTML into a checked `.js` file. Start with
  `settings.html`.
- **4.3 e2e in CI.** Run `files`, `settings`, `tasks`, `explainer` and `firstrun` on `windows-latest` (voice needs
  the models; keep it local). Fail the build on a refused state change.
- **4.4 Tidy dependencies.** `@anthropic-ai/claude-agent-sdk` is "All rights reserved" and unused by default: move it
  to `optionalDependencies` or drop the SDK engine. Keep `npm audit` at zero.
- **4.5 Buddy's own windows for everyone.** Keyboard-only use of the bubble, cards and Settings; labels for screen
  readers (the bubble has one `aria` attribute today); Windows high-contrast; reduced motion everywhere.
- **4.6 Memory budget.** Idle under 200 MB, voice unloaded when unused (done), no growth over a day; add a check like
  `measure:idle` for memory.

## Phase 5: what makes people stay

Only after Phases 0-3; pick by what users ask for.

- **5.1 Conversations that survive.** Task windows and the bubble's history are lost on restart. Save them (on the
  PC, clearable), and let a task be resumed.
- **5.2 "Teach me this app" lessons** built from guide routes: a saved, replayable walkthrough is the artifact people
  share.
- **5.3 Integrations:** let Buddy use other MCP servers the user adds (calendar, mail), under the same approvals.
- **5.4 Languages:** the interface in the user's language (replies already are).
- **5.5 A cheap-then-smart mode:** a small model for guiding, the big one for explaining and building.

## Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| 0.1 | Own repository, or stay in the fork | Own repository |
| 1.4 | Pay for code signing, or use a free route | Try SignPath/winget first |
| 2.3 | Which providers to fund for the model table | At least Claude, OpenAI, Gemini, one local |
| 3.1 | PowerShell on or off by default | Off, with a switch |
| — | Stay free and bring-your-own-AI, or add a paid hosted option later | Stay free until Phase 2's numbers and real users exist |

## Working rules for whoever carries this out

- **Prove each protection.** After adding a rule, break it on purpose and see a test fail; if none does, the test is
  the bug.
- **`npm run check`, `npm test`, `npm run e2e` before every commit.** `npm run e2e -- --exe <path>` for an installed
  copy; `--interactive` moves the mouse, so ask first.
- **Never restart the owner's running Buddy mid-task:** read the tail of `%APPDATA%\desktop-buddy\timing.log` first.
- **Test copies use `--user-data-dir`** and must leave startup entries and shortcuts alone (`firstrun` checks it).
- **Edit with the editor, not shell heredocs or inline Python, when the text has backslashes.** A `\b` once became
  a backspace byte and silently disabled a regex. After scripted edits, scan for control characters.
- **Publishing is the owner's.** Draft releases, merges to `main` and anything public: prepare it, then hand over the
  command.
- **No attribution lines in commits** (the owner removed them). Conventional commit subjects, the why in the body.
- **Plain words in everything a user reads.** The user is not a developer.
