// Turning Buddy's written replies into what the voice (Supertonic) should say, in pieces sized for smooth playback.

// Replies are written for reading; strip what doesn't survive being said aloud. Each line (a heading, a list item)
// ends as a sentence so it gets a pause; tables and code are left for the screen.
export function speakable(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link")
    .replace(/^\s*(#{1,6}|[-*•]|\d+[.)])\s+/gm, "")
    .replace(/\*\*|__|\*|(?<=\s|^)_|_(?=\s|$)/g, "")
    .replace(/\s*[→›»]\s*/g, ", then ")
    .replace(/\be\.g\.,?/gi, "for example,")
    .replace(/\bi\.e\.,?/gi, "that is,")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;,]$/.test(line) ? line : `${line}.`))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Speakable pieces: sentences, with long ones cut at commas (and the first one cut early) so Buddy starts talking
// sooner and each piece is synthesized while the one before it plays. Synthesis runs at roughly the speed of
// speech on battery, so short pieces are what keep the pauses between them short.
const PIECE_CHARS = 140;
const FIRST_PIECE_CHARS = 60;

export function pieces(text) {
  // A sentence ends at . ! ? ; : followed by a space, so "2.5" and "$24.99" stay whole.
  const sentences = speakable(text).split(/(?<=[.!?;:])\s+/).filter(Boolean);
  const out = [];
  for (const s of sentences) {
    const limit = () => (out.length ? PIECE_CHARS : FIRST_PIECE_CHARS);
    if (s.length <= limit()) {
      out.push(s);
      continue;
    }
    let cur = "";
    for (const part of s.split(/(?<=,)\s+/)) {
      if (cur && `${cur} ${part}`.length > limit()) {
        out.push(cur);
        cur = part;
      } else cur = cur ? `${cur} ${part}` : part;
    }
    // A long run with no commas is cut between words.
    if (cur.length > 2 * PIECE_CHARS) out.push(...cur.match(new RegExp(`.{1,${PIECE_CHARS}}(\\s|$)`, "g")).map((x) => x.trim()));
    else if (cur) out.push(cur);
  }
  return out.filter((s) => /\w/.test(s));
}
