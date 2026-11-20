/**
 * A frame cannot exceed its page's CSP, and the page CSP must not grant more
 * than the embed catalogue uses. This pins the two together: every app page
 * that hosts web embeds lists exactly the catalogue's frame origins in
 * `frame-src` (plus its own non-remote schemes) — adding a provider without
 * its CSP entry fails here instead of rendering a silently blocked frame, and
 * a stale or widened `frame-src` fails instead of lingering as dead grant.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMBED_PROVIDERS } from "./embed-providers";

const APPS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../apps");
// Every app that mounts `<FullEditorPlugins>` over `FULL_EDITOR_NODES` can
// hold a web-embed block, so it must be able to load one.
const EMBED_HOST_APPS = ["bookmarks", "contacts", "journal", "notes", "tasks"];

function frameSrc(appId: string): string[] | null {
	const html = readFileSync(join(APPS_DIR, appId, "src/index.html"), "utf8");
	const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? "";
	const directive = csp
		.split(";")
		.map((d) => d.trim().split(/\s+/))
		.find(([name]) => name === "frame-src");
	return directive ? directive.slice(1) : null;
}

const CATALOGUE_ORIGINS = [...new Set(Object.values(EMBED_PROVIDERS).map((p) => p.frameOrigin))];

describe("app-page CSP ⇔ embed catalogue", () => {
	it("is granted by exactly the apps that mount the web-embed node", () => {
		const granting = readdirSync(APPS_DIR, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.filter((id) => {
				try {
					return (frameSrc(id) ?? []).some((src) => src.startsWith("https:"));
				} catch {
					return false;
				}
			})
			.sort();
		expect(granting).toEqual(EMBED_HOST_APPS);
	});

	it("lists every catalogue origin, and no remote origin outside the catalogue", () => {
		for (const appId of EMBED_HOST_APPS) {
			const remote = (frameSrc(appId) ?? []).filter((src) => src.includes("//"));
			expect([...remote].sort(), appId).toEqual([...CATALOGUE_ORIGINS].sort());
		}
	});

	it("never grants a wildcard, a bare scheme or a non-https remote frame", () => {
		for (const appId of EMBED_HOST_APPS) {
			for (const src of frameSrc(appId) ?? []) {
				expect(src, appId).not.toContain("*");
				expect(["https:", "http:", "data:", "blob:", "'self'"], appId).not.toContain(src);
				if (src.includes("//")) expect(src, appId).toMatch(/^https:\/\/[a-z0-9.-]+$/);
			}
		}
	});
});
