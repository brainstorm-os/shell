/**
 * CJS entry for `@brainstorm-os/native-embed` (plan 11.3).
 *
 * Sits in front of the auto-generated `./index.js` to wire packaged-mode binary
 * resolution, exactly like `@brainstorm-os/native`'s loader. In dev it's a
 * transparent passthrough; in packaged Electron it primes
 * `NAPI_RS_NATIVE_LIBRARY_PATH` so the auto-generated loader finds
 * `process.resourcesPath/native/brainstorm-embed.<shortname>.node`.
 *
 * `index.js` is regenerated on every `napi build`, so packaged-mode wiring
 * lives in this wrapper, not there.
 */

const { applyPackagedNativeEnv } = require("./packaged-resolver.cjs");

// `NAPI_RS_NATIVE_LIBRARY_PATH` is a GLOBAL escape hatch read by EVERY
// napi-rs-generated loader (incl. `@brainstorm-os/native`, `@napi-rs/keyring`). If
// left set, sibling addons try to load OUR binary as their own and fail. Scope
// it to our own synchronous load and restore the prior value immediately after.
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
