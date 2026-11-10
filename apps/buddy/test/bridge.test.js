import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BRIDGE_TOOLS, INSTRUCTIONS, pipeName, startBridge } from "../src/bridge.js";

const helper = path.resolve("src/mcp-server.js");
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "buddy-bridge-"));
const testPipe = () => pipeName(`test-${process.pid}-${Math.random().toString(36).slice(2)}`);

async function claude(dir) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [helper], env: { ...process.env, BUDDY_DATA_DIR: dir } }));
  return client;
}

test("Claude's apps get Buddy's tools and guidance, and calls run in Buddy", async () => {
  const dir = tempDir();
  const calls = [];
  const bridge = startBridge({
    dir,
    pipe: testPipe(),
    run: async (name, input) => {
      calls.push({ name, input });
      return name === "screenshot" ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] : `ran ${name}`;
    },
  });
  const client = await claude(dir);
  try {
    assert.equal(client.getInstructions(), INSTRUCTIONS);
    assert.match(INSTRUCTIONS, /Default to GUIDE mode/);
    assert.doesNotMatch(INSTRUCTIONS, /^You are Buddy/m, "Buddy's own persona isn't Claude's");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), BRIDGE_TOOLS.map((t) => t.name));
    const said = await client.callTool({ name: "point_at", arguments: { ref: "@s1:e1", caption: "Click Insert" } });
    assert.deepEqual(said.content, [{ type: "text", text: "ran point_at" }]);
    assert.deepEqual(calls[0], { name: "point_at", input: { ref: "@s1:e1", caption: "Click Insert" } });
    const seen = await client.callTool({ name: "screenshot", arguments: {} });
    assert.deepEqual(seen.content, [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
  } finally {
    await client.close();
    bridge.close();
  }
  assert.ok(!fs.existsSync(path.join(dir, "bridge.json")), "closing Buddy removes the token file");
});

test("only a client with Buddy's token is served", async () => {
  const dir = tempDir();
  const pipe = testPipe();
  let ran = false;
  const bridge = startBridge({ dir, pipe, run: async () => { ran = true; return "ran"; } });
  try {
    const s = net.connect(pipe, () => {
      s.write(`${JSON.stringify({ id: 1, method: "hello", token: "not-the-token" })}\n`);
      s.write(`${JSON.stringify({ id: 2, method: "tool", name: "act", input: {} })}\n`);
    });
    const closed = await new Promise((resolve) => {
      s.on("data", () => resolve(false));
      s.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    s.destroy();
    assert.equal(closed, true, "Buddy hangs up on a wrong token");
    assert.equal(ran, false);
  } finally {
    bridge.close();
  }
});

test("a call Claude cancels is cancelled in Buddy", async () => {
  const dir = tempDir();
  let aborted = false;
  const bridge = startBridge({
    dir,
    pipe: testPipe(),
    run: (_name, _input, signal) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve("stopped"); })),
  });
  const client = await claude(dir);
  try {
    const ctl = new AbortController();
    const pending = client.callTool({ name: "wait_for_user", arguments: { steps: ["Table Design"] } }, undefined, { signal: ctl.signal }).catch(() => "cancelled");
    await new Promise((r) => setTimeout(r, 300));
    ctl.abort();
    await pending;
    for (let i = 0; i < 20 && !aborted; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(aborted, true);
  } finally {
    await client.close();
    bridge.close();
  }
});

test("with Buddy closed, Claude is told how to start it", async () => {
  const client = await claude(tempDir());
  try {
    const res = await client.callTool({ name: "look", arguments: {} });
    assert.match(res.content[0].text, /Buddy isn't running/);
  } finally {
    await client.close();
  }
});
