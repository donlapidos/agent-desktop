// buddy-mcp: the MCP server Claude's apps start to use Buddy (see bridge.js). It runs on Buddy's own executable
// (ELECTRON_RUN_AS_NODE=1), so the user needs no Node. Tools and instructions come from the bridge.json the running
// Buddy wrote; each call goes over the pipe to Buddy, which runs it. With Buddy closed, calls say how to start it.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const dataDir = process.env.BUDDY_DATA_DIR ?? path.join(process.env.APPDATA ?? "", "desktop-buddy");
const NOT_RUNNING = "Buddy isn't running. Ask the user to start Desktop Buddy (Start menu), then try again.";

function readBridge() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "bridge.json"), "utf8"));
  } catch {
    return null;
  }
}

// One pipe connection, opened on the first call and again after Buddy restarts (bridge.json then has a new token).
let conn = null;
let nextId = 1;
/** @type {Map<number, (result: unknown) => void>} */
const waiting = new Map();

function connect() {
  const bridge = readBridge();
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

async function call(name, input, signal) {
  conn ??= await connect();
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

const bridge = readBridge();
const server = new Server(
  { name: "buddy", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: bridge?.instructions ?? NOT_RUNNING },
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const current = readBridge() ?? bridge;
  const safe = new Set(current?.safe ?? []);
  return {
    tools: (current?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
      annotations: safe.has(t.name) ? { readOnlyHint: true } : { readOnlyHint: false },
    })),
  };
});
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => toMcp(await call(req.params.name, req.params.arguments ?? {}, extra.signal)));
await server.connect(new StdioServerTransport());
