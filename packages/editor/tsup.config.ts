import { defineConfig } from "tsup";
export default defineConfig({
	entry: ["src/index.ts"],
	format: "esm",
	outDir: "dist",
	tsconfig: "tsconfig.build.json",
	clean: true,
	dts: false,
	external: ["react", "react-dom"],
});
