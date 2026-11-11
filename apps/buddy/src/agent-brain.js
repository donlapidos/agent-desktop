// Spike (BUDDY_ENGINE=sdk): Brain on the Claude Agent SDK. Buddy's own tools, approval slips, policy and UI stay as
// they are; Claude Code runs the conversation and adds files, PowerShell and the web, each asked about in plain words.
import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { askUser } from "./approvals.js";
import { Brain, FAILURES, SYSTEM, TOOLS } from "./brain.js";

// The built-in tools an everyday Buddy offers. The developer ones (cron, worktrees, workflows, notebooks...) stay off.
const BUILT_IN = ["Read", "Write", "Edit", "Glob", "Grep", "PowerShell", "WebFetch", "WebSearch", "TodoWrite"];

const EVERYDAY = `

Beyond the screen:
- You can also work with the user's files, run PowerShell on their PC, and search and read the web. Use these when
  they're the quickest way to get something done (renaming or sorting files, converting, tidying folders, finding
  something on the web), and use the screen tools when the job is in an app.
- Your working folder is their Documents\\Buddy folder. Keep anything you make there unless they name another place.
- The user is not a developer. Never show commands, code or file paths unless they ask; say what you did in plain
  words. Every PowerShell call needs a short plain description of what it does for them, like "Rename 3 photos".
- Never delete permanently: move things to the Recycle Bin instead
  ([Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(path, 'OnlyErrorDialogs', 'SendToRecycleBin')).
- Your Buddy tools are named mcp__buddy__<name> (mcp__buddy__point_at, mcp__buddy__look, ...).`;

/** Buddy's tool results as MCP content: text stays text, screenshots become MCP images. */
function toMcp(result) {
  if (typeof result === "string") return { content: [{ type: "text", text: result }] };
  return {
    content: result.map((b) => (b.type === "image" ? { type: "image", data: b.source.data, mimeType: b.source.media_type } : { type: "text", text: String(b.text ?? "") })),
  };
}

const base = (p) => path.basename(String(p ?? ""));

/** What a built-in tool call will do, for the approval card. */
// Which "Allow for this task" a built-in tool falls under (approvals.js scopes).
function scopeOf(name, input) {
  if (name === "PowerShell") return "powershell";
  if (name === "Write" || name === "Edit") return "files";
  if (name === "WebFetch") {
    try {
      return `web:${new URL(String(input.url)).host}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function describeBuiltIn(name, input) {
  switch (name) {
    case "PowerShell": return { summary: String(input.description || "Run a command on your PC"), note: String(input.command ?? "").slice(0, 300) };
    case "Write": return { summary: `Create ${base(input.file_path)}`, note: path.dirname(String(input.file_path ?? "")) };
    case "Edit": return { summary: `Change ${base(input.file_path)}`, note: path.dirname(String(input.file_path ?? "")) };
    case "WebFetch": {
      let host = "a web page";
      try { host = new URL(String(input.url)).host; } catch {}
      return { summary: `Open ${host}`, note: String(input.url ?? "") };
    }
    default: return { summary: `Use ${name}`, note: undefined };
  }
}

/** Environment for the agent: the user's own Claude Code settings and logins never leak in. */
function agentEnv(apiKey, configDir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)_/i.test(k)));
  return { ...env, ANTHROPIC_API_KEY: apiKey, CLAUDE_CONFIG_DIR: configDir };
}

export class AgentBrain extends Brain {
  /** @param {import("./brain.js").BrainUI & { apiKey: string, agentDir: string }} ui */
  constructor(ui) {
    super(ui);
    this.mcp = createSdkMcpServer({
      name: "buddy",
      alwaysLoad: true,
      tools: TOOLS.map((t) =>
        tool(t.name, t.description, /** @type {any} */ (z.fromJSONSchema(/** @type {any} */ (t.input_schema))).shape, async (input) => {
          const start = Date.now();
          const result = await this.runTool(t.name, input ?? {});
          this.ui.trace?.({ kind: "tool", name: t.name, ms: Date.now() - start, chars: typeof result === "string" ? result.length : undefined });
          this.lastEvent = Date.now();
          return toMcp(result);
        }),
      ),
    });
    this.open();
  }

  reset() {
    super.reset();
    this.live?.close();
    this.live = null;
    if (this.mcp) this.open();
  }

  // One live session per conversation, started ahead of the first question so its start-up isn't on the user's clock.
  open() {
    const queue = [];
    let wake = null;
    const live = {
      closed: false,
      push: (msg) => { queue.push(msg); wake?.(); },
      close: () => { live.closed = true; wake?.(); live.query.close(); },
    };
    async function* input() {
      for (;;) {
        while (!queue.length && !live.closed) await new Promise((r) => { wake = r; });
        if (live.closed) return;
        yield queue.shift();
      }
    }
    const agentDir = this.ui.agentDir ?? "";
    fs.mkdirSync(agentDir, { recursive: true });
    if (this.ui.documentsDir) fs.mkdirSync(this.ui.documentsDir, { recursive: true });
    live.query = query({
      prompt: input(),
      options: {
        model: this.model,
        effort: this.effort,
        systemPrompt: SYSTEM + EVERYDAY,
        settingSources: [],
        persistSession: false,
        permissionMode: "default",
        tools: BUILT_IN,
        cwd: this.ui.documentsDir ?? agentDir,
        mcpServers: { buddy: this.mcp },
        env: agentEnv(this.ui.apiKey ?? "", agentDir),
        stderr: (s) => this.ui.trace?.({ kind: "agent-stderr", text: s.slice(0, 500) }),
        hooks: {
          PreToolUse: [{
            onFailure: "block",
            hooks: [async (h) => {
              const input = /** @type {any} */ (h);
              this.ui.trace?.({ kind: "agent-tool", name: input.tool_name });
              // Buddy's own tools ask through their own approval path (operate, askUser); only ours are trusted.
              if (input.mcp_server) {
                const ours = input.mcp_server.source === "sdk" && input.tool_name.startsWith("mcp__buddy__");
                return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: ours ? "allow" : "deny", permissionDecisionReason: "Buddy" } };
              }
              return {};
            }],
          }],
        },
        canUseTool: async (name, input) => {
          const { summary, note } = describeBuiltIn(name, input);
          const ok = await askUser(summary, { ...this.asking({ note }), scope: scopeOf(name, input) });
          return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The user declined." };
        },
      },
    });
    live.messages = live.query[Symbol.asyncIterator]();
    this.live = live;
  }

  cancel() {
    super.cancel();
    this.live?.query.interrupt().catch(() => {});
  }

  async run(target, content) {
    this.standing = new Set();
    this.target = target;
    this.abort = new AbortController();
    if (!this.live || this.live.closed) this.open();
    const live = this.live;
    const start = Date.now();
    this.lastEvent = start;
    /** @type {string | undefined} */
    let failed;
    live.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
    try {
      for (;;) {
        const { value: m, done } = await live.messages.next();
        if (done) return "My session ended. Ask again and I'll start a fresh one.";
        if (m.type === "system" && m.subtype === "init" && m.apiKeySource !== "ANTHROPIC_API_KEY") {
          live.close();
          this.live = null;
          return "I couldn't start safely: my session wasn't using your Buddy API key, so I stopped.";
        }
        if (m.type === "assistant") {
          // A failed model call (no credit, bad key, rate limit) still ends in a "success" result whose text is the raw
          // API error; the message carries the kind, so Buddy can say it in plain words.
          if (m.error && !m.parent_tool_use_id) failed = m.error;
          // One model call can arrive as several messages (a block each); time it from the previous event to its first.
          if (m.message.id !== this.lastModelId) {
            this.lastModelId = m.message.id;
            const u = m.message.usage ?? {};
            this.ui.trace?.({ kind: "model", ms: Date.now() - (this.lastEvent ?? start), in: u.input_tokens, cached: u.cache_read_input_tokens, wrote: u.cache_creation_input_tokens, out: u.output_tokens, blocks: m.message.content.map((b) => b.type === "tool_use" ? b.name.replace("mcp__buddy__", "") : b.type) });
          } else {
            this.ui.trace?.({ kind: "model-block", blocks: m.message.content.map((b) => b.type === "tool_use" ? b.name.replace("mcp__buddy__", "") : b.type) });
          }
          this.lastEvent = Date.now();
          const said = m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
          if (said && m.message.content.some((b) => b.type === "tool_use")) this.ui.status(said);
        }
        if (m.type === "result") {
          this.ui.trace?.({ kind: "agent-turn", ms: Date.now() - start, apiMs: m.duration_api_ms, turns: m.num_turns, cost: m.total_cost_usd, subtype: m.subtype });
          if (this.abort.signal.aborted) return "Okay, stopped.";
          const reply = failed
            ? FAILURES[failed] ?? "The model call failed. Try again?"
            : m.subtype === "success" ? m.result.trim() || "Done." : "Something went wrong on my side. Try again?";
          if (failed) this.ui.trace?.({ kind: "agent-failed", error: failed });
          this.log.push({ role: "buddy", text: reply });
          return reply;
        }
      }
    } catch (err) {
      if (this.abort.signal.aborted) return "Okay, stopped.";
      this.live = null;
      throw err;
    }
  }
}
