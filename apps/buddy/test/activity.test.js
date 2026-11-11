import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { KEEP_MS, createActivity } from "../src/activity.js";
import { runPcTool } from "../src/pc-tools.js";

/** A made-up PC (see pc-tools.test.js) with an activity log; trashed files are moved to a stand-in bin. */
function pc() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-act-"));
  const home = path.join(root, "Users", "sam");
  for (const d of ["Documents/Buddy", "AppData/Roaming/desktop-buddy"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  const places = {
    home,
    workDir: path.join(home, "Documents", "Buddy"),
    buddyData: path.join(home, "AppData", "Roaming", "desktop-buddy"),
    systemRoot: path.join(root, "Windows"),
    programFiles: [path.join(root, "Program Files")],
    programData: path.join(root, "ProgramData"),
    usersDir: path.join(root, "Users"),
  };
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const undoDir = path.join(places.buddyData, "undo");
  const log = path.join(places.buddyData, "activity.json");
  const make = () => createActivity({ file: log, undoDir, trash: async (f) => fs.renameSync(f, path.join(bin, path.basename(f))) });
  const activity = make();
  const ctx = { places, undoDir, ask: async () => true, status: () => {}, record: (c) => activity.add({ ...c, from: "Buddy" }) };
  return { places, bin, log, activity, make, ctx };
}

test("what Buddy does is listed in plain words, newest first, with what can be undone", async () => {
  const { activity, ctx } = pc();
  await runPcTool("write_file", { path: "list.txt", content: "eggs" }, ctx);
  await runPcTool("edit_file", { path: "list.txt", old_text: "eggs", new_text: "eggs, milk" }, ctx);
  await runPcTool("run_powershell", { command: "'hi'", description: "Say hi" }, ctx);
  const list = activity.list();
  assert.deepEqual(list.map((e) => e.summary), ["Say hi", `Changed list.txt in ${path.join("Documents", "Buddy")}`, `Created list.txt in ${path.join("Documents", "Buddy")}`]);
  assert.deepEqual(list.map((e) => e.canUndo), [false, true, true], "commands can't be undone automatically; files can");
});

test("undo: a file Buddy made goes to the Recycle Bin; a changed one gets its old version back", async () => {
  const { places, bin, activity, ctx } = pc();
  const file = path.join(places.workDir, "plan.md");
  await runPcTool("write_file", { path: "plan.md", content: "v1" }, ctx);
  await runPcTool("write_file", { path: "plan.md", content: "v2" }, ctx);
  const [replaced, created] = activity.list();
  assert.deepEqual(await activity.undo(replaced.id), { ok: true, message: "plan.md is back as it was." });
  assert.equal(fs.readFileSync(file, "utf8"), "v1");
  assert.match((await activity.undo(replaced.id)).message, /already undone/);
  assert.equal((await activity.undo(created.id)).ok, true);
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(path.join(bin, "plan.md"), "utf8"), "v1", "in the bin, not gone");
});

test("a file changed since Buddy changed it is only put back when the user says so again", async () => {
  const { places, activity, ctx } = pc();
  const file = path.join(places.workDir, "notes.txt");
  fs.writeFileSync(file, "mine");
  await runPcTool("edit_file", { path: "notes.txt", old_text: "mine", new_text: "buddy's" }, ctx);
  fs.writeFileSync(file, "buddy's, then mine again");
  const [edit] = activity.list();
  const first = await activity.undo(edit.id);
  assert.equal(first.ok, false);
  assert.equal(first.changed, true);
  assert.equal(fs.readFileSync(file, "utf8"), "buddy's, then mine again", "nothing lost without asking");
  assert.equal((await activity.undo(edit.id, { force: true })).ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), "mine");
  const undoCopies = fs.readdirSync(path.join(places.buddyData, "undo"));
  assert.equal(undoCopies.length, 2, "the overwritten version was kept too, in case the undo was a mistake");
});

test("the log survives a restart, and forgets what's over a week old", async () => {
  const { log, make, ctx } = pc();
  await runPcTool("write_file", { path: "a.txt", content: "a" }, ctx);
  assert.equal(make().list().length, 1);
  const saved = JSON.parse(fs.readFileSync(log, "utf8"));
  saved[0].at = new Date(Date.now() - KEEP_MS - 1000).toISOString();
  fs.writeFileSync(log, JSON.stringify(saved));
  const later = make();
  later.add({ kind: "ran", summary: "Something new", from: "Buddy" });
  assert.deepEqual(later.list().map((e) => e.summary), ["Something new"]);
  fs.writeFileSync(log, "{ broken");
  assert.deepEqual(make().list(), [], "a damaged log starts over instead of failing");
});

test("an old version that's no longer kept is said so, and nothing changes", async () => {
  const { places, activity, ctx } = pc();
  await runPcTool("write_file", { path: "x.txt", content: "1" }, ctx);
  await runPcTool("write_file", { path: "x.txt", content: "2" }, ctx);
  const [replaced] = activity.list();
  fs.rmSync(path.join(places.buddyData, "undo"), { recursive: true, force: true });
  assert.equal(activity.list()[0].canUndo, false);
  assert.match((await activity.undo(replaced.id)).message, /no longer kept/);
  assert.equal(fs.readFileSync(path.join(places.workDir, "x.txt"), "utf8"), "2");
});
