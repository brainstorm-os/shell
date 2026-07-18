/**
 * Every renderer that calls `initAnalytics()` must allow Amplitude EU hosts
 * in its CSP meta. Without connect-src / script-src / worker-src allowlists
 * the browser blocks telemetry (and floods the console).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AMPLITUDE_EU_CONNECT_SRC, AMPLITUDE_EU_SCRIPT_SRC, AMPLITUDE_WORKER_SRC } from "./csp";

/** Repo root: packages/sdk/src/analytics → ../../../.. */
const REPO_ROOT = resolve(__dirname, "../../../..");

function extractCsp(html: string, label: string): string {
	const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
	if (!m || typeof m[1] !== "string") {
		throw new Error(`CSP meta tag not found in ${label}`);
	}
	return m[1];
}

function directive(policy: string, name: string): string | null {
	const parts = policy.split(";").map((p) => p.trim());
	const hit = parts.find((p) => p.startsWith(`${name} `) || p === name);
	return hit ?? null;
}

function collectIndexHtmls(): { label: string; path: string }[] {
	const out: { label: string; path: string }[] = [];
	const shell = join(REPO_ROOT, "packages/shell/src/renderer/index.html");
	out.push({ label: "shell", path: shell });

	const appsDir = join(REPO_ROOT, "apps");
	for (const name of readdirSync(appsDir).sort()) {
		const indexPath = join(appsDir, name, "src/index.html");
		try {
			if (statSync(indexPath).isFile()) {
				out.push({ label: `apps/${name}`, path: indexPath });
			}
		} catch {
			// app without index.html
		}
	}
	return out;
}

describe("Amplitude CSP allowlist constants", () => {
	it("pins EU hosts used by serverZone: EU", () => {
		expect(AMPLITUDE_EU_CONNECT_SRC).toBe("https://*.eu.amplitude.com");
		expect(AMPLITUDE_EU_SCRIPT_SRC).toBe("https://cdn.eu.amplitude.com");
		expect(AMPLITUDE_WORKER_SRC).toBe("'self' blob:");
	});
});

describe("renderer CSP allows Amplitude EU (beta analytics)", () => {
	const files = collectIndexHtmls();

	it("discovers shell + first-party app index.html files", () => {
		expect(files.some((f) => f.label === "shell")).toBe(true);
		expect(files.length).toBeGreaterThan(10);
	});

	for (const { label, path } of files) {
		it(`${label} connect-src / script-src / worker-src allow Amplitude EU`, () => {
			const policy = extractCsp(readFileSync(path, "utf-8"), label);

			const connect = directive(policy, "connect-src");
			expect(connect, `${label}: connect-src`).toBeTruthy();
			expect(connect).toContain(AMPLITUDE_EU_CONNECT_SRC);
			// Opening connect-src must still allow same-origin (and not only Amplitude).
			expect(connect).toMatch(/connect-src[^;]*'self'/);

			const script = directive(policy, "script-src");
			expect(script, `${label}: script-src`).toBeTruthy();
			expect(script).toContain(AMPLITUDE_EU_SCRIPT_SRC);
			expect(script).not.toMatch(/'unsafe-eval'/);
			expect(script).not.toMatch(/'unsafe-inline'/);

			const worker = directive(policy, "worker-src");
			expect(worker, `${label}: worker-src`).toBeTruthy();
			expect(worker).toContain("blob:");
			expect(worker).toContain("'self'");
		});
	}
});
