// The Settings window: one at a time, opened from the tray, the island or the bubble. It talks only to main.js through
// the functions passed in here, and every message is checked to come from this window, so no other Buddy page can
// change settings or touch the API key.
import { BrowserWindow, ipcMain } from "electron";
import path from "node:path";

const SIZE = { width: 640, height: 600 };

/**
 * @param {{
 *   here: string, icon: string,
 *   state: () => object,                                    // everything the page shows
 *   change: (patch: object) => Record<string, string>,      // apply a change; returns problems by field
 *   capture: (on: boolean) => void,                         // let go of Buddy's shortcuts while one is recorded
 *   preview: (voice: number, speed: number) => void,        // say a line in that voice
 *   setKey: (key: string) => string | null,                 // returns an error message, or null
 *   removeKey: () => void,
 *   setStartup: (on: boolean) => void,
 *   clear: (what: "explainers" | "log") => void,
 *   openData: () => void,
 *   runRoutine: (id: string) => Promise<string | null>,    // start a routine now; returns an error message, or null
 *   apps: () => Promise<string[]>,                          // apps with a window open, for suggestions
 *   requestFeature: () => void,                             // open a pre-filled feature request in the browser
 * }} deps
 */
export function createSettingsWindow(deps) {
  /** @type {BrowserWindow | null} */
  let win = null;

  function open() {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      ...SIZE,
      minWidth: 560,
      minHeight: 480,
      frame: false,
      show: false,
      backgroundColor: "#0c0d10",
      title: "Buddy Settings",
      icon: deps.icon,
      webPreferences: { preload: path.join(deps.here, "preload.cjs"), backgroundThrottling: false },
    });
    win.loadFile(path.join(deps.here, "ui/settings.html"));
    win.once("ready-to-show", () => {
      win?.show();
      win?.focus();
    });
    // Closing mid-recording must give Buddy its shortcuts back.
    win.on("closed", () => {
      win = null;
      deps.capture(false);
    });
  }

  const fromSettings = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;
  /** @param {string} channel @param {(...args: any[]) => any} fn */
  const handle = (channel, fn) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!fromSettings(e)) throw new Error("Not the settings window");
      return fn(...args);
    });

  handle("settings-state", () => deps.state());
  handle("settings-set", (patch) => ({ problems: deps.change(patch), state: deps.state() }));
  handle("settings-capture", (on) => deps.capture(!!on));
  handle("settings-preview", (voice, speed) => deps.preview(Number(voice), Number(speed)));
  handle("settings-key", (key) => ({ error: deps.setKey(String(key ?? "")), state: deps.state() }));
  handle("settings-key-remove", () => (deps.removeKey(), deps.state()));
  handle("settings-startup", (on) => (deps.setStartup(!!on), deps.state()));
  handle("settings-clear", (what) => {
    if (what !== "explainers" && what !== "log") throw new Error("Nothing to clear");
    deps.clear(what);
    return deps.state();
  });
  handle("settings-open-data", () => deps.openData());
  handle("settings-run-routine", async (id) => ({ error: await deps.runRoutine(String(id)), state: deps.state() }));
  handle("settings-apps", () => deps.apps());
  handle("settings-feature", () => deps.requestFeature());
  handle("settings-close", () => win?.close());
  handle("settings-minimize", () => win?.minimize());

  // Changes made elsewhere (the tray, a routine running, another window) show up in an open Settings window at once.
  const refresh = () => {
    if (win && !win.isDestroyed()) win.webContents.send("settings-changed", deps.state());
  };

  return { open, refresh };
}
