# Desktop Buddy changelog

## 0.2.0 (unreleased)

### Any AI, not only Claude

* **Choose who Buddy thinks with** in Settings › AI & privacy: Anthropic, OpenAI, OpenRouter, Google Gemini or
  DeepSeek on your own API key; **Ollama** or **LM Studio** for free, private models on your PC; or any other
  OpenAI-compatible server at an address you give. Each provider keeps its own key, so switching back loses nothing,
  and a key pasted into the bubble is recognised and saved for its provider.
* OpenAI goes through its Responses API, where its newest models reason and use tools together; the rest go through
  Chat Completions. Model lists come from each provider for your key, so new models appear without an update.
* **Buddy knows what each model can do** (use tools, see images), from the provider, the model family or a refusal,
  and works within it: a model that can't see images works from the window's text; one that can't use tools is
  named as such instead of failing oddly. Settings marks each model "works well", "can't see images" or "can't use
  tools".
* **Check this model** runs seven real Buddy tasks on the chosen model and scores it; `npm run eval` does the same
  from the command line.

### Use Buddy from the AI app you already have

* **Use with your AI app** (was Use with Claude) adds Buddy to Claude Code, the Claude app, **Codex** (ChatGPT plan),
  Gemini CLI, Cursor, VS Code (Copilot), Windsurf and LM Studio, so you can use Buddy on the plan you already pay for
  with no key in Buddy. Buddy starts itself when one of them needs it, and repairs their settings when it moves.
* **Quick chat in Claude Code** (tray) opens Claude Code with only Buddy's tools: about 4× faster per turn.
* The island says which app is using Buddy ("Codex: Looking…").

### Beyond the screen

* Buddy can work with your files (list, read, write, edit), run PowerShell and read web pages, with every model.
* **Activity** (Settings, or Recent changes… in the tray) lists what Buddy made or changed this week; **Undo** sends
  a file it made to the Recycle Bin or puts a changed one back.
* A file Buddy made opens when the answer finishes.

### Guiding

* `guide_steps`: the model plans the whole route once and Buddy follows it on its own, moving on when you work ahead.
* Steps are matched by meaning when the app words them differently ("Sort Largest to Smallest" is "Sort Z to A").

### Safety

* "Allow for this task" covers more of the same kind only: screen actions, file changes, PowerShell, and each website
  separately.
* Some places are off limits to the file tools whatever is asked: passwords and keys, browser profiles, the AI apps'
  settings, Buddy's own data. PowerShell commands that name them are refused, and anything shaped like a secret key
  is hidden from the model.
* Keypresses go to one named window, and that window is what your Agents rules judge.
* A key for "Other server" goes only to the address it was saved for.
* Approval requests from Buddy and from AI apps queue on the card instead of replacing each other, and a cancelled one
  is withdrawn. Only the bubble can answer its card, and never in its first half second.

### Fixes

* The island said "Listening" with the microphone off; it now says "Ready". What it shows is worked out in one place.
* One odd refusal no longer marks a model as unable to use tools or images for good.
* The timing log stays under about 10 MB and keeps text short.
* After an approval, the keyboard goes back to your app even when the bubble had just been closed and reopened.
* A test copy of Buddy no longer turns on start with Windows for itself.

### Under the hood

* `npm run e2e` runs the real app end to end in separate test copies (files, tasks, settings, explainer, voice;
  `--interactive` adds the marker and real approval clicks).
* The Claude Agent SDK engine is optional (`BUDDY_ENGINE=sdk`) and left out of the installer (it would add the
  346 MB Claude Code program).

## 0.1.0

First release: Guide and Do modes, Mark and Explain plates, voice and dictation on the PC, task windows, routines,
Agents rules, Word documents, Settings, and self-updating installer.
