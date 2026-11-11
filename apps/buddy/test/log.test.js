import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLog, shortened } from "../src/log.js";

test("the log moves aside past its limit, keeping at most two files' worth", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-log-"));
  const file = path.join(dir, "timing.log");
  const log = createLog(file, { max: 2000 });
  for (let i = 0; i < 400; i++) log.write({ kind: "tool", i, note: "x".repeat(40) });
  assert.ok(fs.existsSync(log.old), "an old file was kept");
  assert.equal(path.basename(log.old), "timing.old.log");
  // The size is checked every 100 entries, so neither file grows past the limit by more than that many entries.
  assert.ok(fs.statSync(file).size < 2000 + 100 * 120, `timing.log is ${fs.statSync(file).size} bytes`);
  assert.ok(fs.statSync(log.old).size < 2000 + 100 * 120);
  const last = fs.readFileSync(file, "utf8").trim().split("\n").at(-1);
  assert.equal(JSON.parse(last).i, 399, "the newest entry is in timing.log");
});

test("long text in an entry is cut short, however deep", () => {
  const e = shortened({ kind: "model-check-case", reply: "r".repeat(1000), shown: ["s".repeat(500)], nested: { problem: "p".repeat(400) }, ms: 12 });
  assert.equal(e.reply.length, 301);
  assert.equal(e.shown[0].length, 301);
  assert.equal(e.nested.problem.length, 301);
  assert.equal(e.ms, 12);
});

test("a log that can't be written doesn't throw", () => {
  const log = createLog(path.join(os.tmpdir(), "no-such-dir-buddy", "x", "timing.log"));
  assert.doesNotThrow(() => log.write({ kind: "x" }));
});

test("what the log writes is shortened too", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-log-"));
  const file = path.join(dir, "timing.log");
  createLog(file).write({ kind: "model-check-case", reply: "r".repeat(1000) });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).reply.length, 301);
});
