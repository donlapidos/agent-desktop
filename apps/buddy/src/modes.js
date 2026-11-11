// What Buddy is doing, one thing at a time. Every entry point (hotkeys, island, bubble, tray) checks it:
//   idle           nothing running (the bubble may be open, Buddy may be speaking)
//   marking        capturing the screen, then the still is up for drawing
//   reading-marks  the still closed; reading what's under each stroke
//   listening      the mic is open, then the words are being transcribed
//   dictating      the mic is open and what the user says is typed into the app they're in
//   working       a question or an explain is running (it may be waiting for the user's OK)
// main.js holds the current mode and changes it only through enter(), which consults canMove(). The tables are typed
// Record<Mode, …>, so adding a mode doesn't pass `npm run check` until both say what it allows.

/** @typedef {"idle" | "marking" | "reading-marks" | "listening" | "dictating" | "working"} Mode */

/** The moves each mode allows. @type {Readonly<Record<Mode, readonly Mode[]>>} */
export const NEXT = Object.freeze({
  idle: ["marking", "listening", "dictating", "working"],
  marking: ["idle", "reading-marks", "working"], // working: a click in mark mode explains the thing clicked
  "reading-marks": ["idle"],
  listening: ["idle", "working"], // working: they typed the question instead
  dictating: ["idle"],
  working: ["idle"],
});

/** What to tell someone who asks for something else while Buddy is in each mode. @type {Readonly<Record<Mode, string>>} */
export const BUSY = Object.freeze({
  idle: "",
  marking: "Finish marking first: Enter to ask, Esc to cancel",
  "reading-marks": "Reading what you marked…",
  listening: "Listening: pause when you're done",
  dictating: "Dictating: press the dictation key again to stop",
  working: "I'm still on the last thing. Give me a moment, or press Esc to stop it.",
});

/** @param {Mode} from @param {Mode} to */
export const canMove = (from, to) => from === to || NEXT[from].includes(to);

// Each task window (tasks.js) has a state of its own, shown on its chip:
//   idle     nothing running: new, or its answer has been seen
//   working  an answer is running (a status line may update it while it stays working)
//   confirm  the answer waits for the user's OK on the task's card
//   done     the answer finished while the window was tucked away or behind; seeing it makes it idle
//   error    the answer failed; the next question starts it again
/** @typedef {"idle" | "working" | "confirm" | "done" | "error"} TaskState */

/** The moves each task state allows. @type {Readonly<Record<TaskState, readonly TaskState[]>>} */
export const TASK_NEXT = Object.freeze({
  idle: ["working"],
  working: ["confirm", "done", "idle", "error"], // idle: it finished with its window in front
  confirm: ["working"], // answered, or cancelled (a "no")
  done: ["idle", "working"],
  error: ["working"],
});

/** @param {TaskState} from @param {TaskState} to */
export const canMoveTask = (from, to) => from === to || TASK_NEXT[from].includes(to);

/** A task is busy while its answer runs, waiting for an OK included. @param {TaskState} state */
export const taskBusy = (state) => state === "working" || state === "confirm";
