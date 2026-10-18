import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 9.12.26 residue — every app that mounts a `<PropertiesProvider>` and ships
 * the shared editor must hand it the real rich-text editor, or RichText
 * properties silently degrade to the plain-textarea fallback there.
 */

const APPS = fileURLToPath(new URL("../../../apps", import.meta.url));

/** Apps that legitimately keep the fallback, with why. */
const EXEMPT: Record<string, string> = {
	"form-designer":
		"does not depend on @brainstorm-os/editor; a form field is not a document fragment",
};

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
	}
	return out;
}

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function providerTags(raw: string): string[] {
	const src = stripComments(raw);
	const out: string[] = [];
	for (
		let i = src.indexOf("<PropertiesProvider");
		i !== -1;
		i = src.indexOf("<PropertiesProvider", i + 1)
	) {
		const end = src.indexOf(">", i);
		const next = src[i + "<PropertiesProvider".length];
		if (end !== -1 && next !== undefined && /[\s>]/.test(next)) out.push(src.slice(i, end + 1));
	}
	return out;
}

describe("richTextEditor seam wiring", () => {
	it("every PropertiesProvider mount passes richTextEditor", () => {
		const missing: string[] = [];
		for (const app of readdirSync(APPS)) {
			const dir = join(APPS, app, "src");
			if (EXEMPT[app] || !statSync(join(APPS, app)).isDirectory()) continue;
			let files: string[];
			try {
				files = walk(dir);
			} catch {
				continue;
			}
			for (const file of files) {
				for (const tag of providerTags(readFileSync(file, "utf8"))) {
					if (!tag.includes("richTextEditor")) missing.push(relative(APPS, file));
				}
			}
		}
		expect(missing).toEqual([]);
	});
});
