# Third-party notices

Desktop Buddy is part of agent-desktop and is licensed under the Apache License 2.0 (see `../../LICENSE`). It uses
the following third-party software, fonts and models.

## Software

| Component | Licence | Used for |
|---|---|---|
| [Electron](https://github.com/electron/electron) 45 | MIT | The app shell |
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | Apache-2.0 | Calls to Claude, with the user's own API key (other providers are called directly over HTTPS) |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | Offering Buddy's tools to AI apps (MCP) |
| [Zod](https://github.com/colinhacks/zod) | MIT | Tool schemas for the optional Agent SDK engine (used by the MCP SDK too) |
| [docx](https://github.com/dolanmiu/docx) | MIT | Writing Word documents |
| [electron-updater](https://github.com/electron-userland/electron-builder) | MIT | Installing updates from GitHub releases |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node`) | Apache-2.0 | Running the speech models |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (bundled with sherpa-onnx) | MIT | Running the speech models |
| [agent-desktop](../../README.md) | Apache-2.0 | Reading and operating apps through accessibility |

## Fonts

Alegreya Sans (Juan Pablo del Peral, Huerta Tipográfica), Patrick Hand (Patrick Wagesreiter) and Schibsted Grotesk
(Bakken & Bæck), all under the SIL Open Font License 1.1. See `src/ui/fonts/LICENSES.txt`.

## Speech models

Buddy doesn't ship these. It downloads them on first use from the pinned Hugging Face commits listed in
`src/models.js` and checks every file's SHA-256 before using it. Each model's own licence file is downloaded with it.

### Moonshine base (English), for listening

By Useful Sensors / Moonshine AI. Code and English models under the **MIT License**.
Model: <https://github.com/moonshine-ai/moonshine>. ONNX export by the sherpa-onnx project.

### Whisper base (multilingual), for listening in any language

By OpenAI, under the **MIT License**: <https://github.com/openai/whisper>. ONNX (int8) export by the sherpa-onnx
project. Downloaded only when listening is set to "Detect automatically".

### Supertonic 3, for speaking

By Supertone Inc. Sample code under the **MIT License**. The model weights are released under the
**BigScience OpenRAIL-M License**: <https://huggingface.co/supertone-oss-archive/supertonic-3/blob/main/LICENSE>.
ONNX (int8) export by the sherpa-onnx project.

OpenRAIL-M allows use, redistribution and modification, including commercially, but its **use restrictions apply to
everyone who uses the model, and to Buddy's users through Buddy**. Among other things, you may not use it:

- to impersonate or attempt to impersonate others (for example, deepfakes) without their consent;
- to generate or spread verifiably false information intended to harm others;
- to provide medical advice or interpret medical results;
- for fully automated decision-making that adversely affects an individual's legal rights or creates binding
  obligations.

That list is a summary; the licence linked above is authoritative, and its Attachment A is the complete list.

### Why not Kokoro

Earlier versions of Buddy used Kokoro-82M through kokoro-js. Its text-to-phoneme step (`phonemizer`) embeds a
WebAssembly build of eSpeak NG, which is licensed under GPL-3.0, although the npm package is labelled Apache-2.0.
The current models need no phonemizer.
