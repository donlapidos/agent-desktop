// What Buddy changed on the user's PC, in plain words, and undoing it. Every file Buddy makes, replaces or edits, every
// document, every PowerShell run and every web page read is listed (Settings › Activity) for a week. Files can be put
// back with one click: a file Buddy made goes to the Recycle Bin, a replaced or edited one gets its old version back.
// Undo checks the file is still as Buddy left it; if the user has changed it since, undo asks before losing that.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const KEEP_MS = 7 * 24 * 3600_000;
const MAX_ENTRIES = 500;

/** A file's content fingerprint, or null when it isn't there. */
export function fingerprint(/** @type {string} */ file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/** Removes undo copies older than a week. */
export function pruneUndo(/** @type {string} */ undoDir, now = Date.now()) {
  try {
    for (const d of fs.readdirSync(undoDir)) {
      const at = Number(d.split("-")[0]);
      if (at && now - at > KEEP_MS) fs.rmSync(path.join(undoDir, d), { recursive: true, force: true });
    }
  } catch {}
}

/** Copies a file about to change into the undo folder, and clears copies older than a week. Returns the copy. */
export function keepCopy(/** @type {string} */ file, /** @type {string} */ undoDir) {
  pruneUndo(undoDir);
  const dir = path.join(undoDir, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, path.basename(file));
  fs.copyFileSync(file, copy);
  fs.writeFileSync(path.join(dir, "from.txt"), file);
  return copy;
}

/**
 * One change. `file` is what changed; `copy` its earlier version (replaced, edited); `after` the fingerprint Buddy
 * left it with, so undo can tell whether the user changed it since. `from` is who did it: "Buddy", a task, a routine.
 * @typedef {{ id: string, at: string, from: string, kind: "created" | "replaced" | "edited" | "document" | "ran" | "read", summary: string, file?: string, copy?: string, after?: string | null, undone?: string }} Change
 */

/** What can be undone, by kind. */
export const UNDOABLE = new Set(["created", "replaced", "edited", "document"]);

/**
 * @param {{ file: string, undoDir: string, trash: (file: string) => Promise<void>, onChange?: () => void }} o
 */
export function createActivity({ file, undoDir, trash, onChange }) {
  /** @type {Change[]} */
  let entries = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(saved)) entries = saved.filter((e) => e && typeof e.id === "string" && typeof e.summary === "string");
  } catch {}

  const save = () => {
    const now = Date.now();
    entries = entries.filter((e) => now - Date.parse(e.at) < KEEP_MS).slice(-MAX_ENTRIES);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 1));
      fs.renameSync(tmp, file);
    } catch {}
    onChange?.();
  };

  return {
    /** Records a change. @param {Omit<Change, "id" | "at">} change @returns {Change} */
    add(change) {
      const entry = { ...change, id: crypto.randomBytes(6).toString("hex"), at: new Date().toISOString() };
      entries.push(entry);
      save();
      return entry;
    },

    /** Newest first, each with whether it can be undone now. */
    list() {
      return entries
        .slice()
        .reverse()
        .map((e) => ({ ...e, canUndo: !e.undone && UNDOABLE.has(e.kind) && (e.kind === "created" || e.kind === "document" || (!!e.copy && fs.existsSync(e.copy))) }));
    },

    /**
     * Puts a change back. Without `force`, a file changed since Buddy changed it is left alone and `changed` says so.
     * @param {string} id @param {{ force?: boolean }} [opts]
     * @returns {Promise<{ ok: boolean, message: string, changed?: boolean }>}
     */
    async undo(id, { force = false } = {}) {
      const e = entries.find((x) => x.id === id);
      if (!e) return { ok: false, message: "That change is no longer kept." };
      if (e.undone) return { ok: false, message: "That's already undone." };
      if (!UNDOABLE.has(e.kind) || !e.file) return { ok: false, message: "Buddy can't undo this one by itself." };
      const name = path.basename(e.file);
      const now = fingerprint(e.file);
      if (now && e.after && now !== e.after && !force) return { ok: false, changed: true, message: `${name} has changed since Buddy did this. Undoing would lose those changes.` };
      if (e.kind === "created" || e.kind === "document") {
        if (now) {
          try {
            await trash(e.file);
          } catch (err) {
            return { ok: false, message: `Couldn't move ${name} to the Recycle Bin: ${err?.message ?? err}` };
          }
        }
        e.undone = new Date().toISOString();
        save();
        return { ok: true, message: `${name} is in the Recycle Bin.` };
      }
      if (!e.copy || !fs.existsSync(e.copy)) return { ok: false, message: `The old version of ${name} is no longer kept.` };
      // The version being replaced is kept too, in case the undo itself was a mistake.
      if (now) keepCopy(e.file, undoDir);
      fs.mkdirSync(path.dirname(e.file), { recursive: true });
      fs.copyFileSync(e.copy, e.file);
      e.undone = new Date().toISOString();
      save();
      return { ok: true, message: `${name} is back as it was.` };
    },
  };
}
