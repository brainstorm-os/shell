#!/usr/bin/env node
/**
 * Generate a self-contained `dist/package.json` for a workspace library so it
 * can be published with `npm publish <pkg>/dist` — no reliance on npm/bun
 * applying `publishConfig` field overrides (npm ignores them; bun is
 * unverifiable here). The published tarball root is `dist/`, so entry points
 * are bare and `workspace:*` deps are pinned to the concrete workspace version.
 *
 * The dist `exports` map is derived from the source `exports` map, transforming
 * `./src/X.ts` → `{types:./X.d.ts, default:./X.js}` and `./src/X.css` → `./X.css`
 * (the .css file is copied into dist). If tsup extracted component CSS from
 * side-effect imports into `dist/index.css`, it is exposed as `./styles.css`.
 *
 * Usage: node scripts/prepare-publish.mjs <package-dir-name>
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const pkgName = process.argv[2];
if (!pkgName) {
	console.error("usage: prepare-publish.mjs <package-dir-name>");
	process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const pkgDir = resolve(root, "packages", pkgName);
const src = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"));

const workspaceVersion = (dep) => {
	const p = JSON.parse(
		readFileSync(resolve(root, "packages", dep.split("/")[1], "package.json"), "utf8"),
	);
	return `^${p.version}`;
};
const resolveDeps = (deps) => {
	if (!deps) return undefined;
	return Object.fromEntries(
		Object.entries(deps).map(([n, r]) => [n, r.startsWith("workspace:") ? workspaceVersion(n) : r]),
	);
};

// `./src/foo.ts` → `./foo`, `./src/foo/index.ts` → `./foo/index`, `./src/foo.css` → `./foo.css`
const toDist = (v) => v.replace(/^\.\/src\//, "./");
const copyCss = (rel) => {
	const from = resolve(pkgDir, "src", rel.replace(/^\.\//, ""));
	const to = resolve(pkgDir, "dist", rel.replace(/^\.\//, ""));
	mkdirSync(dirname(to), { recursive: true });
	copyFileSync(from, to);
};

const distExports = {};
for (const [subpath, value] of Object.entries(src.exports ?? { ".": "./src/index.ts" })) {
	const dist = toDist(value);
	if (dist.endsWith(".css")) {
		copyCss(dist);
		distExports[subpath] = dist;
	} else {
		const base = dist.replace(/\.tsx?$/, "");
		distExports[subpath] = { types: `${base}.d.ts`, default: `${base}.js` };
	}
}
// component CSS tsup extracted from side-effect imports
if (existsSync(resolve(pkgDir, "dist", "index.css")) && !distExports["./styles.css"]) {
	distExports["./styles.css"] = "./index.css";
}

const rootEntry = distExports["."];
const out = {
	name: src.name,
	version: src.version,
	description: src.description,
	license: src.license,
	type: "module",
	sideEffects: src.sideEffects ?? false,
	main: rootEntry?.default ?? "./index.js",
	module: rootEntry?.default ?? "./index.js",
	types: rootEntry?.types ?? "./index.d.ts",
	exports: distExports,
	publishConfig: { access: "public" },
};
const deps = resolveDeps(src.dependencies);
if (deps) out.dependencies = deps;
if (src.peerDependencies) out.peerDependencies = src.peerDependencies;
if (src.peerDependenciesMeta) out.peerDependenciesMeta = src.peerDependenciesMeta;

writeFileSync(resolve(pkgDir, "dist", "package.json"), `${JSON.stringify(out, null, 2)}\n`);
for (const asset of ["LICENSE", "README.md"]) {
	if (existsSync(resolve(pkgDir, asset)))
		copyFileSync(resolve(pkgDir, asset), resolve(pkgDir, "dist", asset));
}
console.log(
	`wrote packages/${pkgName}/dist/package.json →`,
	out.name,
	`(${Object.keys(distExports).length} exports)`,
	deps ? `deps=${Object.keys(deps).length}` : "",
);
