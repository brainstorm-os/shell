/**
 * CJS entry for `@brainstorm-os/native` (13.1b / NAPI-1b).
 *
 * Sits in front of the auto-generated `./index.js` to wire packaged-mode
 * binary resolution. In dev this is a transparent passthrough — the call to
 * `applyPackagedNativeEnv()` is a no-op when `process.resourcesPath` is
 * undefined or the packaged .node isn't on disk. In packaged Electron mode it
 * primes `NAPI_RS_NATIVE_LIBRARY_PATH` so the auto-generated loader picks up
 * the binary from `process.resourcesPath/native/...` (placed there by the
 * shell's electron-builder extraResources block).
 *
 * Why a wrapper instead of editing `index.js`: `index.js` is regenerated on
 * every `napi build`. Anything we patch there is destroyed on the next build.
 */

const { applyPackagedNativeEnv } = require("./packaged-resolver.cjs");

// `NAPI_RS_NATIVE_LIBRARY_PATH` is a GLOBAL escape hatch read by EVERY
// napi-rs-generated loader (the first branch of their `requireNative()`), not
// just ours. If we leave it set, sibling napi-rs addons — `@napi-rs/keyring`,
// `@napi-rs/canvas` — pick it up and try to load *brainstorm-native's* binary
// as their own, which fails ("Failed to load native binding") and, for the
// keystore, surfaces as "No OS keystore is available". So scope it to our own
// synchronous load (index.js runs `requireNative()` at module top-level) and
// restore the prior value immediately after.
const NATIVE_LIB_ENV = "NAPI_RS_NATIVE_LIBRARY_PATH";
const hadNativeLibEnv = NATIVE_LIB_ENV in process.env;
const prevNativeLibEnv = process.env[NATIVE_LIB_ENV];

applyPackagedNativeEnv();

try {
	module.exports = require("./index.js");
} finally {
	if (hadNativeLibEnv) process.env[NATIVE_LIB_ENV] = prevNativeLibEnv;
	else delete process.env[NATIVE_LIB_ENV];
}
