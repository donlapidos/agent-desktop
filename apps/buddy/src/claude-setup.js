// Use with Claude, set up for the user: adds buddy-mcp (src/mcp-server.js) to Claude Code and to the Claude desktop
// app, and says whether it's there. Claude Code is changed only through its own `claude mcp` command. The desktop
// app's settings file is edited in place: everything else in it is kept, a copy of it is saved beside it first, and
// a file Buddy can't read is left alone.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SERVER = "desktop-buddy";
// Names Buddy was added under before; adding or removing Buddy clears them too. ("buddy" clashed with a feature of
// the same name in the Claude app.)
const LEGACY = ["buddy"];
const OURS = [SERVER, ...LEGACY];

/** @typedef {{ command: string, args: string[], env: Record<string, string> }} LaunchSpec */
/** @typedef {"added" | "absent" | "missing"} SetupStatus  missing: that Claude app isn't on this PC */

/** How Claude starts buddy-mcp: Buddy's own executable running as Node, so the user needs no Node. */
export const launchSpec = (exe, script) => ({ command: exe, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } });

/**
 * The desktop app's settings with Buddy added (spec) or removed (null); every other key stays as it was.
 * @param {Record<string, any>} config @param {LaunchSpec | null} spec
 */
export function withBuddy(config, spec) {
  const next = { ...config };
  const servers = { ...(config.mcpServers ?? {}) };
  for (const name of OURS) delete servers[name];
  if (spec) servers[SERVER] = spec;
  if (Object.keys(servers).length) next.mcpServers = servers;
  else delete next.mcpServers;
  return next;
}

export const PATHS = {
  desktop: () => path.join(process.env.APPDATA ?? "", "Claude", "claude_desktop_config.json"),
  code: () => path.join(os.homedir(), ".claude.json"),
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const added = (config) => OURS.some((name) => config?.mcpServers?.[name]);

/** @returns {{ code: SetupStatus, desktop: SetupStatus }} */
export function claudeStatus(paths = PATHS) {
  const code = readJson(paths.code());
  return {
    code: code ? (added(code) ? "added" : "absent") : "missing",
    desktop: fs.existsSync(path.dirname(paths.desktop())) ? (added(readJson(paths.desktop())) ? "added" : "absent") : "missing",
  };
}

/**
 * The Claude apps that have Buddy but would start it some other way than `spec`: under an old name, or from where
 * Buddy used to be (a dev copy, before installing). Buddy re-adds itself to those at startup.
 * @param {LaunchSpec} spec @returns {("code" | "desktop")[]}
 */
export function staleClaude(spec, paths = PATHS) {
  const want = JSON.stringify([spec.command, ...spec.args]);
  return /** @type {const} */ (["code", "desktop"]).filter((which) => {
    const servers = readJson(paths[which]())?.mcpServers ?? {};
    const have = OURS.filter((name) => servers[name]);
    return have.length > 0 && (have.length > 1 || have[0] !== SERVER || JSON.stringify([servers[SERVER].command, ...(servers[SERVER].args ?? [])]) !== want);
  });
}

/**
 * Adds Buddy to the Claude desktop app (spec) or takes it out (null). Resolves an error message, or null.
 * @param {LaunchSpec | null} spec
 */
export function setDesktop(spec, file = PATHS.desktop()) {
  if (!fs.existsSync(path.dirname(file))) return "The Claude desktop app isn't installed on this PC.";
  return editJson(file, (config) => withBuddy(config, spec), "Buddy couldn't read the Claude app's settings file, so it left it alone.");
}

// Changes one JSON settings file of a Claude app: a copy of the old file is kept beside it, the new one replaces it
// in a single step, and a file that doesn't parse is left exactly as it is (resolves `unreadable`).
function editJson(file, change, unreadable) {
  let config = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    try {
      config = JSON.parse(text);
    } catch {
      return unreadable;
    }
    fs.writeFileSync(`${file}.before-buddy`, text);
  }
  const tmp = `${file}.buddy-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(change(config), null, 2)}\n`);
  fs.renameSync(tmp, file);
  return null;
}

/** Claude Code's permission rules for Buddy's tools that only look, read, point or show (bridge.js SAFE_TOOLS). */
export const allowRules = (names) => names.map((n) => `mcp__${SERVER}__${n}`);
const legacyRule = (rule) => LEGACY.some((name) => rule.startsWith(`mcp__${name}__`));

/**
 * Claude Code's settings with Buddy's allow rules added (on) or taken out; every other rule and key stays.
 * @param {Record<string, any>} settings @param {string[]} rules @param {boolean} on
 */
export function withAllowRules(settings, rules, on) {
  const allow = (settings.permissions?.allow ?? []).filter((r) => !rules.includes(r) && !legacyRule(r));
  const next = { ...settings, permissions: { ...(settings.permissions ?? {}), allow: on ? [...allow, ...rules] : allow } };
  if (!next.permissions.allow.length) delete next.permissions.allow;
  if (!Object.keys(next.permissions).length) delete next.permissions;
  return next;
}

/** Lets Claude Code run Buddy's safe tools without a check each time (on), or takes that back. */
export function setCodeAllowed(rules, on, file = path.join(os.homedir(), ".claude", "settings.json")) {
  if (!fs.existsSync(path.dirname(file))) return null;
  return editJson(file, (settings) => withAllowRules(settings, rules, on), "Buddy couldn't read Claude Code's settings file, so it left it alone.");
}

// Claude Code's command: on PATH, or where its Windows installer puts it.
const CLAUDE_CODE = ["claude", path.join(os.homedir(), ".local", "bin", "claude.exe")];

function claudeCode(args) {
  return new Promise((resolve) => {
    const attempt = (i) =>
      execFile(CLAUDE_CODE[i], args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err?.code === "ENOENT" && i + 1 < CLAUDE_CODE.length) return attempt(i + 1);
        resolve(err ? { ok: false, missing: err.code === "ENOENT", text: `${stderr || stdout || err.message}`.trim() } : { ok: true, text: stdout });
      });
    attempt(0);
  });
}

/**
 * Adds Buddy to Claude Code for every project (spec) or takes it out (null). Resolves an error message, or null.
 * @param {LaunchSpec | null} spec
 */
export async function setCode(spec) {
  const have = readJson(PATHS.code())?.mcpServers ?? {};
  for (const name of OURS) if (have[name]) await claudeCode(["mcp", "remove", name, "-s", "user"]);
  if (!spec) return null;
  const env = Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const res = await claudeCode(["mcp", "add", "--scope", "user", SERVER, ...env, "--", spec.command, ...spec.args]);
  if (res.missing) return "Couldn't find Claude Code on this PC.";
  return res.ok ? null : `Claude Code said: ${res.text.slice(0, 200)}`;
}
