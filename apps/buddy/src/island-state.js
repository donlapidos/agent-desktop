// What the island says, worked out in one place from what Buddy is doing, so it can't claim something that isn't so
// (it once said "Listening" with the microphone off). main.js keeps the facts and calls islandView after any change;
// nothing sets the island's state directly.
//
// The first that applies wins:
//   an approval waiting      confirm    "Waiting for your OK: …"
//   a mode running           picking (marking), busy (reading marks, working, transcribing), listening (listening,
//                            dictating), with the activity's latest progress line
//   an AI app's call running busy       "Codex: Looking…"
//   a voice download         busy       "Getting Buddy's voice ready… 40%"
//   Buddy speaking           speaking   what it's saying
//   a notice                 done       an outcome: the answer, an error, "Typed 12 words" (the island fades it)
//   the bubble open          active     "Ready"
//   otherwise                idle

/** @typedef {"idle" | "active" | "busy" | "confirm" | "picking" | "listening" | "speaking" | "done"} IslandState */

/**
 * @typedef {{
 *   mode: import("./modes.js").Mode,
 *   approval: string | null,
 *   progress: string | null,
 *   transcribing: boolean,
 *   appCall: string | null,
 *   download: string | null,
 *   speaking: boolean,
 *   saying: string,
 *   notice: string | null,
 *   bubbleOpen: boolean,
 * }} IslandFacts
 * approval: the summary on the card. progress: the running activity's latest line. appCall: "Codex: Looking…".
 */

/** What each mode says before it has said anything of its own. @type {Record<Exclude<import("./modes.js").Mode, "idle">, string>} */
export const MODE_LINES = {
  marking: "Getting the screen ready…",
  "reading-marks": "Reading what you marked…",
  listening: "Listening…",
  dictating: "Dictating…",
  working: "Thinking…",
};

/** @param {IslandFacts} f @returns {{ state: IslandState, text?: string }} */
export function islandView(f) {
  if (f.approval) return { state: "confirm", text: `Waiting for your OK: ${f.approval}` };
  if (f.mode !== "idle") {
    const text = f.progress ?? MODE_LINES[f.mode];
    if (f.mode === "marking") return { state: "picking", text };
    if (f.mode === "listening") return f.transcribing ? { state: "busy", text: "Got it…" } : { state: "listening", text };
    if (f.mode === "dictating") return { state: "listening", text };
    return { state: "busy", text };
  }
  if (f.appCall) return { state: "busy", text: f.appCall };
  if (f.download) return { state: "busy", text: f.download };
  if (f.speaking) return { state: "speaking", text: f.saying };
  if (f.notice) return { state: "done", text: f.notice };
  if (f.bubbleOpen) return { state: "active", text: "Ready" };
  return { state: "idle" };
}
