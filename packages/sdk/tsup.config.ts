import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// Every non-CSS subpath in the package `exports` map is a build entry, so the
// published dist mirrors the source subpaths. CSS subpaths are copied by
// scripts/prepare-publish.mjs, not bundled here.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const entry = Object.values(pkg.exports as Record<string, string>).filter(
	(v) => typeof v === "string" && !v.endsWith(".css"),
);

export default defineConfig({
	entry,
	format: "esm",
	outDir: "dist",
	tsconfig: "tsconfig.build.json",
	splitting: true,
	clean: true,
	dts: false,
	// The menu runtime re-exports 150+ names via `export *`; esbuild can't
	// resolve those through an *externalized* package, so it must be bundled.
	noExternal: ["@react-fancy-menus/core"],
	external: ["react", "react-dom"],
});
