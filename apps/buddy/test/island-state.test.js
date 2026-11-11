import assert from "node:assert/strict";
import { test } from "node:test";
import { MODE_LINES, islandView } from "../src/island-state.js";

/** @type {import("../src/island-state.js").IslandFacts} */
const calm = { mode: "idle", approval: null, progress: null, transcribing: false, appCall: null, download: null, speaking: false, saying: "", notice: null, bubbleOpen: false };
const view = (facts) => islandView({ ...calm, ...facts });

test("with nothing running the island rests: idle, or Ready with the bubble open, never Listening", () => {
  assert.deepEqual(view({}), { state: "idle" });
  assert.deepEqual(view({ bubbleOpen: true }), { state: "active", text: "Ready" });
  assert.notEqual(view({ bubbleOpen: true }).state, "listening", "the microphone is off");
});

test("each mode shows itself with its latest line, or its own first line", () => {
  assert.deepEqual(view({ mode: "working" }), { state: "busy", text: MODE_LINES.working });
  assert.deepEqual(view({ mode: "working", progress: "Reading the page…" }), { state: "busy", text: "Reading the page…" });
  assert.deepEqual(view({ mode: "marking", progress: "2 marked · Enter to ask" }), { state: "picking", text: "2 marked · Enter to ask" });
  assert.deepEqual(view({ mode: "reading-marks" }), { state: "busy", text: "Reading what you marked…" });
  assert.deepEqual(view({ mode: "listening" }), { state: "listening", text: "Listening…" });
  assert.deepEqual(view({ mode: "listening", transcribing: true }), { state: "busy", text: "Got it…" });
  assert.deepEqual(view({ mode: "dictating", progress: "Dictating… 12 words" }), { state: "listening", text: "Dictating… 12 words" });
});

test("what matters most wins: an approval over everything, a running mode over an AI app, speaking, outcomes and rest", () => {
  const busy = { mode: "working", progress: "Thinking…", appCall: "Codex: Looking…", download: "Getting Buddy's voice ready… 40%", speaking: true, saying: "Click Data", notice: "Done", bubbleOpen: true };
  assert.deepEqual(view({ ...busy, approval: "Click Save" }), { state: "confirm", text: "Waiting for your OK: Click Save" });
  assert.deepEqual(view(busy), { state: "busy", text: "Thinking…" });
  assert.deepEqual(view({ ...busy, mode: "idle" }), { state: "busy", text: "Codex: Looking…" });
  assert.deepEqual(view({ ...busy, mode: "idle", appCall: null }), { state: "busy", text: "Getting Buddy's voice ready… 40%" });
  assert.deepEqual(view({ ...busy, mode: "idle", appCall: null, download: null }), { state: "speaking", text: "Click Data" });
  assert.deepEqual(view({ ...busy, mode: "idle", appCall: null, download: null, speaking: false }), { state: "done", text: "Done" });
  assert.deepEqual(view({ ...busy, mode: "idle", appCall: null, download: null, speaking: false, notice: null }), { state: "active", text: "Ready" });
});

test("a guide step spoken while an answer runs doesn't take the island from the answer's progress", () => {
  assert.deepEqual(view({ mode: "working", progress: "Pointing at Data", speaking: true, saying: "Click Data" }), { state: "busy", text: "Pointing at Data" });
});
