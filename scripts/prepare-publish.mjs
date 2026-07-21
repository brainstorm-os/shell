#!/usr/bin/env node
/**
 * Generate a self-contained `dist/package.json` for a workspace library so it
 * can be published with `npm publish <pkg>/dist` — no reliance on npm/bun
 * applying `publishConfig` field overrides (npm ignores them; bun is
 * unverifiable here). The published tarball root is `dist/`, so entry points
 * are bare (`index.js` / `index.d.ts`) and `workspace:*` deps are pinned to the
 * concrete workspace version.
 *
 * Usage: node scripts/prepare-publish.mjs <package-dir-name>
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const pkgName = process.argv[2];
if (!pkgName) {
	console.error("usage: prepare-publish.mjs <package-dir-name>");
	process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const srcPkgPath = resolve(root, "packages", pkgName, "package.json");
const src = JSON.parse(readFileSync(srcPkgPath, "utf8"));

const workspaceVersion = (dep) => {
	const p = JSON.parse(
		readFileSync(resolve(root, "packages", dep.split("/")[1], "package.json"), "utf8"),
	);
	return `^${p.version}`;
};

const resolveDeps = (deps) => {
	if (!deps) return undefined;
	const out = {};
	for (const [name, range] of Object.entries(deps)) {
		out[name] = range.startsWith("workspace:") ? workspaceVersion(name) : range;
	}
	return out;
};

const out = {
	name: src.name,
	version: src.version,
	description: src.description,
	license: src.license,
	type: "module",
	sideEffects: src.sideEffects ?? false,
	main: "./index.js",
	module: "./index.js",
	types: "./index.d.ts",
	exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
	publishConfig: { access: "public" },
};
const deps = resolveDeps(src.dependencies);
if (deps) out.dependencies = deps;
if (src.peerDependencies) out.peerDependencies = src.peerDependencies;
if (src.peerDependenciesMeta) out.peerDependenciesMeta = src.peerDependenciesMeta;

const pkgDir = resolve(root, "packages", pkgName);
writeFileSync(resolve(pkgDir, "dist", "package.json"), `${JSON.stringify(out, null, 2)}\n`);
for (const asset of ["LICENSE", "README.md"]) {
	if (existsSync(resolve(pkgDir, asset)))
		copyFileSync(resolve(pkgDir, asset), resolve(pkgDir, "dist", asset));
}
console.log(
	`wrote packages/${pkgName}/dist/package.json →`,
	out.name,
	out.version,
	deps ? `deps=${JSON.stringify(deps)}` : "(no deps)",
);
