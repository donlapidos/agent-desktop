// Use with Claude: Buddy's screen tools for Claude's own apps (Claude Code, the Claude desktop app), which run the
// conversation on the user's own Claude plan. Claude starts buddy-mcp (src/mcp-server.js); it reads bridge.json from
// Buddy's data folder and talks to this running Buddy over a named pipe. Every tool runs here, through the same Brain
// code, approval cards and Agents policy as Buddy's own conversations. A client is served only after it presents the
// token from bridge.json, which changes every time Buddy starts.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { SYSTEM, TOOLS } from "./brain.js";

export const BRIDGE_FILE = "bridge.json";
export const pipeName = (name = os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_")) => `\\\\.\\pipe\\desktop-buddy-${name}`;

// Buddy's own guidance from "How you help:" to the end of "Explaining:", for Claude's apps; Buddy's opening and its
// speech-bubble style don't apply there.
const HOW_TO_HELP = SYSTEM.split("\n\nStyle:")[0].split("\n\n").slice(1).join("\n\n");
export const INSTRUCTIONS = `These tools come from Buddy, a helper running on the user's Windows PC. Buddy can read their apps through
the accessibility tree, show them where to click with its own on-screen pointer, explain things with illustrated
field-guide plates, and, only after the user approves on Buddy's own card, operate apps for them.

The user is chatting with you in this window and working in another one. Tools that take no app use the window they
were in before they came to you, so call look first; list_windows shows the rest. While you guide, keep your chat
replies to a line: they are looking at their app, where Buddy's pointer and captions carry each step. If the user
highlighted things on screen with Buddy's marker (Ctrl+Alt+M), get_marks shows you what they marked.

Buddy's way of helping, which you follow when you use these tools ("you" below is you, working through Buddy):

${HOW_TO_HELP}`;

/** The marks tool exists only here: in Buddy's own bubble the marks arrive with the question. */
const GET_MARKS = {
  name: "get_marks",
  description: "See what the user highlighted on screen with Buddy's marker: an image of the area with their numbered strokes and what is under each. Then point_at mark=<n> can point at one.",
  input_schema: { type: "object", properties: {} },
};
export const BRIDGE_TOOLS = [...TOOLS, GET_MARKS];

// Tools that only look, read, point or show: they change nothing in the user's apps or files. Claude's apps may run
// them without stopping to check (claude-setup.js adds allow rules for them). Everything else (act, window,
// launch_app, create_document) still goes through Claude's own check and Buddy's approval card.
export const SAFE_TOOLS = Object.freeze(["look", "read_page", "screenshot", "list_windows", "point_at", "wait_for_user", "guide_steps", "show_explainer", "get_marks"]);

const sameToken = (a, b) => typeof a === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Serves Buddy's tools on the pipe. `run(name, input, signal)` runs one tool and resolves its result (text, or
 * content blocks with images). `onClients(n)` hears how many Claude sessions are connected.
 * `pipe` is for tests; Buddy uses one per Windows user.
 * @param {{ dir: string, run: (name: string, input: object, signal: AbortSignal) => Promise<unknown>, onClients?: (n: number) => void, trace?: (e: object) => void, pipe?: string }} opts
 */
export function startBridge({ dir, run, onClients, trace, pipe = pipeName() }) {
  const token = crypto.randomBytes(24).toString("hex");
  const file = path.join(dir, BRIDGE_FILE);
  fs.writeFileSync(file, JSON.stringify({ pipe, token, instructions: INSTRUCTIONS, tools: BRIDGE_TOOLS, safe: SAFE_TOOLS }), { mode: 0o600 });
  let clients = 0;

  const server = net.createServer((socket) => {
    let authed = false;
    let buf = "";
    /** @type {Map<string, AbortController>} */
    const running = new Map();
    const send = (msg) => socket.writable && socket.write(`${JSON.stringify(msg)}\n`);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 1_000_000) return socket.destroy();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return socket.destroy();
        }
        if (!authed) {
          if (msg.method !== "hello" || !sameToken(msg.token, token)) {
            trace?.({ kind: "bridge-refused" });
            return socket.destroy();
          }
          authed = true;
          onClients?.(++clients);
          trace?.({ kind: "bridge-connected", client: String(msg.client ?? "").slice(0, 80) });
          send({ id: msg.id, result: "ok" });
          continue;
        }
        if (msg.method === "cancel") {
          running.get(String(msg.id))?.abort();
          continue;
        }
        if (msg.method !== "tool" || !BRIDGE_TOOLS.some((t) => t.name === msg.name)) {
          send({ id: msg.id, result: `Unknown tool ${msg.name}.` });
          continue;
        }
        const ctl = new AbortController();
        running.set(String(msg.id), ctl);
        const start = Date.now();
        run(msg.name, msg.input ?? {}, ctl.signal)
          .then((result) => send({ id: msg.id, result }))
          .catch((err) => send({ id: msg.id, result: `Buddy couldn't do that: ${err?.message ?? err}` }))
          .finally(() => {
            running.delete(String(msg.id));
            trace?.({ kind: "bridge-tool", name: msg.name, ms: Date.now() - start });
          });
      }
    });
    const gone = () => {
      for (const ctl of running.values()) ctl.abort();
      running.clear();
      if (authed) {
        authed = false;
        onClients?.(--clients);
      }
    };
    socket.on("close", gone);
    socket.on("error", gone);
  });
  server.on("error", (err) => trace?.({ kind: "bridge-error", message: err.message }));
  server.listen(pipe);
  return {
    close() {
      server.close();
      fs.rmSync(file, { force: true });
    },
  };
}
