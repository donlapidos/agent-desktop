import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ACCENTS, DEFAULTS, MODELS, isHotkey, load, normalize, save, update } from "../src/settings.js";

const tempFile = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-settings-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "settings.json");
};

test("anything unknown or invalid falls back to its default", () => {
  const s = normalize({ voice: 42, speed: "fast", talkBack: "sometimes", accent: "#ff0000", appearance: "neon", model: "gpt-9", effort: "max", hotkeys: { ask: "B" }, extra: 1 });
  assert.deepEqual({ ...s, hotkeys: { ...s.hotkeys } }, { ...DEFAULTS, hotkeys: { ...DEFAULTS.hotkeys } });
  assert.equal("extra" in s, false);
  assert.deepEqual(normalize(null), normalize({}));
  assert.deepEqual(normalize("garbage"), normalize({}));
});

test("valid choices are kept, and speed snaps to its steps within range", () => {
  const s = normalize({ voice: 9, speed: 1.12, talkBack: "never", accent: "coral", appearance: "dark", model: MODELS[2].id, effort: "low" });
  assert.equal(s.voice, 9);
  assert.equal(s.speed, 1.1);
  assert.equal(normalize({ speed: 9 }).speed, 1.3);
  assert.equal(normalize({ speed: 0.1 }).speed, 0.8);
  assert.equal(normalize({ voice: 3.5 }).voice, 0);
  assert.equal(s.accent, "coral");
  assert.ok(ACCENTS[s.accent].hex.startsWith("#"));
});

test("a shortcut needs Ctrl, Alt or Win, modifiers in order, and one key", () => {
  for (const ok of ["Control+Alt+B", "Alt+Shift+F5", "Super+K", "Control+Shift+Space", "Control+Alt+Up"]) assert.ok(isHotkey(ok), ok);
  for (const bad of ["B", "Shift+B", "Alt+Control+B", "Control+Control+B", "Control+Alt+Enter", "Control+", "Control+Alt+BB", "Ctrl+B", "", null, 5]) assert.ok(!isHotkey(bad), String(bad));
});

const distinct = (hotkeys) => new Set(Object.values(hotkeys)).size === Object.keys(hotkeys).length;

test("a change that would give two actions one shortcut is refused", () => {
  const current = normalize({});
  const { settings, rejected } = update(current, { hotkeys: { ask: DEFAULTS.hotkeys.talk } });
  assert.equal(settings.hotkeys.ask, DEFAULTS.hotkeys.ask, "Ask keeps its shortcut");
  assert.deepEqual(rejected, ["hotkeys.ask"]);
  assert.ok(distinct(settings.hotkeys));
});

test("swapping is possible one step at a time, and a free shortcut is taken", () => {
  let s = normalize({});
  ({ settings: s } = update(s, { hotkeys: { talk: "Control+Alt+K" } }));
  ({ settings: s } = update(s, { hotkeys: { ask: "Control+Alt+T" } }));
  assert.equal(s.hotkeys.ask, "Control+Alt+T");
  assert.equal(s.hotkeys.talk, "Control+Alt+K");
  assert.ok(distinct(s.hotkeys));
});

test("a file with clashing shortcuts goes back to distinct defaults", () => {
  const s = normalize({ hotkeys: { ask: "Control+Alt+T" } }); // Talk's default, and Talk wasn't changed
  assert.deepEqual({ ...s.hotkeys }, { ...DEFAULTS.hotkeys });
  assert.ok(distinct(s.hotkeys));
});

test("update reports exactly the fields it refused", () => {
  const { settings, rejected } = update(normalize({}), { voice: 4, accent: "plaid", effort: "high", speed: 2 });
  assert.equal(settings.voice, 4);
  assert.equal(settings.effort, "high");
  assert.equal(settings.accent, DEFAULTS.accent);
  assert.deepEqual(rejected.sort(), ["accent", "speed"]);
});

test("save writes atomically and load reads it back", (t) => {
  const file = tempFile(t);
  const { settings } = update(normalize({}), { voice: 7, accent: "green" });
  save(file, settings);
  assert.deepEqual(load(file), { settings, recovered: false });
  assert.ok(!fs.existsSync(`${file}.tmp`), "no temporary file left");
});

test("a missing file means first run", (t) => {
  const { settings, recovered } = load(tempFile(t));
  assert.equal(recovered, false);
  assert.equal(settings.launchSetupDone, false);
});

test("a damaged file is set aside, and first-run setup isn't repeated", (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, '{"voice": 3, "accent": "gr');
  const { settings, recovered } = load(file);
  assert.equal(recovered, true);
  assert.equal(settings.launchSetupDone, true, "shortcuts and start-with-Windows aren't forced back on");
  assert.equal(settings.voice, DEFAULTS.voice);
  assert.ok(fs.existsSync(`${file}.bad`), "the damaged file is kept for inspection");
  assert.ok(!fs.existsSync(file));
});
