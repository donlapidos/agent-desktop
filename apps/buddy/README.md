# Desktop Buddy

A Clicky-style desktop assistant for Windows, built on [agent-desktop](../../README.md).
Press **Ctrl+Alt+B** anywhere and ask a question about the app in front of you, or use the island at the
top of the screen. Buddy thinks with the AI you choose: Claude, GPT, Gemini, DeepSeek, any model through OpenRouter,
a free model on your own PC (Ollama, LM Studio), or the AI app you already use (Claude Code, Codex, Gemini CLI, Cursor,
VS Code and more).

- **Any AI:** see [AI and privacy](#ai-and-privacy) below.

- **Read the page:** ask Buddy to explain, summarize or answer from a web page, article, email or document and it
  reads the whole text in reading order (headings, paragraphs, lists, tables), including parts scrolled out of view,
  and knows which part is on screen right now. Long or slow pages take a few seconds ("Reading the page…").
- **Guide mode (default):** Buddy reads the app through its accessibility tree, flies its pointer to the
  control you need and labels it, one step at a time. You do the clicking.
- **Mark:** press **Ctrl+Alt+M** (or **Mark** on the island). The screen becomes a still with a blue frame.
  - **Click** something to explain it right away.
  - **Draw** over one or more things with the highlighter; each stroke gets a number. Press Enter and ask about
    them ("compare 1 and 2", "what does 1 do?"), or tap **Explain these**. Buddy sees the area with your strokes
    plus what's under each one, and can point back at a mark. **Ctrl+Z**, Backspace or a right-click undoes the last
    stroke; Esc cancels.
  - Shortcut: hover over anything and press **Ctrl+Alt+E** to explain it without entering mark mode.
- **Explain plates:** an explanation opens as a **field-guide plate**: the subject drawn as a specimen
  with hand-lettered labels and numbered Buddy-blue arrows, its field marks, where you'll meet it, how it behaves,
  what it's easily confused with, and a field note tied to what's on your screen. The design system is recorded in
  [DESIGN.md](DESIGN.md); preview it without the model via `BUDDY_EXPLAINER_TEST=scripts/samples/vlookup.json npm start`
  (add `BUDDY_THEME=dark` for dark mode).
  When an idea unfolds over time (a process, a flow, cause and effect), Claude can open the plate with a short
  **motion sequence**: animated scenes with narration and a play/pause, scene-by-scene player. It decides per
  explainer whether motion helps. Preview: `BUDDY_EXPLAINER_TEST=scripts/samples/vlookup-motion.json npm start`.
- **Island:** a pill at the top center that stays on screen whenever Buddy is running, so it doubles as the "on"
  light. A dim dot means idle, a bright dot means active; **Ctrl+Alt+B** switches between them. It also shows
  what Buddy is doing (looking, drawing, waiting for your OK).
  Hover it for **Ask**, **Talk**, **Mark** and **Task**.
- **Voice:** press **Ctrl+Alt+T** (or the mic in the bubble, or **Talk** on the island) and say what you need. Buddy
  stops listening when you pause (or press the key again), shows what it heard, and answers out loud: its reply and,
  while guiding, each step as it points. Press the key again or click the island to cut it off; Esc cancels.
  Everything runs on this PC: Moonshine (base, English) for listening and Supertonic 3 for talking, through
  [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) on the CPU. The first run downloads about 275 MB of models into
  `%APPDATA%/desktop-buddy/models`, each file checked against a pinned SHA-256 (see `src/models.js`); after that
  nothing leaves the machine. The models load when you start talking and unload after 10 idle minutes (about 520 MB
  while loaded). Measured on a Core Ultra 5 laptop on battery: about 0.4 s to understand a sentence and 1.6 s before
  Buddy starts speaking a short one.
  **Talk back** in Settings chooses when Buddy speaks: when you spoke (default), always, or never.
- **Task windows:** hover the island and click **Task** (or **Make task** in the bubble to move the current
  conversation) to give a job its own agent and window. Tasks work side by side while you keep using your computer;
  each shows the steps it takes and asks for approval in its own window. **–** tucks a task into a numbered chip on
  the island (its dot shows working, needs your OK, or finished). **Hover a chip** for a live preview of that task's
  window with its latest line, and answer an approval (**Allow** / **Don't**) right there; click the chip or the
  preview to bring the window back. **×** closes the task and stops its agent. Anything that clicks or types takes
  turns, so two tasks never fight over the mouse. Up to six at once; tasks don't survive a restart.
- **Dictation:** press **Ctrl+Alt+D** in any app and talk; Buddy types what you say where your cursor is (through
  the clipboard and one paste, then puts back what you had copied). It stops when you pause, or, if you choose, keeps
  going through pauses until you press the key again. It runs on this PC and needs no API key.
- **Any language:** set listening to **Detect automatically** and Buddy understands about 99 languages (multilingual
  Whisper, a 160 MB download the first time) and answers, out loud too, in the language you spoke.
- **Agents tab:** choose how much Buddy's agents (tasks, routines, "do it for me") may do without asking: nothing, safe
  moves (scrolling, expanding, moving windows), or anything in apps you trust. Apps on the **Never act in** list
  (password managers to start with) are off limits even if you'd approve. This is enforced where actions get their
  permission slip (`src/policy.js`, `src/approvals.js`), not just in the prompt.
- **Routines:** tasks on a schedule ("weekdays at 9:00, summarise my unread email"), each in its own task window tucked
  into the island, under the Agents rules. A run missed by less than six hours (the PC was asleep) still happens once.
- **Word documents:** ask for a report, summary or memo "in Word" and Buddy writes a real `.docx` (title, headings,
  lists, tables, bold and italic), saves it in **Documents › Buddy** without overwriting anything, and opens it in
  Word. One approval, no typing into Word.
- **Do mode:** say "do it for me" and Buddy operates the app. It asks before every action
  (Allow, Allow for this task, Don't), and it points at the target while it asks. "Allow for this task" covers more of
  the same kind only: screen actions, file changes, PowerShell, and each website, separately.
- **Beyond the screen:** Buddy can list, read, write and edit your files, run PowerShell and read web pages, with
  every model, when that's the quickest way to get something done (renaming photos, tidying a folder, making a list
  or a budget sheet, looking something up). It works in **Documents › Buddy** unless you name another place, and a
  file it makes opens when the answer is done. Your everyday folders are read without asking; anything else, and every
  change, asks first. Passwords and keys, browser profiles, the AI apps' settings and Buddy's own data are off limits
  to the file tools whatever is asked; PowerShell commands that name them are refused, and anything shaped like a
  secret key is hidden from the model (PowerShell runs as you, so this narrows it rather than walling it off).
- **Activity and undo:** Settings › **Activity** (or **Recent changes…** in the tray) lists what Buddy made or changed
  this past week, commands it ran and pages it read. **Undo** sends a file it made to the Recycle Bin or puts a
  changed one back (the old version is kept for a week); a file you changed since is only put back if you say so again.
- **Guiding a whole route:** the model can hand Buddy every step at once (`guide_steps`); Buddy points at each in turn,
  follows you when you work ahead, and matches controls by meaning when the app words them differently.

## Install

Download `Desktop-Buddy-Setup-<version>.exe` from the repository's
[Releases](https://github.com/donlapidos/agent-desktop/releases) and run it. It installs for your Windows account only
(no administrator prompt), adds **Desktop Buddy** to the Start menu and the desktop, and can be removed from
Settings › Apps like any other app; your settings, key and voice models stay in `%APPDATA%\desktop-buddy`.

The installer isn't code-signed (that needs a paid certificate), so Windows SmartScreen may say it "protected your PC"
the first time: choose **More info › Run anyway**. Each release lists the installer's SHA-512 in `latest.yml`.

Buddy keeps itself up to date: it checks the releases now and then, downloads a newer version in the background
(checked against its SHA-512), and installs it when you restart Buddy or choose **Restart to update** in the tray or
in Settings › About & updates, where automatic checks can also be turned off.

## Release

1. Bump `version` in `apps/buddy/package.json` and commit.
2. Push a matching tag: `git tag buddy-v0.2.0 && git push origin buddy-v0.2.0`.
3. `.github/workflows/buddy-release.yml` builds agent-desktop and the installer on Windows, runs the checks and tests,
   and uploads the installer and `latest.yml` to a **draft** release `v0.2.0`.
4. Review the draft, add notes, and publish it. Installed copies only see published releases.

`npm run dist` builds the same installer locally into `dist/` (after `cargo build --release -p agent-desktop`);
`npm run dist:dir` builds just the unpacked app, which can't update itself.

## Run from source

```bash
# 1. Build the agent-desktop CLI from this repo (from the repo root)
cargo build --release -p agent-desktop

# 2. Start Buddy
cd apps/buddy
npm install
npm start
```

The first time you start it with `npm start`, Buddy adds **Desktop Buddy** to the Start menu and the desktop
and turns on **Start with Windows**, so you never need the terminal again. Both live in the tray menu afterwards
("Start with Windows" checkbox, "Recreate shortcuts"). Launching Buddy while it is already running opens the Ask
bubble. The icon is generated by `node scripts/make-icon.js` into `assets/`.

On first launch Buddy asks how to think: paste an API key (Anthropic, OpenAI, OpenRouter or Gemini are recognised;
for DeepSeek or a model on your PC, choose it in Settings first). Keys are stored encrypted with Windows DPAPI
(Electron `safeStorage`), one per provider. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`GEMINI_API_KEY` and `DEEPSEEK_API_KEY` override the stored key for their provider.

`npm run smoke -- notepad` checks the agent-desktop bridge without calling the model.

`npm test` runs the unit tests (`test/*.test.js`, Node's built-in runner; no model calls, nothing on the desktop is
touched). They pin down the rules that matter most: approvals, slips and their scopes, the approval queue, the
read-only command path, the mode and task-state tables, the island's state, the provider adapters and what models can
do, the file tools' places and the PowerShell guard, undo, keys bound to their address, sessions from AI apps, history
trimming, the SVG sanitizer and escaping in explainers, the reading view, spoken text, and never overwriting a
document. CI (`.github/workflows/buddy.yml`) runs `npm run check` and `npm test` on Windows for every change under
`apps/buddy`.

`npm run e2e` runs the real app end to end, each check in a separate test copy with its own data folder (your Buddy,
settings and files are left alone): **files** (a scripted model asks for a file; the approval card is clicked; the file
is made, listed in Activity and undone; another window can't answer the card), **tasks**, **settings** (including a
key that must stay with its server), **explainer**, **voice**, and **firstrun** (a plain test copy must leave your
startup entries and shortcuts as they were). Any check whose copy logged a refused mode or task-state change fails.
`npm run e2e -- --exe "<path to Desktop Buddy.exe>"` runs them against a built or installed copy. `npm run e2e -- --interactive` adds the marker (a full-screen freeze frame) and the approval
clicks below (it moves the mouse). Screenshots and logs go to `e2e-out/`.

`npm run eval -- --provider openai --model <id>` runs the model check (seven real Buddy tasks, scored) from the
command line, with the key from the provider's usual variable; Settings › AI & privacy › **Check this model** runs the
same with your saved key.

`BUDDY_APPROVAL_TEST=cycle npm start` checks, with a real mouse click (the pointer moves; keep your hands off the
mouse), that an approval card takes a click and that the keyboard goes back to your app afterwards. Cases: `plain`,
`guide`, `cycle` and `twoasks` (see `main.js`). It guards a Windows quirk: switching the bubble to "can't take focus"
after it had been closed and reopened left it deaf to every click, so approval cards and Stop stopped working. The
bubble now never switches; it steps back and hands the keyboard to your window instead.

`npm run measure:idle` starts a separate copy of Buddy and reports its CPU use while idle, per process (keep the
mouse still; add `-- -Budget 1.0` to fail above a limit). Buddy should sit near 1% of one core: the overlay draws
only while the pointer moves, and the cursor check slows to 20 times a second once the mouse is still.

`npm run check` type-checks every main-process module (TypeScript reading the JSDoc types; nothing is compiled). It
holds three rules in place:

- **Approvals.** Anything that clicks, types, opens an app or moves a window runs only through `desktop.perform()`,
  which accepts only a single-use slip that `approvals.js` issues after the user says yes. Read-only commands go
  through `desktop.observe()`, which refuses everything else.
- **One mode at a time.** `main.js` tracks what Buddy is doing as a `Mode` (idle, marking, reading-marks, listening,
  working). Every change goes through `enter()`, which allows only the moves in `NEXT` and logs any other as
  `refused-mode-change` in `timing.log`. `NEXT` and the busy messages are typed `Record<Mode, …>`, so a new mode
  doesn't pass the check until both cover it.
- **Coordinates.** agent-desktop works in physical pixels and Electron in DIPs; `geometry.js` gives each its own
  type, and `main.js` converts between them only through `toPhysicalPoint`, `toPhysicalRect` and `toDipRect`.

## Settings

Open **Settings** from the tray, the sliders icon on the island, or the bubble. Every change applies at once, and
**Request a feature** in its sidebar opens a pre-filled GitHub issue for you to edit and send.

- **Voice & speech:** pick one of ten voices (choosing one plays it), speaking speed, and talk back.
- **Dictation:** when to stop (at a pause, or when you press the key again) and the listening language (English, or
  detect automatically).
- **Agents** and **Routines:** see above.
- **Look:** Buddy's accent colour (pointer, island, chat, task windows and marks) and light or dark explainer plates.
- **Shortcuts:** click one and press new keys. A shortcut another app already owns, or another Buddy action uses, is
  refused with the reason; while you record one, Buddy lets go of its own so pressing them is recorded.
- **AI & privacy:** the provider, its key or address, the model (each marked "works well", "can't see images" or
  "can't use tools", with its last check score) and thinking effort for new conversations, **Use with your AI app**,
  start with Windows, and clearing saved explainers or the timing log.
- **Activity:** see above.

Settings live in `%APPDATA%/desktop-buddy/settings.json`. Every value is checked when it is read and written, and the
file is replaced in one step; a damaged file is set aside as `settings.json.bad` and Buddy carries on with defaults.

## Configuration

These environment variables override Settings (useful for development):

| Variable | Default | Purpose |
|---|---|---|
| `BUDDY_HOTKEY` | `Control+Alt+B` | Global shortcut ([Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator)) |
| `BUDDY_EXPLAIN_HOTKEY` | `Control+Alt+E` | Explain what's under the cursor |
| `BUDDY_MARK_HOTKEY` | `Control+Alt+M` | Highlight things to ask about |
| `BUDDY_TALK_HOTKEY` | `Control+Alt+T` | Talk to Buddy (not Ctrl+Alt+V, which is Paste Special in Office) |
| `BUDDY_DICTATE_HOTKEY` | `Control+Alt+D` | Dictate into the app you're in |
| `BUDDY_VOICE` | `0` | Supertonic voice, `0`–`9` |
| `BUDDY_GPU` | unset | `1` turns GPU acceleration back on. It's off by default because on some dual-GPU laptops the GPU compositor leaves Buddy's transparent windows (the island, the pointer) blank |
| `BUDDY_MODEL` | Settings | The model, for whichever provider is chosen |
| `BUDDY_EFFORT` | `medium` | `low` is snappier, `high` is more careful |
| `AGENT_DESKTOP_BIN` | `../../target/release/agent-desktop.exe` | CLI to drive |
| `BUDDY_DOCUMENTS_DIR` | `Documents\Buddy` | Buddy's working folder |
| `BUDDY_ENGINE` | unset | `sdk` runs Anthropic conversations on the Claude Agent SDK (needs the SDK, which installers leave out) |

## How it fits together

```
hotkey ─► main.js ── remembers the window you were in (list-windows, is_focused)
            │
            ├─► island.html   status pill, task chips and their live previews
            ├─► bubble.html   prompt, replies, approval card, mic
            ├─► overlay.html  one click-through window per display: the pointer and its caption
            ├─► tasks.js      task windows (task.html), each with its own Brain
            ├─► voice.js      voice.html (hidden: microphone, end-of-speech detection, playback)
            │      └─► speech.js  child process: Moonshine + Supertonic on sherpa-onnx (models.js fetches and checks them)
            ├─► brain.js      the tool loop: look · screenshot · point_at · guide_steps · act · list_windows · …
            │      ├─► providers.js  Anthropic, OpenAI (Responses), and Chat Completions for the rest; what models can do
            │      ├─► pc-tools.js   files, PowerShell, web pages (places, the PowerShell guard, hidden secrets)
            │      └─► desktop.js ─► agent-desktop CLI (snapshot -i --compact --include-bounds, click, set-value…)
            ├─► approval-queue.js  the approval card's queue; approvals.js issues the single-use slips
            ├─► island-state.js    what the island says, worked out from what Buddy is doing
            ├─► activity.js   what Buddy changed this week, and undo
            └─► bridge.js     the named pipe AI apps reach Buddy through
                   ├─► mcp-server.js  the MCP server the AI apps start (on Buddy's own exe); starts Buddy if it's closed
                   ├─► app-sessions.js  one Brain per AI app session, calls in turn
                   └─► ai-apps.js     adds Buddy to Claude Code, the Claude app, Codex, Gemini CLI, Cursor, VS Code…
```

The speech engine is a plain Node child process (Electron run as Node), not an Electron utility process: Windows
runs utility processes at background priority on the efficiency cores, which made both models about twice as slow.
Every speech request has a deadline, so an engine that stops answering is restarted instead of leaving Buddy stuck.
Only the hidden voice page may open the microphone, and only while Buddy is listening. Dev check without speakers:
`BUDDY_VOICE_TEST="Click the Formulas tab." npm start` (muted round trip; add `BUDDY_VOICE_TEST_MIC=1` to try the mic).

Why these models: on this laptop they understand speech about 5× faster than Whisper base.en at the same accuracy,
speak as fast or faster than Kokoro, use about a third of the memory, and none of them depend on eSpeak NG (GPL-3.0),
which Kokoro's phonemizer embeds. Licences are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the Supertonic
voice comes with use restrictions (no impersonating people without consent, among others) that pass on to you.

Element bounds stay in `brain.js` for the pointer; Claude sees a compact text tree with refs.
agent-desktop reports physical pixels; `main.js` converts them to DIPs with `screen.screenToDipRect`.

Explainers are model-written HTML, so they render with JavaScript disabled, a CSP of `default-src 'none'`,
script/iframe/meta/link elements stripped, and a dedicated session that cancels every non-`file:`/`data:` request.
Each one is saved under `%APPDATA%/desktop-buddy/explainers/`.

Requests to Anthropic use `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so a declined request is
retried on Anthropic's recommended fallback model rather than failing outright.

## AI and privacy

Buddy has no server and no account of its own. What leaves your PC depends on how Buddy thinks:

- **A provider on your API key** (Anthropic, OpenAI, OpenRouter, Gemini, DeepSeek): your question, the text of the
  window you're asking about, and screenshots when the model can see images go to that provider, under your account
  and its terms. OpenAI is asked not to store them (`store: false`). Nothing goes to any other provider.
- **A model on your PC** (Ollama, LM Studio): nothing leaves the PC.
- **Another server:** goes to that address only. Plain `http://` is allowed only on this PC or your local network,
  and its key is tied to the address it was entered for: change the address to another host and the key isn't sent.
- **Your AI app** (Claude Code, Codex, …): that app does the thinking under its own terms; Buddy only gives it the
  window's text, screenshots and pointing when it asks. Buddy's look-and-point tools run without a prompt there; acting
  still asks on Buddy's card.
- **Web pages** Buddy reads are fetched from your PC, after you allow each site. Addresses on your PC or network are
  never fetched.
- **Voice** runs on your PC; the models are downloaded once from pinned commits and checked.
- **Updates** are checked against this repository's GitHub releases.

Keys are stored encrypted with Windows (DPAPI), one per provider, and only ever sent to their provider; Settings never
sees them. PowerShell runs without them in its environment, and anything shaped like a secret key in what Buddy reads
is hidden from the model. The timing log (`%APPDATA%\desktop-buddy\timing.log`, about 10 MB at most, text cut short)
and Activity stay on your PC.
