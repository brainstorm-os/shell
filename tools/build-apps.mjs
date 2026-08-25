#!/usr/bin/env node
// Build every app in apps/*, one at a time.
//
// Sequential on purpose: building them concurrently (`bun run --filter
// './apps/*' build`) peaked high enough to get the hosted runner's process
// group killed with SIGTERM 143 mid-build. One at a time is slower and stays
// under the ceiling.
//
// This used to be an inline POSIX `for` loop in package.json. That works in sh
// but bun runs scripts through its own cross-platform shell, which does not
// implement `for`/`do`/`done` — so the Windows leg parsed each keyword as a
// command ("bun: command not found: for") and every release built without a
// Windows artefact. It survived v0.13.0 only because the bun version pinned by
// CI at the time happened to tolerate it, and `setup-bun` asks for `latest`.
// Keeping the loop in a real script means the language is Node's, not a
// shell's, on every platform.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = join(repoRoot, "apps");

const apps = readdirSync(appsDir, { withFileTypes: true })
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort();

const failed = [];

for (const app of apps) {
	console.log(`== apps/${app} ==`);
	const { status } = spawnSync("bun", ["run", "build"], {
		cwd: join(appsDir, app),
		stdio: "inherit",
		// Windows needs the shell to resolve `bun` to bun.exe; the argv is
		// fixed here, so nothing user-supplied reaches it.
		shell: process.platform === "win32",
	});
	if (status !== 0) failed.push(app);
}

if (failed.length > 0) {
	console.error(`\n✗ ${failed.length} app(s) failed to build: ${failed.join(", ")}`);
	process.exit(1);
}

console.log(`\n✓ ${apps.length} apps built`);
