import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SAFE_TOOLS } from "../src/bridge.js";
import { allowRules, claudeStatus, launchSpec, setCodeAllowed, setDesktop, staleClaude, withAllowRules, withBuddy } from "../src/claude-setup.js";

const spec = launchSpec("C:\\Buddy\\Desktop Buddy.exe", "C:\\Buddy\\resources\\mcp-server.js");
const claudeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "buddy-claude-"));

test("Buddy starts buddy-mcp on its own executable, running as Node", () => {
  assert.deepEqual(spec, { command: "C:\\Buddy\\Desktop Buddy.exe", args: ["C:\\Buddy\\resources\\mcp-server.js"], env: { ELECTRON_RUN_AS_NODE: "1" } });
});

test("adding and removing Buddy leaves the rest of the Claude app's settings as they were", () => {
  const config = { preferences: { sidebarMode: "chat" }, mcpServers: { other: { command: "x" } } };
  const added = withBuddy(config, spec);
  assert.deepEqual(added, { preferences: { sidebarMode: "chat" }, mcpServers: { other: { command: "x" }, "desktop-buddy": spec } });
  assert.deepEqual(withBuddy(added, null), config);
  assert.deepEqual(withBuddy({ preferences: {} }, null), { preferences: {} }, "no empty mcpServers is left behind");
  assert.deepEqual(config.mcpServers, { other: { command: "x" } }, "the original object is untouched");
});

test("the desktop app's settings file is changed in one step, with a copy of the old one kept", () => {
  const file = path.join(claudeDir(), "claude_desktop_config.json");
  const before = JSON.stringify({ preferences: { sidebarMode: "chat" } });
  fs.writeFileSync(file, before);
  assert.equal(setDesktop(spec, file), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["desktop-buddy"], spec);
  assert.equal(fs.readFileSync(`${file}.before-buddy`, "utf8"), before);
  assert.equal(setDesktop(null, file), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { preferences: { sidebarMode: "chat" } });
});

test("a settings file Buddy can't read is left exactly as it was", () => {
  const file = path.join(claudeDir(), "claude_desktop_config.json");
  fs.writeFileSync(file, "{ half-written");
  assert.match(setDesktop(spec, file), /couldn't read/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ half-written");
});

test("status says whether each Claude app has Buddy, or isn't installed", () => {
  const dir = claudeDir();
  const paths = { desktop: () => path.join(dir, "Claude", "claude_desktop_config.json"), code: () => path.join(dir, ".claude.json") };
  assert.deepEqual(claudeStatus(paths), { code: "missing", desktop: "missing" });
  fs.mkdirSync(path.join(dir, "Claude"));
  fs.writeFileSync(paths.code(), JSON.stringify({ mcpServers: { buddy: spec } }));
  assert.deepEqual(claudeStatus(paths), { code: "added", desktop: "absent" });
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
  assert.deepEqual(withAllowRules({}, rules, false), {}, "no empty permissions block is left behind");
});

test("Claude Code's settings file is changed only if Buddy can read it", () => {
  const file = path.join(claudeDir(), "settings.json");
  fs.writeFileSync(file, "{ not json");
  assert.match(setCodeAllowed(["mcp__desktop-buddy__look"], true, file), /couldn't read/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ["Read"] } }));
  assert.equal(setCodeAllowed(["mcp__desktop-buddy__look"], true, file), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions.allow, ["Read", "mcp__desktop-buddy__look"]);
});

test("Buddy added under its old name, or from where it used to be, is moved to this Buddy", () => {
  const dir = claudeDir();
  const paths = { desktop: () => path.join(dir, "Claude", "claude_desktop_config.json"), code: () => path.join(dir, ".claude.json") };
  fs.mkdirSync(path.join(dir, "Claude"));
  const write = (which, servers) => fs.writeFileSync(paths[which](), JSON.stringify({ mcpServers: servers }));
  write("code", { "desktop-buddy": { type: "stdio", ...spec } });
  write("desktop", { other: { command: "x" } });
  assert.deepEqual(staleClaude(spec, paths), [], "up to date, or never added");
  write("desktop", { buddy: spec });
  assert.deepEqual(staleClaude(spec, paths), ["desktop"], "old name");
  assert.deepEqual(claudeStatus(paths).desktop, "added");
  write("code", { "desktop-buddy": launchSpec("C:\dev\electron.exe", "C:\dev\src\mcp-server.js") });
  assert.deepEqual(staleClaude(spec, paths), ["code", "desktop"], "Buddy moved");
  assert.deepEqual(withBuddy({ mcpServers: { buddy: spec, other: { command: "x" } } }, spec).mcpServers, { other: { command: "x" }, "desktop-buddy": spec });
  assert.deepEqual(withBuddy({ mcpServers: { buddy: spec } }, null), {}, "removing clears the old name too");
});

test("Claude Code allow rules from Buddy's old name are replaced, the user's own kept", () => {
  const rules = allowRules(["look"]);
  const old = { permissions: { allow: ["Read", "mcp__buddy__look", "mcp__buddy__point_at"] } };
  assert.deepEqual(withAllowRules(old, rules, true).permissions.allow, ["Read", "mcp__desktop-buddy__look"]);
  assert.deepEqual(withAllowRules(old, rules, false).permissions.allow, ["Read"]);
});
