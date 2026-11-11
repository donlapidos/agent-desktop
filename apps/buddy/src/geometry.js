// Two kinds of screen coordinates meet in Buddy, and mixing them up puts the pointer in the wrong place on any
// display that isn't at 100% scale (this laptop runs at 125%):
//   physical  pixels as agent-desktop reports and expects them (the CLI is per-monitor DPI aware)
//   DIP       Electron's device-independent pixels: the cursor, displays, Buddy's own windows
// They are separate types, so `npm run check` refuses one where the other belongs. The brand exists only for the
// checker; at runtime these are plain { x, y } objects. Values enter a space through the as* functions below, and
// move between spaces only through the conversions in main.js (toPhysicalPoint, toPhysicalRect, toDipRect).

/** @typedef {{ x: number, y: number }} XY */
/** @typedef {{ x: number, y: number, width: number, height: number }} XYWH */
/** @typedef {XY & { readonly __space: "dip" }} DipPoint */
/** @typedef {XYWH & { readonly __space: "dip" }} DipRect */
/** @typedef {XY & { readonly __space: "physical" }} PhysicalPoint */
/** @typedef {XYWH & { readonly __space: "physical" }} PhysicalRect */

/** Electron gives DIP: the cursor, display bounds, window bounds. @param {XY} p @returns {DipPoint} */
export const asDipPoint = (p) => /** @type {DipPoint} */ (p);
/** @param {XYWH} r @returns {DipRect} */
export const asDipRect = (r) => /** @type {DipRect} */ (r);
/** agent-desktop gives physical: element and window bounds. @param {XY} p @returns {PhysicalPoint} */
export const asPhysicalPoint = (p) => /** @type {PhysicalPoint} */ (p);
/** @param {XYWH} r @returns {PhysicalRect} */
export const asPhysicalRect = (r) => /** @type {PhysicalRect} */ (r);
