import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ASR, TTS, fileUrl, install, isInstalled, modelFile, removeLegacy } from "../src/models.js";

const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A tiny model whose files are served by a fake fetch, so no test touches the network.
function fakeModel(contents) {
  const files = Object.entries(contents).map(([name, text]) => ({
    name,
    size: Buffer.byteLength(text),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  }));
  return { id: "test-model", repo: "someone/test-model", commit: "0".repeat(40), license: "MIT", files };
}
const serving = (bodies) => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const name = url.split("/").pop();
    if (!(name in bodies)) return new Response(null, { status: 404 });
    return new Response(bodies[name]);
  };
  return { asked, fetchImpl };
};

test("the manifest pins every file to a commit, a size and a SHA-256", () => {
  for (const model of [ASR, TTS]) {
    assert.match(model.commit, /^[0-9a-f]{40}$/, model.id);
    assert.ok(model.files.some((f) => f.name === "LICENSE"), `${model.id} ships its licence`);
    for (const f of model.files) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, f.name);
      assert.ok(f.size > 0, f.name);
      assert.ok(fileUrl(model, f).startsWith(`https://huggingface.co/${model.repo}/resolve/${model.commit}/`), f.name);
    }
  }
});

test("install downloads, checks and places every file", async (t) => {
  const dir = tempDir(t);
  const model = fakeModel({ "a.onnx": "weights", "LICENSE": "MIT" });
  const { fetchImpl } = serving({ "a.onnx": "weights", "LICENSE": "MIT" });
  const progress = [];
  await install(dir, model, { fetchImpl, onProgress: (loaded, total) => progress.push([loaded, total]) });
  assert.ok(isInstalled(dir, model));
  assert.equal(fs.readFileSync(modelFile(dir, model, "a.onnx"), "utf8"), "weights");
  assert.deepEqual(progress.at(-1), [10, 10]);
});

test("a file that doesn't match its checksum is refused and leaves nothing behind", async (t) => {
  const dir = tempDir(t);
  const model = fakeModel({ "a.onnx": "weights" });
  const { fetchImpl } = serving({ "a.onnx": "WEIGHTS" }); // same size, different bytes
  await assert.rejects(install(dir, model, { fetchImpl }), /failed its check/);
  assert.ok(!isInstalled(dir, model));
  assert.deepEqual(fs.readdirSync(path.join(dir, model.id)), [], "no partial file is left");
});

test("a failed download is reported, not half-installed", async (t) => {
  const dir = tempDir(t);
  const model = fakeModel({ "a.onnx": "weights" });
  await assert.rejects(install(dir, model, serving({})), /HTTP 404/);
  assert.ok(!isInstalled(dir, model));
});

test("only missing or wrong-sized files are fetched again", async (t) => {
  const dir = tempDir(t);
  const model = fakeModel({ "a.onnx": "weights", "b.onnx": "more" });
  await install(dir, model, serving({ "a.onnx": "weights", "b.onnx": "more" }));
  fs.writeFileSync(modelFile(dir, model, "b.onnx"), "mo"); // truncated
  const again = serving({ "a.onnx": "weights", "b.onnx": "more" });
  await install(dir, model, again);
  assert.deepEqual(again.asked.map((u) => u.split("/").pop()), ["b.onnx"]);
  assert.ok(isInstalled(dir, model));
  const none = serving({});
  await install(dir, model, none);
  assert.equal(none.asked.length, 0, "nothing is fetched when everything is present");
});

test("only the old speech caches are cleaned up", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "onnx-community", "whisper-base.en"), { recursive: true });
  fs.mkdirSync(path.join(dir, ASR.id), { recursive: true });
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
  assert.deepEqual(removeLegacy(dir), ["onnx-community"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [ASR.id, "notes.txt"].sort());
  assert.deepEqual(removeLegacy(dir), []);
});
