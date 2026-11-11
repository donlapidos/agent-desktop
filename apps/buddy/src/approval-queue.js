// The approval card's queue. Buddy's own chat and the AI apps using Buddy (bridge.js) can each be waiting for the
// user's OK at the same time; the card shows the oldest request, and the rest wait their turn. Each request is settled
// exactly once: by the user's answer on the card, or "deny" as soon as whoever asked stops (its abort signal), so a
// cancelled request never leaves a card up or a caller waiting forever.

/**
 * @template B
 * @typedef {{ summary: string, bounds: B | null, note?: string, resolve: (decision: string) => void }} Request
 */

/**
 * @template B
 * @param {{ show: (request: Request<B>) => void, clear: () => void, trace?: (entry: object) => void }} card
 *   show puts a request on the card (it's now the oldest waiting); clear takes the card down (nothing waits).
 */
export function createApprovalQueue({ show, clear, trace }) {
  /** @type {Request<B>[]} */
  const waiting = [];

  /** @param {Request<B>} request @param {string} decision */
  function settle(request, decision) {
    const at = waiting.indexOf(request);
    if (at < 0) return false;
    waiting.splice(at, 1);
    request.resolve(decision);
    if (at === 0) {
      if (waiting.length) show(waiting[0]);
      else clear();
    }
    return true;
  }

  return {
    /**
     * Waits for the user's OK. Resolves their decision ("allow", "always", "deny"), or "deny" if `signal` aborts first.
     * @param {string} summary @param {B | null} bounds @param {string} [note] @param {AbortSignal} [signal]
     * @returns {Promise<string>}
     */
    ask(summary, bounds, note, signal) {
      if (signal?.aborted) return Promise.resolve("deny");
      return new Promise((resolve) => {
        /** @type {Request<B>} */
        const request = { summary, bounds, note, resolve };
        waiting.push(request);
        signal?.addEventListener("abort", () => settle(request, "deny"), { once: true });
        if (waiting.length === 1) show(request);
        else trace?.({ kind: "confirm-queued", waiting: waiting.length });
      });
    },

    /** The user answered the card: settles the request it shows. Returns whether one was waiting. */
    answer(/** @type {string} */ decision) {
      return waiting.length ? settle(waiting[0], decision) : false;
    },

    /** How many requests are waiting. */
    size: () => waiting.length,

    /** The request on the card, or null. */
    current: () => waiting[0] ?? null,
  };
}
