// Permission slips. Anything that operates the user's computer (a click, keystrokes, opening an app, moving a window)
// runs only through desktop.perform(), and perform() takes only a slip from this module. There are exactly two ways
// to get one:
//   requestApproval()  an agent's action. The Agents policy (policy.js) is consulted first: an app it blocks gets no
//                      slip at all, an action it allows gets one without asking, and anything else only after the
//                      user says yes on the approval card (or "Allow for this task").
//   dictationPaste()   the user's own dictation: one Ctrl+V into the app they're typing in, and nothing else.
//   returnFocus()      giving the keyboard back to the window the user was working in when they called Buddy
//                      (clicking Buddy's bubble takes it); it can only focus that one window.
// Slips can't be forged (they are checked against a private set, not by shape) and each one works once.
import { decide } from "./policy.js";

/**
 * One input action, as the agent-desktop CLI runs it. `kind` and `app` are what the Agents policy judges.
 * @typedef {{ kind: string, app?: string | null, args: string[], headed: boolean, summary: string }} InputAction
 */

/** @typedef {{ readonly brand: unique symbol }} SlipBrand */

/**
 * An approved input action. Only this module creates one.
 * @typedef {Readonly<InputAction> & SlipBrand} Approved
 */

/**
 * The user's answer on the approval card.
 * @typedef {"allow" | "always" | "deny"} Decision
 */

/** @type {WeakSet<object>} */
const issued = new WeakSet();

/**
 * How to ask. `standing` is the answer's "Allow for this task": once true, later requests in the same answer pass
 * unasked. `policy` is the user's Agents settings; without one, every action is asked about.
 * @typedef {{
 *   confirm: (summary: string, bounds: import("./geometry.js").PhysicalRect | null, note?: string) => Promise<Decision | string>,
 *   bounds?: import("./geometry.js").PhysicalRect | null,
 *   note?: string,
 *   standing: { allowed: boolean },
 *   policy?: import("./policy.js").AgentPolicy,
 * }} Ask
 */

/** @param {InputAction} action @returns {Approved} */
function issue(action) {
  const slip = /** @type {Approved} */ (/** @type {unknown} */ (Object.freeze({
    kind: action.kind,
    app: action.app ?? null,
    args: Object.freeze([...action.args]),
    headed: action.headed,
    summary: action.summary,
  })));
  issued.add(slip);
  return slip;
}

/**
 * Asks the user whether Buddy may do what `summary` says. For things that aren't input actions (writing a document);
 * input actions use requestApproval, which needs the slip.
 * @param {string} summary
 * @param {Ask} how
 * @returns {Promise<boolean>}
 */
export async function askUser(summary, { confirm, bounds = null, note, standing }) {
  if (standing.allowed) return true;
  const decision = await confirm(summary, bounds, note);
  if (decision === "always") standing.allowed = true;
  return decision === "allow" || decision === "always";
}

/**
 * Gets a slip for an agent's `action`: refused when the policy blocks its app, issued unasked when the policy allows
 * it, otherwise only if the user approves. Resolves the slip, or null.
 * @param {InputAction} action
 * @param {Ask} how
 * @returns {Promise<Approved | null>}
 */
export async function requestApproval(action, how) {
  const verdict = how.policy ? decide(how.policy, action) : "ask";
  if (verdict === "block") return null;
  if (verdict === "ask" && !(await askUser(action.summary, how))) return null;
  return issue(action);
}

/** The user pressed their dictation key and spoke: one paste of it into the app they're in. */
export const dictationPaste = () => issue({ kind: "paste", app: null, args: ["press", "ctrl+v"], headed: true, summary: "Paste what you dictated" });

/**
 * The keyboard goes back to the window the user was in (as Buddy recorded it when called, from list-windows): only
 * focus-window, only for that window.
 * @param {{ app_name: string, id: string }} win
 */
export const returnFocus = (win) =>
  issue({ kind: "focus", app: win.app_name, args: ["focus-window", "--app", win.app_name, "--window-id", win.id], headed: true, summary: `Give the keyboard back to ${win.app_name}` });

/**
 * Uses up a slip: true the first time a real slip is redeemed, false for anything else.
 * @param {unknown} slip
 * @returns {slip is Approved}
 */
export function redeem(slip) {
  if (typeof slip !== "object" || slip === null || !issued.has(slip)) return false;
  issued.delete(slip);
  return true;
}
