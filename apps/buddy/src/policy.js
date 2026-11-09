// Where agents may work and how much they may do without asking (Settings › Agents). Every input action an agent
// wants to take is put to decide() before anything else: "block" refuses it outright, "allow" lets approvals.js issue
// its slip without asking, "ask" shows the approval card as before. The user's own dictation doesn't pass through
// here; it isn't an agent acting.

/**
 * @typedef {{ rope: string, trustedApps: string[], blockedApps: string[] }} AgentPolicy
 * @typedef {"click" | "double_click" | "right_click" | "set_value" | "type" | "clear" | "check" | "uncheck" | "toggle"
 *   | "expand" | "collapse" | "select" | "scroll_to" | "press" | "focus" | "restore" | "minimize" | "maximize"
 *   | "launch"} ActionKind
 */

// Moves that only change what's in view: they can't enter, send, delete or change anything.
export const SAFE_KINDS = Object.freeze(new Set(["scroll_to", "expand", "collapse", "focus", "restore", "minimize", "maximize"]));

/** The same app however it's written: "Excel", "EXCEL.EXE", " excel ". */
export const appKey = (name) => String(name ?? "").trim().toLowerCase().replace(/\.exe$/, "");

const listed = (list, app) => !!app && list.some((x) => appKey(x) === app);

/**
 * @param {AgentPolicy} policy
 * @param {{ kind: string, app?: string | null }} action
 * @returns {"block" | "allow" | "ask"}
 */
export function decide(policy, { kind, app }) {
  const a = appKey(app);
  if (listed(policy.blockedApps, a)) return "block";
  if (policy.rope === "trusted" && listed(policy.trustedApps, a)) return "allow";
  if ((policy.rope === "safe" || policy.rope === "trusted") && SAFE_KINDS.has(kind)) return "allow";
  return "ask";
}
