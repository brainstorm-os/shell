/**
 * Packaged-mode native binary resolution for `@brainstorm/native-embed`
 * (plan 11.3). Sibling of `@brainstorm/native`'s resolver — same strategy,
 * different binary name (`brainstorm-embed`).
 *
 * In dev (`bun run dev`, vitest) the auto-generated `./index.js` resolves the
 * .node next to it. In packaged Electron builds the electron-builder config
 * places it under `process.resourcesPath/native/brainstorm-embed.<shortname>.node`
 * (alongside `brainstorm-native` + the ONNX Runtime shared lib), and we prime
 * `NAPI_RS_NATIVE_LIBRARY_PATH` so the auto-generated loader picks it up.
 *
 * Pure functions only — no side effects on require/import.
 */

const { existsSync } = require("node:fs");
const { join } = require("node:path");

/** process.platform + process.arch → napi-rs short-name binary suffix, or null
 *  for an unsupported combination (caller falls back to the dev loader). */
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

/** Absolute path the packaged binary should live at, or null if unmapped. */
function buildPackagedNativePath(resourcesPath, platform, arch) {
	const shortname = getNapiShortname(platform, arch);
	if (!shortname) return null;
	return join(resourcesPath, "native", `brainstorm-embed.${shortname}.node`);
}

/** Resolve the packaged-mode .node path, or null in dev / unmapped / absent.
 *  Pure — never throws, no env mutation. */
function resolvePackagedNativePath(env = process) {
	const resourcesPath = env.resourcesPath;
	if (!resourcesPath || typeof resourcesPath !== "string") return null;
	const candidate = buildPackagedNativePath(resourcesPath, env.platform, env.arch);
	if (!candidate) return null;
	if (!existsSync(candidate)) return null;
	return candidate;
}

/** Prime `NAPI_RS_NATIVE_LIBRARY_PATH` if a packaged binary exists. Idempotent;
 *  leaves an already-set value untouched. Returns the resolved path or null. */
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
