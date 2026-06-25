/**
 * pdf.js worker entry shim.
 *
 * The worker runs in its own realm, so the `Math.sumPrecise` polyfill the main
 * thread installs does not reach it. The side-effect import below installs it
 * BEFORE pdf.js's worker body evaluates — static imports run in source order,
 * dependency-first, so the install completes before the worker registers its
 * message handler. Without it, pdf.js v6 throws `Math.sumPrecise is not a
 * function` on Electron 41's Chromium 134.
 *
 * Both imports are static on purpose: a dynamic `import()` would make this a
 * code-splitting worker build, which Vite emits as IIFE and then rejects.
 */
import "./math-sum-precise-install";
import "pdfjs-dist/build/pdf.worker.min.mjs";
