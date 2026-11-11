// Saved API keys, as stored (encrypted, by main.js). A key for a server at an address the user chose is stored with
// that address and only ever sent there; keys of providers at fixed addresses are stored bare, as they always were.

/** A web address's origin (scheme, host and port), or null. @param {string | null | undefined} url */
export function originOf(url) {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

/**
 * A stored key: `{"key","origin"}` for one tied to an address, or the bare key (fixed-address providers, and keys
 * saved before keys knew their address, which have no origin yet).
 * @param {string} stored @returns {{ key: string, origin: string | null }}
 */
export function keyRecord(stored) {
  try {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed.key === "string") return { key: parsed.key, origin: typeof parsed.origin === "string" ? parsed.origin : null };
  } catch {}
  return { key: stored, origin: null };
}

/**
 * The key to send to `url`: the saved one when it was saved for that origin (or before keys knew their address),
 * else none.
 * @param {{ key: string, origin: string | null }} saved @param {string | null | undefined} url
 */
export function keyFor(saved, url) {
  if (!saved.origin) return saved.key;
  return saved.origin === originOf(url) ? saved.key : null;
}
