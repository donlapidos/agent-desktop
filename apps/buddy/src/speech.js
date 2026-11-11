// On-device speech, in its own process so model work never stalls the island, the pointer or the bubble. It is a
// plain Node child (Electron run as Node) rather than an Electron utility process: Windows runs utility processes at
// background priority on the efficiency cores, which made the models twice as slow.
// Moonshine (base, English) turns what the user says into text, or multilingual Whisper base when Settings asks for
// the language to be detected; Supertonic 3 speaks Buddy's replies, in the language heard when it knows it. All run on the
// CPU through sherpa-onnx. The models download once (~275 MB, checked file by file; see models.js) into
// userData/models and nothing leaves the machine after that. Measured on a Core Ultra 5 laptop on battery: ~0.4 s to
// transcribe a sentence; speech at 0.4-0.7x real time; ~520 MB for both loaded, so voice.js unloads them when unused.
import { createRequire } from "node:module";
import { ASR, ASR_MULTI, TTS, VOICE_LANGUAGES, install, modelFile } from "./models.js";

const sherpa = createRequire(import.meta.url)("sherpa-onnx-node");
const THREADS = 4;
// Five refinement passes: fewer is faster but starts to garble words (measured: 4 said "VLOOKUP" as "VioCup").
const TTS_STEPS = 5;

let cacheDir;
const asr = { en: null, auto: null }; // a recognizer per listening language, loaded when first needed
let tts = null;

const post = (msg) => process.send(msg);
const progress = (what) => (loaded, total) => post({ type: "progress", what, loaded, total });

// A failed load (offline on first use) is forgotten so the next request tries again.
function loadAsr(language = "en") {
  const key = language === "auto" ? "auto" : "en";
  const model = key === "auto" ? ASR_MULTI : ASR;
  asr[key] ??= install(cacheDir, model, { onProgress: progress("listening") })
    .then(() => {
      const f = (name) => modelFile(cacheDir, model, name);
      const engine =
        key === "auto"
          ? // An empty language makes Whisper detect it, and the result says which it heard.
            { whisper: { encoder: f("base-encoder.int8.onnx"), decoder: f("base-decoder.int8.onnx"), language: "", task: "transcribe", tailPaddings: -1 }, tokens: f("base-tokens.txt") }
          : { moonshine: { encoder: f("encoder_model.ort"), mergedDecoder: f("decoder_model_merged.ort") }, tokens: f("tokens.txt") };
      return new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: { ...engine, numThreads: THREADS, provider: "cpu", debug: 0 },
      });
    })
    .catch((err) => {
      asr[key] = null;
      throw err;
    });
  return asr[key];
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
  },
  async warm({ language = "en" } = {}) {
    await Promise.all([loadAsr(language), loadTts()]);
  },
  // Returns the text and the language heard: "en" for the English model, whatever Whisper detected otherwise.
  async transcribe({ pcm, language = "en" }) {
    const recognizer = await loadAsr(language);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: pcm, sampleRate: 16000 });
    await recognizer.decodeAsync(stream);
    const result = recognizer.getResult(stream);
    return { text: String(result.text ?? "").trim(), lang: language === "auto" ? String(result.lang ?? "").replace(/[<|>]/g, "") || "en" : "en" };
  },
  // `sid` is the voice (0-9) and `speed` the pace (1 is normal); both come with each request so a change in
  // Settings, or a preview of another voice, needs no restart.
  // `lang` is the language to speak in; one the voice doesn't know is read with its English voice.
  async speak({ text, sid = 0, speed = 1, lang = "en" }) {
    const engine = await loadTts();
    // Electron's Node refuses "external" buffers (native memory handed to JS without a copy), which sherpa-onnx uses
    // by default for the audio; with them on, every request fails with "TTS settlement failed".
    const audio = await engine.generateAsync({ text, enableExternalBuffer: false, generationConfig: { sid, speed, numSteps: TTS_STEPS, extra: { lang: VOICE_LANGUAGES.has(lang) ? lang : "en" } } });
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
