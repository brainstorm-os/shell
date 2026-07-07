#!/usr/bin/env bun
// Cut a release end-to-end, no AI in the loop.
//
//   bun run release prepare 0.1.9   — branch off origin/main, bump versions,
//                                     validate the changelog entry, open the PR
//   bun run release tag 0.1.9       — after the PR merges: annotated tag on
//                                     origin/main, push (triggers release.yml)
//   bun run release site 0.1.9      — after the release publishes: write the
//                                     downloads entry into the site repo
//
// The split matches the human gates: a person merges the PR and a person
// reviews the site entry. Everything mechanical in between is scripted.
//
// Hard-won rules this encodes (each shipped a broken release once):
// - electron-builder reads packages/shell/package.json, NOT the root one; a
//   root-only bump releases the old version.
// - The in-app What's-New changelog is bundled at build time, so its entry
//   must be on main BEFORE the tag is pushed.
// - The tag must be annotated: release.yml's finalize job uses the annotation
//   subject as the release body's first line.
// - Stale local v-tags from aborted attempts block re-tagging; a local tag
//   that isn't on the remote is safe to delete.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shellPkgPath = join(repoRoot, "packages/shell/package.json");
const rootPkgPath = join(repoRoot, "package.json");
const changelogPath = join(repoRoot, "packages/shell/changelog/changelog.json");
const changelogTestPaths = [
	"packages/shell/src/main/help/changelog",
	"packages/shell/src/renderer/dashboard/changelog-gating",
];

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
		...opts,
	}).trim();
}

function runLoud(cmd, args) {
	execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
}

function fail(msg) {
	console.error(`\n✗ ${msg}`);
	process.exit(1);
}

function step(msg) {
	console.log(`\n▸ ${msg}`);
}

function parseVersionArg(v) {
	if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
		fail(`expected a version like 0.1.9, got "${v ?? ""}"`);
	}
	return v;
}

function textOf(block) {
	const t = block.text;
	if (typeof t === "string") return t;
	return t.map((r) => r.text).join("");
}

function changelogEntry(json, version) {
	return JSON.parse(json).releases.find((r) => r.version === version);
}

// The expected prepare flow is: edit the changelog in the working tree, then
// run prepare — so the changelog (and nothing else) may be dirty; the edit
// rides along onto the release branch via `git switch`.
function assertOnlyChangelogDirty() {
	// NOTE: `run()` trims the whole output, which eats the FIRST line's
	// leading status column — so parse each line by stripping the status
	// token + whitespace rather than slicing a fixed width.
	const dirty = run("git", ["status", "--porcelain"])
		.split("\n")
		.filter(Boolean)
		.map((l) => l.trimStart().replace(/^\S+\s+/, ""));
	const extra = dirty.filter((p) => p !== "packages/shell/changelog/changelog.json");
	if (extra.length > 0) {
		fail(
			`only the changelog may have uncommitted changes; commit or stash:\n  ${extra.join("\n  ")}`,
		);
	}
}

function remoteTagExists(tag) {
	return run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== "";
}

function localTagExists(tag) {
	try {
		run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`], { quiet: true });
		return true;
	} catch {
		return false;
	}
}

function bumpVersionField(path, version) {
	const src = readFileSync(path, "utf8");
	const next = src.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
	if (!next.includes(`"version": "${version}"`)) {
		fail(`could not set version in ${path}`);
	}
	writeFileSync(path, next);
}

// --- prepare -----------------------------------------------------------------

function prepare(version) {
	const tag = `v${version}`;
	const branch = `release/${tag}`;

	step("preflight");
	run("gh", ["auth", "status"], { quiet: true });
	assertOnlyChangelogDirty();
	run("git", ["fetch", "origin", "main", "--tags"]);
	if (remoteTagExists(tag)) fail(`${tag} already exists on the remote`);

	step(`branching ${branch} off origin/main (carrying your changelog edit)`);
	run("git", ["switch", "-c", branch, "origin/main"]);

	step("checking the changelog entry (must exist before tagging — it's bundled into the binary)");
	const entry = changelogEntry(readFileSync(changelogPath, "utf8"), version);
	if (!entry) {
		fail(
			`no "${version}" entry in packages/shell/changelog/changelog.json.\n  Write the What's-New entry first (copy the previous release's shape:\n  version, date, icon, title, summary ≥ 20 chars, body blocks), then re-run.`,
		);
	}
	if (!entry.title || (entry.summary ?? "").length < 20) {
		fail(`the ${version} changelog entry needs a title and a summary of at least 20 chars`);
	}
	const today = new Date().toISOString().slice(0, 10);
	if (entry.date !== today) {
		console.log(`  note: entry date is ${entry.date}, today is ${today}`);
	}

	step("bumping versions (packages/shell/package.json is the one electron-builder reads)");
	bumpVersionField(shellPkgPath, version);
	bumpVersionField(rootPkgPath, version);

	step("validating (changelog JSON + tests, biome, lint)");
	JSON.parse(readFileSync(changelogPath, "utf8"));
	runLoud("bunx", ["biome", "format", "--write", changelogPath]);
	runLoud("bun", ["--bun", "vitest", "run", ...changelogTestPaths]);
	runLoud("bun", ["run", "lint"]);

	step("committing + opening the PR");
	run("git", ["add", shellPkgPath, rootPkgPath, changelogPath]);
	run("git", ["commit", "-m", `chore(release): ${tag} — ${entry.title}`]);
	runLoud("git", ["push", "-u", "origin", branch]);
	runLoud("gh", [
		"pr",
		"create",
		"--title",
		`chore(release): ${tag} — ${entry.title}`,
		"--body",
		`Cuts ${tag}.\n\n- Version bump in \`packages/shell/package.json\` (the electron-builder source) + root.\n- In-app What's-New entry for ${version} — must merge **before** the tag is pushed (bundled at build time).\n\n${entry.summary}\n\nAfter merge: \`bun run release tag ${version}\``,
	]);

	console.log(
		`\n✓ PR opened. Merge it once CI is green (the ubuntu job runs the full suite;\n  an exit-143 SIGTERM there is a runner resource kill — rerun with\n  \`gh run rerun <id> --failed\`), then run: bun run release tag ${version}`,
	);
}

// --- tag ---------------------------------------------------------------------

function tag(version) {
	const tag = `v${version}`;

	step("preflight");
	run("git", ["fetch", "origin", "main", "--tags"]);
	if (remoteTagExists(tag)) fail(`${tag} already exists on the remote`);
	if (localTagExists(tag)) {
		console.log(`  deleting stale local ${tag} (not on the remote — an aborted attempt)`);
		run("git", ["tag", "-d", tag]);
	}

	step("verifying origin/main is release-ready");
	const shellPkg = JSON.parse(run("git", ["show", "origin/main:packages/shell/package.json"]));
	if (shellPkg.version !== version) {
		fail(
			`origin/main's packages/shell/package.json is ${shellPkg.version}, not ${version}.\n` +
				`  Did the release PR merge? (\`bun run release prepare ${version}\` opens it.)`,
		);
	}
	const entry = changelogEntry(
		run("git", ["show", "origin/main:packages/shell/changelog/changelog.json"]),
		version,
	);
	if (!entry) {
		fail(`origin/main has no ${version} changelog entry — it must merge before tagging`);
	}

	step(
		`tagging origin/main as ${tag} (annotated — the subject becomes the release body's first line)`,
	);
	run("git", [
		"tag",
		"-a",
		tag,
		"-m",
		`${tag} — ${entry.title}`,
		"-m",
		entry.summary,
		run("git", ["rev-parse", "origin/main"]),
	]);
	runLoud("git", ["push", "origin", tag]);

	console.log(
		`\n✓ ${tag} pushed. release.yml builds, signs, and publishes with generated notes.\n  Watch:  gh run list --workflow release.yml\n  Then:   bun run release site ${version}`,
	);
}

// --- site --------------------------------------------------------------------

const assetSpecs = (v) => [
	{ platform: "mac", label: "Apple silicon", file: `Brainstorm-${v}-arm64.dmg` },
	{ platform: "mac", label: "Intel", file: `Brainstorm-${v}.dmg` },
	{ platform: "windows", label: "Installer (.exe)", file: `Brainstorm-Setup-${v}.exe` },
	{ platform: "linux", label: "AppImage (x86_64)", file: `Brainstorm-${v}-x86_64.AppImage` },
	{ platform: "linux", label: "AppImage (arm64)", file: `Brainstorm-${v}-arm64.AppImage` },
	{ platform: "linux", label: "Debian (.deb)", file: `Brainstorm-${v}-amd64.deb` },
];

const siteFooter = `
macOS builds are signed with a Developer ID and notarized by Apple, so they open
without a Gatekeeper warning. Windows is currently unsigned (you may see a
SmartScreen "unknown publisher" prompt — choose **More info → Run anyway**).
Existing installs update in-app from **Settings → Updates**.

It's still a beta: keep backups of anything important. Your vault is a plain
folder you fully control.
`;

function site(version, siteDirArg) {
	const tag = `v${version}`;
	const siteDir = resolve(siteDirArg ?? join(repoRoot, "../site"));
	if (!existsSync(join(siteDir, "src/content/releases"))) {
		fail(
			`${siteDir} doesn't look like the site repo (no src/content/releases) — pass its path as the 3rd arg`,
		);
	}

	step(`checking the ${tag} release is published with all assets`);
	const release = JSON.parse(run("gh", ["release", "view", tag, "--json", "isDraft,assets,url"]));
	if (release.isDraft)
		fail(
			`${tag} is still a draft — publish it first (release.yml's finalize job does this on tag pushes)`,
		);
	const uploaded = new Set(release.assets.map((a) => a.name));
	const missing = assetSpecs(version).filter((a) => !uploaded.has(a.file));
	if (missing.length > 0) {
		fail(`release is missing assets: ${missing.map((a) => a.file).join(", ")}`);
	}

	step("writing the downloads entry from the changelog");
	const entry = changelogEntry(
		run("git", ["show", "origin/main:packages/shell/changelog/changelog.json"]),
		version,
	);
	if (!entry) fail(`origin/main has no ${version} changelog entry`);
	const highlights = entry.body.filter((b) => b.kind === "li").map(textOf);
	const prose = entry.body.filter((b) => b.kind === "p").map(textOf);
	const base = `https://github.com/brainstorm-os/shell/releases/download/${tag}`;
	const assetLines = assetSpecs(version)
		.map((a) => `  - platform: ${a.platform}\n    label: ${a.label}\n    href: ${base}/${a.file}`)
		.join("\n");
	const md = `---
date: ${new Date().toISOString().slice(0, 10)}
version: "${version}"
channel: beta
status: published
summary: ${JSON.stringify(entry.summary)}
highlights:
${highlights.map((h) => `  - ${JSON.stringify(h)}`).join("\n")}
assets:
${assetLines}
---

${prose.length > 0 ? prose.join("\n\n") : entry.summary}
${siteFooter}`;

	const outPath = join(siteDir, `src/content/releases/${version}.md`);
	writeFileSync(outPath, md);

	console.log(
		`\n✓ wrote ${outPath}\n  Review the prose (it's lifted verbatim from the in-app changelog), then\n  branch + PR in the site repo. The newest published entry becomes the\n  front-page download once merged.`,
	);
}

// --- main --------------------------------------------------------------------

const [cmd, versionArg, extraArg] = process.argv.slice(2);
if (!["prepare", "tag", "site"].includes(cmd ?? "")) {
	fail("usage: bun run release <prepare|tag|site> <version> [site-dir]");
}
const version = parseVersionArg(versionArg);
if (cmd === "prepare") prepare(version);
else if (cmd === "tag") tag(version);
else site(version, extraArg);
