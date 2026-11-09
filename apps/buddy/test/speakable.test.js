import assert from "node:assert/strict";
import { test } from "node:test";
import { pieces, speakable } from "../src/speakable.js";

test("Markdown turns into plain speech", () => {
  assert.equal(speakable("Click **Formulas** → Insert Function"), "Click Formulas, then Insert Function.");
  assert.equal(speakable("## Steps\n- Open `File`\n- See [the docs](https://x.example)"), "Steps. Open File. See the docs.");
  assert.equal(speakable("Go to https://example.com/a?b=c now"), "Go to the link now.");
  assert.equal(speakable("Use a key, e.g. Ctrl"), "Use a key, for example, Ctrl.");
});

test("tables and code are left for the screen", () => {
  assert.equal(speakable("Here:\n| Plan | Price |\n|---|---|\n| Pro | $24 |\nDone"), "Here: Done.");
  assert.equal(speakable("Run this:\n```\nnpm start\n```\nThen wait"), "Run this: Then wait.");
});

test("numbers with points stay whole", () => {
  assert.deepEqual(pieces("It costs $24.99 a seat. Version 2.5 is out."), ["It costs $24.99 a seat.", "Version 2.5 is out."]);
});

test("the first piece is short so Buddy starts talking sooner", () => {
  const parts = pieces("Click the Formulas tab at the top of the window, then choose Insert Function from the ribbon, then search for VLOOKUP and press OK.");
  assert.ok(parts[0].length <= 60, parts[0]);
  assert.equal(parts.join(" "), "Click the Formulas tab at the top of the window, then choose Insert Function from the ribbon, then search for VLOOKUP and press OK.");
});

test("a very long run without commas is still cut between words", () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const parts = pieces(long);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= 140, `${p.length}`);
  assert.equal(parts.join(" "), `${long}.`);
});

test("nothing speakable gives nothing to say", () => {
  assert.deepEqual(pieces("| a | b |\n```\ncode\n```"), []);
});
