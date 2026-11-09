// Voice: Buddy listens when asked (hotkey or the bubble's mic) and talks back. The hidden voice window owns the
// microphone and the speakers; the speech child process (speech.js) runs Moonshine and Supertonic. Everything stays
// on this PC.
import { BrowserWindow, ipcMain } from "electron";
import { fork } from "node:child_process";
import path from "node:path";
import { ASR, TTS, isInstalled, removeLegacy } from "./models.js";
import { pieces } from "./speakable.js";

// Supertonic has ten voices, 0-9. 0 was chosen by ear.
const VOICE = Math.min(9, Math.max(0, Math.trunc(Number(process.env.BUDDY_VOICE ?? 0)) || 0));
// The models hold ~520 MB while loaded. They load the moment the user starts talking (Moonshine is ready before
// they finish their sentence, Supertonic before Claude answers) and unload after this long unused.
const UNLOAD_AFTER_MS = 10 * 60_000;
// How long each speech request may take. Warming can include the first download (~275 MB) on a slow connection.
const DEADLINE_MS = { init: 15_000, warm: 30 * 60_000, transcribe: 60_000, speak: 60_000 };
// How long past a clip's own length to wait for the voice page to say it finished playing.
const PLAY_GRACE_MS = 5_000;

/**
 * @param {{ here: string, cacheDir: string, onState: (state: string, info?: object) => void,
 *           onLevel: (level: number) => void, trace?: Function }} opts
 */
export function createVoice({ here, cacheDir, onState, onLevel, trace = () => {} }) {
  let speech = null;
  let unloadTimer = null;
  let seq = 0;
  const pending = new Map();
  let win = null;
  let heard = null; // resolves the current listen()
  let played = new Map();
  let gen = 0; // bumps on hush, so a reply being spoken stops between pieces
  let speaking = false;

  function startSpeech() {
    const proc = fork(path.join(here, "speech.js"), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      serialization: "advanced", // audio travels as Float32Array
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    speech = proc;
    proc.on("message", (/** @type {any} */ msg) => {
      if (msg.type === "progress") return onState("downloading", msg);
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      msg.ok ? job.resolve(msg) : job.reject(new Error(msg.error));
    });
    // An unloaded engine's late exit must not take down the one started after it.
    proc.on("exit", () => {
      if (speech === proc) fail("The speech engine stopped");
    });
    request("init", { cacheDir, voice: VOICE });
  }

  // Ends every waiting request with `reason` and drops the engine; the next request starts a fresh one.
  function fail(reason) {
    const proc = speech;
    speech = null;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error(reason));
    }
    pending.clear();
    proc?.kill();
  }

  function idleLater() {
    clearTimeout(unloadTimer);
    unloadTimer = setTimeout(() => {
      if (heard || speaking || pending.size) return idleLater();
      speech?.kill();
      speech = null;
    }, UNLOAD_AFTER_MS);
  }

  // Every request has a deadline. An engine that stops answering (a native error that never reaches its handler, a
  // hung model) would otherwise leave Buddy "speaking" or "listening" forever; past the deadline the engine is
  // restarted and the request fails like any other error.
  function request(type, data = {}) {
    if (!speech) startSpeech();
    idleLater();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        trace({ kind: "voice-timeout", job: type });
        fail(`The speech engine didn't answer (${type})`);
      }, DEADLINE_MS[type] ?? 60_000);
      const settle = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject), timer });
      speech.send({ id, type, ...data });
    });
  }

  function createWindow() {
    win = new BrowserWindow({ show: false, width: 200, height: 100, skipTaskbar: true, webPreferences: { preload: path.join(here, "preload.cjs"), backgroundThrottling: false } });
    win.loadFile(path.join(here, "ui/voice.html"));
    win.on("closed", () => (win = null));
  }
  const send = (payload) => {
    if (!win || win.isDestroyed()) createWindow();
    const go = () => win.webContents.send("voice", payload);
    win.webContents.isLoading() ? win.webContents.once("did-finish-load", go) : go();
  };

  const fromVoice = (e) => win && e.sender === win.webContents;
  ipcMain.on("voice-state", (e, state) => fromVoice(e) && onState(state));
  ipcMain.on("voice-level", (e, level) => fromVoice(e) && onLevel(Number(level) || 0));
  ipcMain.on("voice-heard", (e, result) => {
    if (!fromVoice(e)) return;
    const done = heard;
    heard = null;
    done?.(result);
  });
  ipcMain.on("voice-played", (e, id) => {
    if (!fromVoice(e)) return;
    played.get(id)?.();
    played.delete(id);
  });

  /** Records until the user stops talking, then transcribes. Resolves { text } or { error }. */
  async function listen() {
    hush();
    if (heard) return { error: "busy" };
    const started = Date.now();
    warm();
    const result = await new Promise((resolve) => {
      heard = resolve;
      send({ cmd: "listen" });
    });
    if (!result?.pcm) return { error: result?.error ?? "cancelled" };
    onState("transcribing");
    const t0 = Date.now();
    try {
      const { text } = await request("transcribe", { pcm: result.pcm });
      trace({ kind: "voice-heard", ms: Date.now() - t0, seconds: +(result.pcm.length / 16000).toFixed(1), total: Date.now() - started });
      // Recognizers can fill silence with tags like "[BLANK_AUDIO]" or "(wind blowing)"; drop them.
      const clean = text.replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim();
      return clean.replace(/[.\s]/g, "") ? { text: clean } : { error: "silence" };
    } catch (err) {
      return { error: err.message };
    }
  }

  /** Ends listening now and uses what was said so far. */
  const finishListening = () => heard && send({ cmd: "finish" });
  const cancelListening = () => {
    if (!heard) return;
    send({ cmd: "cancel" });
    const done = heard;
    heard = null;
    done({ error: "cancelled" });
  };

  const warm = () => request("warm").catch((err) => trace({ kind: "voice-warm-failed", error: err.message }));

  /** Speaks text, a piece at a time, cutting off whatever Buddy was saying. Resolves when done or hushed. */
  async function say(text) {
    const parts = pieces(text);
    if (!parts.length) return;
    hush();
    const mine = ++gen;
    speaking = true;
    onState("speaking");
    const synth = (s) => request("speak", { text: s }).catch(() => null);
    try {
      let next = synth(parts[0]);
      for (let i = 0; i < parts.length; i++) {
        const clip = await next;
        if (mine !== gen) return;
        next = i + 1 < parts.length ? synth(parts[i + 1]) : null;
        if (!clip) continue;
        const id = ++seq;
        // If the voice page never reports the clip finished (it reloaded or crashed), move on once the clip's own
        // length and a grace period have passed rather than waiting forever.
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            played.delete(id);
            trace({ kind: "voice-play-timeout" });
            resolve(undefined);
          }, (clip.audio.length / clip.rate) * 1000 + PLAY_GRACE_MS);
          played.set(id, () => {
            clearTimeout(timer);
            resolve(undefined);
          });
          send({ cmd: "play", id, audio: clip.audio, rate: clip.rate });
        });
        if (mine !== gen) return;
      }
    } finally {
      if (mine === gen) {
        speaking = false;
        onState("quiet");
      }
    }
  }

  function hush() {
    gen++;
    for (const resolve of played.values()) resolve();
    played.clear();
    if (win && !win.isDestroyed()) send({ cmd: "hush" });
    if (speaking) {
      speaking = false;
      onState("quiet");
    }
  }

  return {
    listen,
    finishListening,
    cancelListening,
    say,
    hush,
    warm,
    // On a first run, fetch the models in the background so the first question isn't a long wait. Caches of the
    // speech models earlier versions used are removed once the current ones are in place.
    prepare: async () => {
      if (![ASR, TTS].every((m) => isInstalled(cacheDir, m))) await warm();
      if ([ASR, TTS].every((m) => isInstalled(cacheDir, m))) {
        const removed = removeLegacy(cacheDir);
        if (removed.length) trace({ kind: "voice-legacy-removed", removed });
      }
    },
    synthesize: (text) => request("speak", { text }),
    // Dev checks play replies silently.
    mute: () => {
      if (!win || win.isDestroyed()) createWindow();
      win.webContents.setAudioMuted(true);
    },
    transcribe: (pcm) => request("transcribe", { pcm }),
    get listening() {
      return !!heard;
    },
    get speaking() {
      return speaking;
    },
  };
}
