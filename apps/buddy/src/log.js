// Buddy's timing log (userData/timing.log, JSON lines): how long each model call and tool took, and what went wrong,
// to find slow or broken steps. It stays small: past LOG_MAX it moves to timing.old.log (replacing the one before) and
// starts again, so at most two files' worth is kept; and long text in an entry (a reply, a path) is cut short, since
// the log is for timings and outcomes, not for what the user said or saw.

import fs from "node:fs";
import path from "node:path";

export const LOG_MAX = 5 * 1024 * 1024;
const TEXT_MAX = 300;
const CHECK_EVERY = 100; // entries between size checks

/** An entry with every string in it cut to TEXT_MAX characters, nested ones included. */
export function shortened(/** @type {any} */ value) {
  if (typeof value === "string") return value.length > TEXT_MAX ? `${value.slice(0, TEXT_MAX)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(shortened);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortened(v)]));
  return value;
}

/** A log writer for `file` (and its .old next to it). @param {string} file @param {{ max?: number }} [o] */
export function createLog(file, { max = LOG_MAX } = {}) {
  let written = CHECK_EVERY; // check the size on the first entry
  const old = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.old${path.extname(file)}`);
  return {
    old,
    /** Appends one entry, with the time. Never throws: a log that can't be written mustn't break Buddy. */
    write(/** @type {object} */ entry) {
      try {
        if (++written >= CHECK_EVERY) {
          written = 0;
          if (fs.statSync(file, { throwIfNoEntry: false })?.size > max) fs.renameSync(file, old);
        }
        fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), ...shortened(entry) })}\n`);
      } catch {}
    },
  };
}
