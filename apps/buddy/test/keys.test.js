import assert from "node:assert/strict";
import { test } from "node:test";
import { keyFor, keyRecord, originOf } from "../src/keys.js";

test("a key saved for one server goes only to that server", () => {
  const saved = keyRecord(JSON.stringify({ key: "secret-1", origin: "https://llm.example.com" }));
  assert.equal(keyFor(saved, "https://llm.example.com/v1"), "secret-1");
  assert.equal(keyFor(saved, "https://llm.example.com/other/v1"), "secret-1", "any path on the same server");
  assert.equal(keyFor(saved, "https://evil.example.net/v1"), null, "another host gets no key");
  assert.equal(keyFor(saved, "https://llm.example.com:8443/v1"), null, "another port is another server");
  assert.equal(keyFor(saved, "http://llm.example.com/v1"), null, "and so is plain http");
  assert.equal(keyFor(saved, "not a url"), null);
});

test("keys saved before keys knew their address still load, and bare keys of fixed providers stay bare", () => {
  assert.deepEqual(keyRecord("sk-proj-abc"), { key: "sk-proj-abc", origin: null });
  assert.equal(keyFor(keyRecord("sk-proj-abc"), "https://api.openai.com/v1"), "sk-proj-abc");
  assert.deepEqual(keyRecord('{"something":"else"}'), { key: '{"something":"else"}', origin: null }, "only a stored record is read as one");
  assert.equal(originOf("http://localhost:11434/v1"), "http://localhost:11434");
  assert.equal(originOf(null), null);
});
