/**
 * Packaged-mode native binary resolution (13.1b / NAPI-1b).
 *
 * In dev (`bun run dev`, `bun --bun vitest`), the auto-generated `./index.js`
 * resolves the .node via `require('./brainstorm-image.<napi-shortname>.node')`
 * — that file sits next to `index.js` in `packages/native/`.
 *
 * In packaged Electron builds, the .node is NOT next to `index.js`. The
 * electron-builder config (13.1b step 2) places it under
 * `process.resourcesPath/native/brainstorm-image.<napi-shortname>.node`, where
 * `<napi-shortname>` is napi-rs's short triple form (e.g. `darwin-arm64`,
 * `linux-x64-gnu`, `win32-x64-msvc`).
 *
 * Strategy: leverage the auto-generated loader's documented escape hatch —
 * the env var `NAPI_RS_NATIVE_LIBRARY_PATH`. If set, the loader requires that
 * absolute path before any of its built-in resolution branches. We probe for
 * the packaged path; if a .node sits there, we set the env var; otherwise we
 * leave it untouched and the loader's dev-path resolution wins.
 *
 * Pure functions only — no side effects on require/import.
 */

const { existsSync } = require("node:fs");
const { join } = require("node:path");

/**
 * Map process.platform + process.arch to napi-rs's short-name binary suffix.
 * Returns `null` for unsupported combinations (the caller falls back to the
 * dev loader, which has its own "unsupported" error path).
 */
function getNapiShortname(platform, arch) {
	if (platform === "darwin") {
		if (arch === "arm64") return "darwin-arm64";
		if (arch === "x64") return "darwin-x64";
		return null;
	}
	if (platform === "win32") {
		if (arch === "arm64") return "win32-arm64-msvc";
		if (arch === "x64") return "win32-x64-msvc";
		return null;
	}
	if (platform === "linux") {
		if (arch === "arm64") return "linux-arm64-gnu";
		if (arch === "x64") return "linux-x64-gnu";
		return null;
	}
	return null;
}

/**
 * Build the absolute path the packaged binary should live at, given a
 * `resourcesPath` (typically `process.resourcesPath` in packaged Electron).
 * Returns `null` if the current platform/arch isn't mapped.
 */
function buildPackagedNativePath(resourcesPath, platform, arch) {
	const shortname = getNapiShortname(platform, arch);
	if (!shortname) return null;
	return join(resourcesPath, "native", `brainstorm-image.${shortname}.node`);
}

/**
 * Resolve the packaged-mode .node path for the current process, or `null` if
 * we're in dev mode (no `process.resourcesPath`), the platform is unmapped,
 * or the expected file isn't on disk. Pure — never throws, no env mutation.
 *
 * Optional `env` parameter (defaults to `process`) is the readable env source;
 * tests inject a stub.
 */
function resolvePackagedNativePath(env = process) {
	const resourcesPath = env.resourcesPath;
	if (!resourcesPath || typeof resourcesPath !== "string") return null;
	const candidate = buildPackagedNativePath(resourcesPath, env.platform, env.arch);
	if (!candidate) return null;
	if (!existsSync(candidate)) return null;
	return candidate;
}

/**
 * If a packaged binary exists for the current process, set
 * `process.env.NAPI_RS_NATIVE_LIBRARY_PATH` so the auto-generated `index.js`
 * loader picks it up. Idempotent — if the env var is already set (by the user
 * or by a prior call), it is left untouched.
 *
 * Returns the resolved path (or `null` if nothing was applied).
 */
function applyPackagedNativeEnv() {
	if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) return process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
	const resolved = resolvePackagedNativePath(process);
	if (!resolved) return null;
	process.env.NAPI_RS_NATIVE_LIBRARY_PATH = resolved;
	return resolved;
}

module.exports = {
	getNapiShortname,
	buildPackagedNativePath,
	resolvePackagedNativePath,
	applyPackagedNativeEnv,
};
