// On-device speech, in its own process so model work never stalls the island, the pointer or the bubble. It is a
// plain Node child (Electron run as Node) rather than an Electron utility process: Windows runs utility processes at
// background priority on the efficiency cores, which made the models twice as slow.
// Moonshine (base, English) turns what the user says into text; Supertonic 3 speaks Buddy's replies. Both run on the
// CPU through sherpa-onnx. The models download once (~275 MB, checked file by file; see models.js) into
// userData/models and nothing leaves the machine after that. Measured on a Core Ultra 5 laptop on battery: ~0.4 s to
// transcribe a sentence; speech at 0.4-0.7x real time; ~520 MB for both loaded, so voice.js unloads them when unused.
import { createRequire } from "node:module";
import { ASR, TTS, install, modelFile } from "./models.js";

const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
const THREADS = 4;
// Five refinement passes: fewer is faster but starts to garble words (measured: 4 said "VLOOKUP" as "VioCup").
const TTS_STEPS = 5;

let cacheDir;
let voice = 0;
let asr = null;
let tts = null;

const post = (msg) => process.send(msg);
const progress = (what) => (loaded, total) => post({ type: "progress", what, loaded, total });

// A failed load (offline on first use) is forgotten so the next request tries again.
function loadAsr() {
  asr ??= install(cacheDir, ASR, { onProgress: progress("listening") })
    .then(() => {
      const f = (name) => modelFile(cacheDir, ASR, name);
      return new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          moonshine: { encoder: f("encoder_model.ort"), mergedDecoder: f("decoder_model_merged.ort") },
          tokens: f("tokens.txt"),
          numThreads: THREADS,
          provider: "cpu",
          debug: 0,
        },
      });
    })
    .catch((err) => {
      asr = null;
      throw err;
    });
  return asr;
}

function loadTts() {
  tts ??= install(cacheDir, TTS, { onProgress: progress("speaking") })
    .then(() => {
      const f = (name) => modelFile(cacheDir, TTS, name);
      return new sherpa.OfflineTts({
        model: {
          supertonic: {
            durationPredictor: f("duration_predictor.int8.onnx"),
            textEncoder: f("text_encoder.int8.onnx"),
            vectorEstimator: f("vector_estimator.int8.onnx"),
            vocoder: f("vocoder.int8.onnx"),
            ttsJson: f("tts.json"),
            unicodeIndexer: f("unicode_indexer.bin"),
            voiceStyle: f("voice.bin"),
          },
          numThreads: THREADS,
          provider: "cpu",
          debug: false,
        },
        maxNumSentences: 1,
      });
    })
    .catch((err) => {
      tts = null;
      throw err;
    });
  return tts;
}

const jobs = {
  init(data) {
    cacheDir = data.cacheDir;
    voice = data.voice;
  },
  async warm() {
    await Promise.all([loadAsr(), loadTts()]);
  },
  async transcribe({ pcm }) {
    const recognizer = await loadAsr();
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: pcm, sampleRate: 16000 });
    await recognizer.decodeAsync(stream);
    return { text: String(recognizer.getResult(stream).text ?? "").trim() };
  },
  async speak({ text }) {
    const engine = await loadTts();
    // Electron's Node refuses "external" buffers (native memory handed to JS without a copy), which sherpa-onnx uses
    // by default for the audio; with them on, every request fails with "TTS settlement failed".
    const audio = await engine.generateAsync({ text, enableExternalBuffer: false, generationConfig: { sid: voice, speed: 1.0, numSteps: TTS_STEPS, extra: { lang: "en" } } });
    return { audio: audio.samples, rate: audio.sampleRate };
  },
};

process.on("message", async (/** @type {any} */ data) => {
  const { id, type } = data;
  try {
    const result = await jobs[type](data);
    post({ id, ok: true, ...result });
  } catch (err) {
    post({ id, ok: false, error: String(err?.message ?? err) });
  }
});

// Buddy quit (or crashed): don't linger holding the models in memory.
process.on("disconnect", () => process.exit(0));
