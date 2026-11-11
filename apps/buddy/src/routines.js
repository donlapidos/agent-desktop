// When routines run. A routine is a task Buddy starts on a schedule ("weekdays at 9:00, summarise my unread mail"); it
// runs in its own task window, tucked into the island, under the same Agents rules as any task, so anything that
// needs the user's OK waits for them. Times are local. These functions are pure; main.js does the running.

/** @typedef {import("./settings.js").Schedule} Schedule */
/** @typedef {import("./settings.js").Routine} Routine */

// A run missed by less than this (the PC was asleep, or Buddy wasn't running) still happens, once; an older one is
// skipped, so a laptop opened on Monday doesn't replay the weekend.
export const CATCH_UP_MS = 6 * 60 * 60_000;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** @param {string} time "HH:MM" */
const hm = (time) => time.split(":").map(Number);

/** The times a schedule runs on one day, as minutes after midnight. */
function slots(schedule) {
  const [h, m] = hm(schedule.time);
  const start = h * 60 + m;
  if (schedule.every !== "hours") return [start];
  const out = [];
  for (let t = start; t < 24 * 60; t += schedule.hours * 60) out.push(t);
  return out;
}

/** Whether the schedule runs at all on this date. */
function runsOn(schedule, date) {
  const d = date.getDay();
  if (schedule.every === "weekday") return d >= 1 && d <= 5;
  if (schedule.every === "week") return schedule.days.includes(d);
  return true;
}

/**
 * The first time after `after` that the schedule runs.
 * @param {Schedule} schedule
 * @param {Date} after
 * @returns {Date}
 */
export function nextRun(schedule, after) {
  const times = slots(schedule);
  for (let day = 0; day < 8; day++) {
    const date = new Date(after.getFullYear(), after.getMonth(), after.getDate() + day);
    if (!runsOn(schedule, date)) continue;
    for (const minutes of times) {
      const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60);
      if (at > after) return at;
    }
  }
  throw new Error("A schedule with no times");
}

/**
 * What to do with a routine now: "run" it, "skip" a run missed too long ago, or "wait".
 * `since` is when it last ran, or when it was switched on or Buddy started, whichever is later.
 * @param {Routine} routine
 * @param {Date} since
 * @param {Date} now
 * @returns {"run" | "skip" | "wait"}
 */
export function verdict(routine, since, now) {
  if (!routine.enabled) return "wait";
  const due = nextRun(routine.schedule, since);
  if (due > now) return "wait";
  return now.getTime() - due.getTime() <= CATCH_UP_MS ? "run" : "skip";
}

/** "Weekdays at 9:00", "Every 4 hours from 8:00", "Mon, Wed, Fri at 17:30". */
export function describe(schedule) {
  const at = schedule.time.replace(/^0(\d)/, "$1");
  if (schedule.every === "day") return `Every day at ${at}`;
  if (schedule.every === "weekday") return `Weekdays at ${at}`;
  if (schedule.every === "hours") return `Every ${schedule.hours === 1 ? "hour" : `${schedule.hours} hours`} from ${at}`;
  return `${schedule.days.map((d) => DAY_NAMES[d]).join(", ")} at ${at}`;
}
