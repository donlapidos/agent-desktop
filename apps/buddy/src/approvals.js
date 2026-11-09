// Permission slips. Anything that operates the user's computer (a click, keystrokes, opening an app, moving a window)
// runs only through desktop.perform(), and perform() takes only a slip from this module. The one way to get a slip
// is requestApproval(), which asks the user (or finds they said "Allow for this task"). Slips can't be forged (they
// are checked against a private set, not by shape) and each one works once.

/**
 * One input action, as the agent-desktop CLI runs it.
 * @typedef {{ args: string[], headed: boolean, summary: string }} InputAction
 */

/** @typedef {{ readonly brand: unique symbol }} SlipBrand */

/**
 * An approved input action. Only requestApproval() creates one.
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
 * unasked.
 * @typedef {{
 *   confirm: (summary: string, bounds: import("./geometry.js").PhysicalRect | null, note?: string) => Promise<Decision | string>,
 *   bounds?: import("./geometry.js").PhysicalRect | null,
 *   note?: string,
 *   standing: { allowed: boolean },
 * }} Ask
 */

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
 * Asks the user to approve `action`. Resolves the slip, or null when they said no.
 * @param {InputAction} action
 * @param {Ask} how
 * @returns {Promise<Approved | null>}
 */
export async function requestApproval(action, how) {
  if (!(await askUser(action.summary, how))) return null;
  const slip = /** @type {Approved} */ (/** @type {unknown} */ (Object.freeze({ args: [...action.args], headed: action.headed, summary: action.summary })));
  issued.add(slip);
  return slip;
}

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
