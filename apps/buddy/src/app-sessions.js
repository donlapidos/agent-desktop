// The AI apps' sessions with Buddy (bridge.js): each connection (one Codex chat, one Claude Code session…) gets a
// Brain of its own, so one session's window, "Allow for this task", pointer and cancel never reach another's. Within
// a session, calls run one at a time, each with its own abort: the Brain's tools read `brain.abort`, so two calls at
// once would share it. A call cancelled while it waits its turn never runs. A session's "Allow for this task" lapses
// after `gapMs` without a call (the next request is a new task), and its Brain goes when the connection closes.

/**
 * @template B
 * @param {{ makeBrain: (conn: number, client: string) => B, gapMs: number, now?: () => number }} o
 */
export function createAppSessions({ makeBrain, gapMs, now = Date.now }) {
  /** @type {Map<number, { brain: B, client: string, lastCall: number, queue: Promise<unknown> }>} */
  const sessions = new Map();

  return {
    /**
     * Runs `work` for session `conn`, after any call of its already running. Resolves its result, or a line saying it
     * was cancelled before it started.
     * @template T
     * @param {number} conn @param {string} client @param {AbortSignal} signal
     * @param {(brain: B) => Promise<T>} work
     * @returns {Promise<T | string>}
     */
    call(conn, client, signal, work) {
      let s = sessions.get(conn);
      if (!s) {
        s = { brain: makeBrain(conn, client), client, lastCall: 0, queue: Promise.resolve() };
        sessions.set(conn, s);
      }
      const session = s;
      const turn = session.queue.then(async () => {
        if (signal.aborted) return "Cancelled before it started.";
        const brain = /** @type {any} */ (session.brain);
        if (now() - session.lastCall > gapMs) brain.standing = new Set();
        session.lastCall = now();
        const abort = new AbortController();
        signal.addEventListener("abort", () => abort.abort(), { once: true });
        brain.abort = abort;
        return work(session.brain);
      });
      // The next call waits for this one to settle, whether it worked or not.
      session.queue = turn.catch(() => {});
      return turn;
    },

    /** The connection closed: its Brain goes. */
    close(/** @type {number} */ conn) {
      sessions.delete(conn);
    },

    size: () => sessions.size,
  };
}
