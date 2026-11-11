// App updates. An installed Buddy checks its GitHub releases (a minute after starting, then every six hours, when
// Settings allows), downloads a newer version in the background, and installs it the next time Buddy quits or when
// the user chooses to restart. electron-updater checks every download against the SHA-512 published with the
// release. A source checkout doesn't update itself; it updates with git.
import { app } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

// What went wrong, in words that say whether there's anything to do about it.
export function describeError(err) {
  const m = String(err?.message ?? err);
  // A repository with no published release yet answers 404: nothing for the user to fix.
  if (/\b404\b|no published versions|Cannot find latest/i.test(m)) return "No releases published yet";
  // Only an installer build carries app-update.yml; a quick unpacked build can't update itself.
  if (/app-update\.yml/i.test(m)) return "This build can't update itself";
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|net::ERR_/i.test(m)) return "Couldn't reach GitHub to check";
  if (/sha512 checksum mismatch/i.test(m)) return "The download didn't match its checksum, so it was thrown away";
  return "Couldn't check for updates";
}

const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

/**
 * @typedef {{
 *   status: "source" | "idle" | "checking" | "downloading" | "ready" | "current" | "error",
 *   version: string, next: string | null, progress: number, error: string | null, checkedAt: string | null,
 * }} UpdateState
 */

/**
 * @param {{ enabled: () => boolean, onChange: (state: UpdateState) => void, trace?: (entry: object) => void }} deps
 */
export function createUpdates({ enabled, onChange, trace = () => {} }) {
  /** @type {UpdateState} */
  let state = { status: app.isPackaged ? "idle" : "source", version: app.getVersion(), next: null, progress: 0, error: null, checkedAt: null };
  const set = (patch) => {
    state = { ...state, ...patch };
    onChange(state);
  };

  if (!app.isPackaged) return { state: () => state, check: async () => {}, install: () => {}, start: () => {} };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on("checking-for-update", () => set({ status: "checking", error: null }));
  autoUpdater.on("update-available", (info) => set({ status: "downloading", next: info.version, progress: 0 }));
  autoUpdater.on("update-not-available", () => set({ status: "current", checkedAt: new Date().toISOString() }));
  autoUpdater.on("download-progress", (p) => set({ progress: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", (info) => {
    set({ status: "ready", next: info.version, checkedAt: new Date().toISOString() });
    trace({ kind: "update-ready", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    set({ status: "error", error: describeError(err), checkedAt: new Date().toISOString() });
    trace({ kind: "update-error", error: String(err?.message ?? err).slice(0, 200) });
  });

  const busy = () => state.status === "checking" || state.status === "downloading" || state.status === "ready";
  const check = async () => {
    if (busy()) return;
    await autoUpdater.checkForUpdates().catch(() => {}); // reported through the "error" event
  };

  return {
    state: () => state,
    check,
    // Quits, installs the downloaded version, and starts Buddy again.
    install: () => state.status === "ready" && autoUpdater.quitAndInstall(false, true),
    start: () => {
      setTimeout(() => enabled() && check(), FIRST_CHECK_MS);
      setInterval(() => enabled() && check(), CHECK_EVERY_MS);
    },
  };
}
