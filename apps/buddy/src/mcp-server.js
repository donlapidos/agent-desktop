// buddy-mcp: the MCP server Claude's apps start to use Buddy (see bridge.js). It runs on Buddy's own executable
// (ELECTRON_RUN_AS_NODE=1), so the user needs no Node. Tools and instructions come from claude-tools.json, which Buddy
// keeps in its data folder; each call goes over the pipe named in bridge.json to the running Buddy, which runs it.
// If Buddy is closed, the first call starts it and waits for it to be ready.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const dataDir = process.env.BUDDY_DATA_DIR ?? path.join(process.env.APPDATA ?? "", "desktop-buddy");
const NOT_RUNNING = "Buddy isn't running and didn't start. Ask the user to start Desktop Buddy (Start menu), then try again.";
const NEVER_RAN =
  "Buddy, a helper for the user's Windows PC, hasn't run on this PC yet, so its tools aren't listed. Ask the user to start Desktop Buddy (Start menu) once, then start a new chat.";
const START_WAIT_MS = 30_000;

const readJson = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"));
  } catch {
    return null;
  }
};

// Buddy itself, to start when it's closed: the installed app's own exe, or in a dev copy Electron with the app folder.
// Under plain Node (the tests) there is no Buddy to start.
function startBuddy() {
  if (!process.versions.electron) return false;
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    spawn(process.execPath, appRoot.endsWith(".asar") ? [] : [appRoot], { detached: true, stdio: "ignore", windowsHide: false, env }).unref();
    return true;
  } catch {
    return false;
  }
}

// One pipe connection, opened on the first call and again after Buddy restarts (bridge.json then has a new token).
let conn = null;
let nextId = 1;
/** @type {Map<number, (result: unknown) => void>} */
const waiting = new Map();

function connect() {
  const bridge = readJson("bridge.json");
  if (!bridge) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = net.connect(bridge.pipe);
    let buf = "";
    const c = { socket, send: (msg) => socket.write(`${JSON.stringify(msg)}\n`) };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const id = nextId++;
      waiting.set(id, () => resolve(c));
      c.send({ id, method: "hello", token: bridge.token, client: process.env.BUDDY_CLIENT ?? "claude" });
    });
    socket.on("data", (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        waiting.get(msg.id)?.(msg.result);
        waiting.delete(msg.id);
      }
    });
    const drop = () => {
      if (conn === c) conn = null;
      for (const done of waiting.values()) done(NOT_RUNNING);
      waiting.clear();
      resolve(null);
    };
    socket.on("error", drop);
    socket.on("close", drop);
  });
}

// Starts Buddy and connects once it's listening. Calls that arrive meanwhile share the one start.
let starting = null;
function startAndConnect() {
  starting ??= (async () => {
    if (!startBuddy()) return null;
    for (const until = Date.now() + START_WAIT_MS; Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 400));
      const c = await connect();
      if (c) return c;
    }
    return null;
  })().finally(() => (starting = null));
  return starting;
}

async function call(name, input, signal) {
  conn ??= (await connect()) ?? (await startAndConnect());
  if (!conn) return NOT_RUNNING;
  const id = nextId++;
  const c = conn;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    signal?.addEventListener("abort", () => c.send({ id, method: "cancel" }), { once: true });
    c.send({ id, method: "tool", name, input });
  });
}

/** Buddy's tool results as MCP content: text stays text, screenshots become MCP images. */
function toMcp(result) {
  if (typeof result === "string") return { content: [{ type: "text", text: result }] };
  if (!Array.isArray(result)) return { content: [{ type: "text", text: JSON.stringify(result) }] };
  return {
    content: result.map((b) => (b.type === "image" ? { type: "image", data: b.source.data, mimeType: b.source.media_type } : { type: "text", text: String(b.text ?? "") })),
  };
}

let offered = readJson("claude-tools.json");
const server = new Server(
  { name: "desktop-buddy", version: "0.1.0" },
  { capabilities: { tools: { listChanged: true } }, instructions: offered?.instructions ?? NEVER_RAN },
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const safe = new Set(offered?.safe ?? []);
  return {
    tools: (offered?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
      annotations: { readOnlyHint: safe.has(t.name) },
    })),
  };
});
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => toMcp(await call(req.params.name, req.params.arguments ?? {}, extra.signal)));
await server.connect(new StdioServerTransport());

// A newer Buddy (an update, or the first run) can offer different tools: tell the Claude session to list them again.
fs.watchFile(path.join(dataDir, "claude-tools.json"), { interval: 5000 }, () => {
  const now = readJson("claude-tools.json");
  if (!now || JSON.stringify(now) === JSON.stringify(offered)) return;
  offered = now;
  server.sendToolListChanged().catch(() => {});
});
for (const ev of ["end", "close"]) process.stdin.on(ev, () => process.exit(0));
