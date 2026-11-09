// The on-device speech models: what Buddy downloads, from where, and how it checks them. Each file comes from a pinned
// Hugging Face commit and must match its size and SHA-256 before it is used, so a changed, truncated or tampered file
// is never loaded. The mirrors are the sherpa-onnx author's exports, identical to the sherpa-onnx release archives.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{ name: string, size: number, sha256: string }} ModelFile
 * @typedef {{ id: string, repo: string, commit: string, license: string, files: ModelFile[] }} Model
 */

/** Listening: Moonshine base (English), MIT. @type {Model} */
export const ASR = {
  id: "sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
  repo: "csukuangfj2/sherpa-onnx-moonshine-base-en-quantized-2026-02-27",
  commit: "8f4d6c58c03d40bcea40043bb7120a878f2bbef6",
  license: "MIT",
  files: [
    { name: "encoder_model.ort", size: 31326816, sha256: "7c66495948d0d08ec1af454cd4b5514862ae6511e94712a60e6d83eaec8dc8cf" },
    { name: "decoder_model_merged.ort", size: 109424400, sha256: "d9d7b333af34bc552580576ddcf248a1c6c839e0d3b43b09afb9376ed009899d" },
    { name: "tokens.txt", size: 549350, sha256: "2870d843e14c1e187bf1913a521562a63b53933814bd7f2145120468f494a049" },
    { name: "LICENSE", size: 13344, sha256: "6148d7574a6554b7379b633cfd4c4fe5840c3f548d13bc83e00b52dc6fa00abd" },
  ],
};

/** Speaking: Supertonic 3, int8. Weights under OpenRAIL-M (use restrictions apply), code MIT. @type {Model} */
export const TTS = {
  id: "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
  repo: "csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
  commit: "cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4",
  license: "OpenRAIL-M",
  files: [
    { name: "duration_predictor.int8.onnx", size: 3700147, sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db" },
    { name: "text_encoder.int8.onnx", size: 36416150, sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff" },
    { name: "vector_estimator.int8.onnx", size: 78400833, sha256: "20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd" },
    { name: "vocoder.int8.onnx", size: 25991073, sha256: "e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152" },
    { name: "tts.json", size: 8253, sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09" },
    { name: "unicode_indexer.bin", size: 262144, sha256: "8402ca48e5189a8950138580b0fff64db6f072f24ac07cd54ba8b2fbb9883b30" },
    { name: "voice.bin", size: 517168, sha256: "67d5209b0ee8ce6c74105ffbe12fe6a7628aea3b4ba2fcb308a4a67938a93ce8" },
    { name: "LICENSE", size: 1070, sha256: "0dfe0d0ba84416fe3879d9a34f4909d8d0137c78d1e95834177b0414ac096fa2" },
  ],
};

// Caches earlier versions of Buddy left behind (Whisper and Kokoro, about 660 MB). Only this folder, inside Buddy's
// own models directory, is ever removed.
const LEGACY_DIRS = ["onnx-community"];

/** @param {string} dir @param {Model} model */
export const modelDir = (dir, model) => path.join(dir, model.id);
/** @param {string} dir @param {Model} model @param {string} name */
export const modelFile = (dir, model, name) => path.join(modelDir(dir, model), name);
/** @param {Model} model @param {ModelFile} file */
export const fileUrl = (model, file) => `https://huggingface.co/${model.repo}/resolve/${model.commit}/${file.name}`;

/** Whether every file is present at the right size (the hash was checked when it was downloaded). */
export function isInstalled(dir, /** @type {Model} */ model) {
  return model.files.every((f) => {
    try {
      return fs.statSync(modelFile(dir, model, f.name)).size === f.size;
    } catch {
      return false;
    }
  });
}

/**
 * Downloads whatever is missing, checking each file before it takes its place (it is written beside it first).
 * `onProgress` gets bytes so far and the total of the files being fetched; nothing is reported when all is present.
 * @param {string} dir
 * @param {Model} model
 * @param {{ onProgress?: (loaded: number, total: number) => void, fetchImpl?: typeof fetch, signal?: AbortSignal }} [opts]
 */
export async function install(dir, model, { onProgress, fetchImpl = fetch, signal } = {}) {
  const missing = model.files.filter((f) => {
    try {
      return fs.statSync(modelFile(dir, model, f.name)).size !== f.size;
    } catch {
      return true;
    }
  });
  if (!missing.length) return;
  fs.mkdirSync(modelDir(dir, model), { recursive: true });
  const total = missing.reduce((n, f) => n + f.size, 0);
  let loaded = 0;
  for (const f of missing) {
    const target = modelFile(dir, model, f.name);
    const part = `${target}.part`;
    const res = await fetchImpl(fileUrl(model, f), { signal });
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${f.name} (HTTP ${res.status})`);
    const hash = crypto.createHash("sha256");
    const out = fs.createWriteStream(part);
    let size = 0;
    try {
      for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (res.body))) {
        hash.update(chunk);
        size += chunk.length;
        loaded += chunk.length;
        if (!out.write(chunk)) await new Promise((r) => out.once("drain", () => r(undefined)));
        onProgress?.(loaded, total);
      }
      await new Promise((resolve, reject) => {
        out.once("error", reject);
        out.end(() => resolve(undefined));
      });
      const digest = hash.digest("hex");
      if (size !== f.size || digest !== f.sha256) throw new Error(`${f.name} failed its check (got ${size} bytes, sha256 ${digest.slice(0, 12)}…)`);
      fs.renameSync(part, target);
    } catch (err) {
      out.destroy();
      fs.rmSync(part, { force: true });
      throw err;
    }
  }
}

/** Removes the caches of the old speech models. Returns the folders removed. */
export function removeLegacy(dir) {
  const removed = [];
  for (const name of LEGACY_DIRS) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
