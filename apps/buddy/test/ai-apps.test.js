import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SAFE_TOOLS } from "../src/bridge.js";
import { APPS, APP_IDS, allowRules, appStatus, launchSpec, setApp, setCodeAllowed, staleApps, withAllowRules, withBuddy } from "../src/ai-apps.js";

const EXE = "C:\\Buddy\\Desktop Buddy.exe";
const SCRIPT = "C:\\Buddy\\resources\\mcp-server.js";
const specFor = (id) => launchSpec(EXE, SCRIPT, id);
/** An empty home with no AI apps; `install` makes an app's settings folder, as installing it would. */
function pc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-apps-"));
  const p = { home: path.join(root, "home"), appData: path.join(root, "roaming"), localAppData: path.join(root, "local") };
  for (const d of Object.values(p)) fs.mkdirSync(d, { recursive: true });
  const install = (id, text) => {
    const file = APPS[id].file(p);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (text != null) fs.writeFileSync(file, text);
    return file;
  };
  return { p, install };
}

test("each app starts buddy-mcp on Buddy's own executable, running as Node, and says which app it is", () => {
  assert.deepEqual(specFor("codex"), { command: EXE, args: [SCRIPT], env: { ELECTRON_RUN_AS_NODE: "1", BUDDY_CLIENT: "Codex" } });
  assert.equal(specFor("vscode").env.BUDDY_CLIENT, "Copilot");
});

test("adding and removing Buddy leaves the rest of an app's settings as they were, old name included", () => {
  const config = { preferences: { sidebarMode: "chat" }, mcpServers: { other: { command: "x" }, buddy: { command: "old" } } };
  const added = withBuddy(config, specFor("desktop"));
  assert.deepEqual(added, { preferences: { sidebarMode: "chat" }, mcpServers: { other: { command: "x" }, "desktop-buddy": specFor("desktop") } });
  assert.deepEqual(withBuddy(added, null), { preferences: { sidebarMode: "chat" }, mcpServers: { other: { command: "x" } } });
  assert.deepEqual(withBuddy({ preferences: {} }, null), { preferences: {} }, "no empty server list is left behind");
  assert.deepEqual(withBuddy({}, { a: 1 }, "servers"), { servers: { "desktop-buddy": { a: 1 } } }, "VS Code keeps its servers under 'servers'");
});

test("each JSON app gets Buddy in its own file and format, with a copy of the old file kept", async () => {
  const { p, install } = pc();
  for (const id of APP_IDS.filter((x) => APPS[x].via === "json")) {
    const before = JSON.stringify({ theme: "dark" });
    const file = install(id, before);
    assert.equal(await setApp(id, specFor(id), p), null, id);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(written.theme, "dark", `${id}: the app's own settings stay`);
    const entry = written[APPS[id].key ?? "mcpServers"]["desktop-buddy"];
    assert.equal(entry.command, EXE, id);
    assert.equal(entry.env.BUDDY_CLIENT, APPS[id].client, id);
    assert.equal(fs.readFileSync(`${file}.before-buddy`, "utf8"), before, `${id}: backup`);
  }
  assert.equal(JSON.parse(fs.readFileSync(APPS.vscode.file(p), "utf8")).servers["desktop-buddy"].type, "stdio", "VS Code entries say they're stdio");
  assert.equal(await setApp("cursor", null, p), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(APPS.cursor.file(p), "utf8")), { theme: "dark" });
});

test("an app that isn't installed is left alone, and a settings file Buddy can't read is left exactly as it was", async () => {
  const { p, install } = pc();
  assert.match(await setApp("gemini", specFor("gemini"), p), /isn't on this PC/);
  assert.ok(!fs.existsSync(path.dirname(APPS.gemini.file(p))), "no folder is made for an app that isn't there");
  const file = install("cursor", "{ half-written");
  assert.match(await setApp("cursor", specFor("cursor"), p), /couldn't read/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ half-written");
  install("windsurf", "");
  assert.equal(await setApp("windsurf", specFor("windsurf"), p), null, "an empty file counts as no settings yet");
});

test("status and repair read every app, Codex's TOML included", () => {
  const { p, install } = pc();
  assert.equal(Object.values(appStatus(p)).every((s) => s === "missing"), true);
  install("desktop", JSON.stringify({ mcpServers: { buddy: { command: EXE, args: [SCRIPT], env: { ELECTRON_RUN_AS_NODE: "1" } } } }));
  install("cursor", JSON.stringify({ mcpServers: { "desktop-buddy": specFor("cursor") } }));
  install("gemini", JSON.stringify({ mcpServers: {} }));
  install("codex", [
    'model = "gpt-6.1-sol"',
    "",
    "[mcp_servers.github]",
    'url = "https://api.githubcopilot.com/mcp/"',
    "",
    "[mcp_servers.desktop-buddy]",
    `command = '${EXE}'`,
    "args = ['C:\\dev\\buddy\\src\\mcp-server.js']",
    "",
    "[mcp_servers.desktop-buddy.env]",
    'ELECTRON_RUN_AS_NODE = "1"',
    'BUDDY_CLIENT = "Codex"',
    "",
    "[marketplaces.x]",
    'source = "y"',
  ].join("\n"));
  const status = appStatus(p);
  assert.equal(status.desktop, "added", "the old name counts as added");
  assert.equal(status.cursor, "added");
  assert.equal(status.gemini, "absent");
  assert.equal(status.codex, "added");
  assert.equal(status.vscode, "missing");
  assert.deepEqual(staleApps(specFor, p).sort(), ["codex", "desktop"], "old name (Claude app), moved Buddy (Codex); Cursor is up to date");
});

test("a Codex entry under the old name, and one that's current, are read right", () => {
  const { p, install } = pc();
  install("codex", ["[mcp_servers.buddy]", `command = '${EXE}'`, `args = ['${SCRIPT}']`, "", "[mcp_servers.buddy.env]", 'ELECTRON_RUN_AS_NODE = "1"'].join("\n"));
  assert.deepEqual(staleApps(specFor, p), ["codex"], "old name");
  install("codex", ["[mcp_servers.desktop-buddy]", `command = '${EXE}'`, `args = ['${SCRIPT}']`, "", "[mcp_servers.desktop-buddy.env]", 'BUDDY_CLIENT = "Codex"', 'ELECTRON_RUN_AS_NODE = "1"'].join("\n"));
  assert.deepEqual(staleApps(specFor, p), [], "up to date");
});

test("an entry without the app's name is repaired, so the island can say who's asking", () => {
  const { p, install } = pc();
  install("cursor", JSON.stringify({ mcpServers: { "desktop-buddy": { command: EXE, args: [SCRIPT], env: { ELECTRON_RUN_AS_NODE: "1" } } } }));
  assert.deepEqual(staleApps(specFor, p), ["cursor"]);
});

test("Claude Code may run Buddy's look-and-point tools without stopping, and only those", () => {
  const rules = allowRules(SAFE_TOOLS);
  assert.ok(rules.includes("mcp__desktop-buddy__point_at") && rules.includes("mcp__desktop-buddy__guide_steps"));
  for (const acts of ["act", "window", "launch_app", "create_document"]) assert.ok(!rules.includes(`mcp__desktop-buddy__${acts}`), `${acts} still asks`);
  const mine = { permissions: { allow: ["Bash(git status)"], defaultMode: "auto" }, model: "opus" };
  const added = withAllowRules(mine, rules, true);
  assert.deepEqual(added.permissions.allow, ["Bash(git status)", ...rules]);
  assert.deepEqual(withAllowRules(added, rules, true).permissions.allow, added.permissions.allow, "adding twice doesn't duplicate");
  assert.deepEqual(withAllowRules(added, rules, false), mine, "removing Buddy leaves the user's own rules");
  assert.deepEqual(withAllowRules({ permissions: { allow: ["Read", "mcp__buddy__look"] } }, allowRules(["look"]), true).permissions.allow, ["Read", "mcp__desktop-buddy__look"], "old-name rules replaced");
});

test("Claude Code's settings file is changed only if Buddy can read it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-claude-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, "{ not json");
  assert.match(setCodeAllowed(["mcp__desktop-buddy__look"], true, file), /couldn't read/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ["Read"] } }));
  assert.equal(setCodeAllowed(["mcp__desktop-buddy__look"], true, file), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow, ["Read", "mcp__desktop-buddy__look"]);
});
