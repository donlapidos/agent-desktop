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
 * @param {{ show: (request: Request<B>) => void, clear: () => void, trace?: (entry: object) => void, armMs?: number, now?: () => number }} card
 *   show puts a request on the card (it's now the oldest waiting); clear takes the card down (nothing waits).
 *   armMs: an answer this soon after a request reaches the card is ignored (a click already on its way doesn't count).
 */
export function createApprovalQueue({ show: showCard, clear, trace, armMs = 0, now = Date.now }) {
  /** @type {Request<B>[]} */
  const waiting = [];
  let shownAt = 0;
  const show = (/** @type {Request<B>} */ request) => {
    shownAt = now();
    showCard(request);
  };

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
      if (!waiting.length) return false;
      if (now() - shownAt < armMs) {
        trace?.({ kind: "confirm-too-soon", ms: now() - shownAt });
        return false;
      }
      return settle(waiting[0], decision);
    },

    /** How many requests are waiting. */
    size: () => waiting.length,

    /** The request on the card, or null. */
    current: () => waiting[0] ?? null,
  };
}
