/**
 * CJS entry for `@brainstorm-os/native-image` (Asset-B4b).
 *
 * Sits in front of the auto-generated `./index.js` to wire packaged-mode
 * binary resolution — the same shape as `@brainstorm-os/native`'s loader. In
 * dev this is a transparent passthrough; in packaged Electron mode it primes
 * `NAPI_RS_NATIVE_LIBRARY_PATH` so the auto-generated loader picks the binary
 * up from `process.resourcesPath/native/...` (placed there by the shell's
 * electron-builder extraResources block).
 */

const { applyPackagedNativeEnv } = require("./packaged-resolver.cjs");

// `NAPI_RS_NATIVE_LIBRARY_PATH` is a GLOBAL escape hatch read by EVERY
// napi-rs-generated loader — leaving it set makes sibling addons load OUR
// binary as their own. Scope it to our own synchronous load and restore.
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
