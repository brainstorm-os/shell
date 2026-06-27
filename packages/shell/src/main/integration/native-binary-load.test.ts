/**
 * 13.1b / NAPI-1b — integration check: the @brainstorm/native loader resolves
 * via `process.resourcesPath/native/...` in packaged Electron mode.
 *
 * We can't truly run electron-builder in a unit test, so we simulate packaged
 * mode by:
 *   1. Copying the dev .node into a temp `resourcesPath/native/` layout.
 *   2. Setting `process.resourcesPath` + invoking the resolver shim.
 *   3. Asserting `NAPI_RS_NATIVE_LIBRARY_PATH` points at the staged copy AND
 *      a fresh `require()` of the auto-generated loader pulls the binding
 *      from there (round-trip an ed25519 derivation to prove the .node ran).
 *
 * The shim is the same code that runs in packaged Electron — only the
 * `process.resourcesPath` source differs (real Electron vs. our stub).
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

interface NativeResolverShim {
	applyPackagedNativeEnv: () => string | null;
	getNapiShortname: (platform: string, arch: string) => string | null;
}

describe("@brainstorm/native — packaged-mode binary load (13.1b)", () => {
	let tempDir: string;
	let savedEnv: string | undefined;
	let savedResourcesPath: unknown;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "bs-native-pkg-"));
		savedEnv = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
		savedResourcesPath = (process as unknown as Record<string, unknown>).resourcesPath;
		// biome-ignore lint/performance/noDelete: `delete` is the only way to truly unset an env var (assigning undefined coerces to the string "undefined")
		delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
	});

	afterEach(() => {
		// Best-effort: the test require()s the staged .node, and Windows locks a
		// loaded native addon's file — a leaked temp dir the OS reaps is fine.
		try {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch {
			// swallow Windows EBUSY on the still-mapped binary.
		}
		if (savedEnv === undefined) {
			// biome-ignore lint/performance/noDelete: same reason as above
			delete process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
		} else {
			process.env.NAPI_RS_NATIVE_LIBRARY_PATH = savedEnv;
		}
		if (savedResourcesPath === undefined) {
			// biome-ignore lint/performance/noDelete: tests stub process.resourcesPath as a fake property; restoring needs delete
			delete (process as unknown as Record<string, unknown>).resourcesPath;
		} else {
			(process as unknown as Record<string, unknown>).resourcesPath = savedResourcesPath;
		}
	});

	it("primes NAPI_RS_NATIVE_LIBRARY_PATH to the resourcesPath/native/<file> copy, and the binding still works end-to-end", async () => {
		const shim = require("@brainstorm/native/packaged-resolver.cjs") as NativeResolverShim;
		const shortname = shim.getNapiShortname(process.platform, process.arch);
		if (!shortname) {
			// Host platform isn't one of the six we ship for — the loader can't
			// resolve a packaged path, and there's no .node to copy. Skip cleanly
			// (the resolver unit tests cover the unsupported-host branch).
			return;
		}

		const sourceBinary = require.resolve(`@brainstorm/native/brainstorm-native.${shortname}.node`);
		const stagedNativeDir = join(tempDir, "native");
		mkdirSync(stagedNativeDir, { recursive: true });
		const stagedBinary = join(stagedNativeDir, `brainstorm-native.${shortname}.node`);
		copyFileSync(sourceBinary, stagedBinary);

		(process as unknown as Record<string, unknown>).resourcesPath = tempDir;

		const applied = shim.applyPackagedNativeEnv();
		expect(applied).toBe(stagedBinary);
		expect(process.env.NAPI_RS_NATIVE_LIBRARY_PATH).toBe(stagedBinary);

		// The loader (index.js) honours NAPI_RS_NATIVE_LIBRARY_PATH on first
		// require — invoke that path fresh so we can prove the env var was the
		// resolution driver, not the dev-mode fallback.
		const nativeJsPath = require.resolve("@brainstorm/native/index.js");
		delete require.cache[nativeJsPath];
		const binding = require(nativeJsPath) as {
			ed25519GetPublicKey: (seed: Uint8Array) => Uint8Array;
		};

		const seed = new Uint8Array(32);
		for (let i = 0; i < 32; i++) seed[i] = i;
		const pub = binding.ed25519GetPublicKey(seed);
		expect(pub).toBeInstanceOf(Uint8Array);
		expect(pub.length).toBe(32);
	});

	it("falls back to the dev loader when process.resourcesPath is unset", async () => {
		const shim = require("@brainstorm/native/packaged-resolver.cjs") as NativeResolverShim;
		// resourcesPath stays unset (deleted in beforeEach).
		const applied = shim.applyPackagedNativeEnv();
		expect(applied).toBeNull();
		expect(process.env.NAPI_RS_NATIVE_LIBRARY_PATH).toBeUndefined();
	});
});
