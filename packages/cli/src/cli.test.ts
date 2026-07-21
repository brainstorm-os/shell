import { TokenSetAppearance } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { type CliIo, runCli } from "./cli";

function io(files: Record<string, string> = {}): CliIo & {
	out: string[];
	err: string[];
	written: Record<string, string>;
} {
	const out: string[] = [];
	const err: string[] = [];
	const written: Record<string, string> = {};
	return {
		out,
		err,
		written,
		readFile: (path) => {
			if (!(path in files)) throw new Error(`no such file: ${path}`);
			return files[path] as string;
		},
		writeFile: (path, contents) => {
			written[path] = contents;
		},
		log: (line) => out.push(line),
		error: (line) => err.push(line),
	};
}

const CLEAN = JSON.stringify({
	name: "Solarized",
	appearance: TokenSetAppearance.Dark,
	stylePack: { name: "Polish", css: ".x { color: var(--color-accent-default); }" },
});

describe("runCli", () => {
	it("usage error (exit 2) on missing/unknown command", () => {
		const i = io();
		expect(runCli([], i)).toBe(2);
		expect(runCli(["frobnicate"], i)).toBe(2);
		expect(runCli(["pack"], i)).toBe(2); // no input path
	});

	it("packs to stdout (exit 0)", () => {
		const i = io({ "theme.json": CLEAN });
		expect(runCli(["pack", "theme.json"], i)).toBe(0);
		expect(i.out.join("\n")).toContain('"name": "Solarized"');
	});

	it("packs to --out file (exit 0)", () => {
		const i = io({ "theme.json": CLEAN });
		expect(runCli(["pack", "theme.json", "--out", "bundle.json"], i)).toBe(0);
		expect(i.written["bundle.json"]).toContain("Solarized");
		expect(i.out.some((l) => l.includes("packed →"))).toBe(true);
	});

	it("validation failure → exit 1 + reports issues", () => {
		const bad = JSON.stringify({
			name: "Bad",
			appearance: "dark",
			stylePack: { name: "x", css: "@import 'evil.css';" },
		});
		const i = io({ "theme.json": bad });
		expect(runCli(["pack", "theme.json"], i)).toBe(1);
		expect(i.err.some((l) => l.includes("pack failed"))).toBe(true);
	});

	it("unreadable file → exit 1", () => {
		expect(runCli(["pack", "missing.json"], io())).toBe(1);
	});
});
