/**
 * `bun run new-app <id> "<Display Name>"` — scaffold a first-party app on
 * the recommended track, so it starts COMPLIANT instead of drifting:
 *  - React (createRoot) — the one ecosystem.
 *   - the shared `.app-header` chrome (44px baseline, object ⋯ slot).
 *   - a LIVE entity list via `@brainstorm-os/react-yjs`'s `useVaultEntities` —
 *     never a hand-rolled `vaultEntities.onChange` loop (the reactivity
 *     gate, tools/check-app-reactivity.mjs, rejects that).
 *
 * Generated files are inert until you register the app in
 * `packages/shell/src/main/apps/first-party.ts` and run `bun install`.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const [rawId, ...nameParts] = process.argv.slice(2);
if (!rawId || !/^[a-z][a-z0-9-]*$/.test(rawId)) {
	console.error('Usage: bun run new-app <kebab-id> "<Display Name>"');
	console.error('  e.g. bun run new-app widgets "Widgets"');
	process.exit(1);
}
const id = rawId;
/** Capitalise without an index-access non-null assertion (`charAt` returns
 *  "" out of range, so it's safe under `noUncheckedIndexedAccess`). */
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const displayName = nameParts.join(" ") || cap(id);
const comp = `${id.split("-").map(cap).join("")}App`;
const manifestId = `io.brainstorm.${id.replace(/-/g, "")}`;
const entityType = `${manifestId}/Item/v1`;

const appDir = join(ROOT, "apps", id);
if (existsSync(appDir)) {
	console.error(`apps/${id} already exists — pick another id or delete it first.`);
	process.exit(1);
}

const files: Record<string, string> = {
	"package.json": `${JSON.stringify(
		{
			name: `@brainstorm-app/${id}`,
			private: true,
			version: "0.1.0",
			type: "module",
			scripts: { build: "vite build", dev: "vite build --watch" },
			dependencies: {
				"@brainstorm-os/react-yjs": "workspace:*",
				"@brainstorm-os/sdk": "workspace:*",
				"@brainstorm-os/sdk-types": "workspace:*",
				react: "^19.0.0",
				"react-dom": "^19.0.0",
			},
			devDependencies: {
				"@types/react": "^19.0.0",
				"@types/react-dom": "^19.0.0",
				"@vitejs/plugin-react": "^4.3.0",
				typescript: "^5.6.0",
				vite: "^5.4.0",
			},
		},
		null,
		2,
	)}\n`,

	"manifest.json": `${JSON.stringify(
		{
			id: manifestId,
			name: displayName,
			version: "0.1.0",
			sdk: "1",
			description: `${displayName} app.`,
			icon: "icon.svg",
			entry: "dist/index.html",
			capabilities: ["storage.kv", "entities.read:*", `entities.write:${entityType}`],
			registrations: {
				entityTypes: [
					{
						id: entityType,
						schema: {
							type: "object",
							required: ["id", "title", "createdAt", "updatedAt"],
							properties: {
								id: { type: "string" },
								title: { type: "string" },
								createdAt: { type: "number" },
								updatedAt: { type: "number" },
							},
						},
					},
				],
			},
		},
		null,
		2,
	)}\n`,

	"tsconfig.json": `${JSON.stringify(
		{
			extends: "../../tsconfig.base.json",
			compilerOptions: {
				target: "ES2022",
				module: "ESNext",
				moduleResolution: "Bundler",
				lib: ["ES2022", "DOM", "DOM.Iterable"],
				allowJs: true,
				checkJs: false,
				noEmit: true,
				types: [],
			},
			include: ["src/**/*", "vite.config.ts"],
		},
		null,
		2,
	)}\n`,

	"vite.config.ts": `import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Per-app Vite build (mirrors apps/files/vite.config.ts). Source under
// \`src/\`; \`src/index.html\` is the entry; output to \`dist/\`. Loaded over
// \`file://\` by the shell, so \`base: "./"\` keeps asset refs relative.
export default defineConfig({
	root: resolve(__dirname, "src"),
	base: "./",
	plugins: [react()],
	build: {
		outDir: resolve(__dirname, "dist"),
		emptyOutDir: true,
		minify: false,
		sourcemap: true,
		target: "chrome130",
		rollupOptions: { input: resolve(__dirname, "src/index.html") },
	},
});
`,

	"icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
	<rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor" opacity="0.16" />
	<text x="12" y="16" text-anchor="middle" font-size="11" font-family="system-ui" fill="currentColor">${displayName.charAt(0).toUpperCase()}</text>
</svg>
`,

	"src/index.html": `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta
			http-equiv="Content-Security-Policy"
			content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: brainstorm:; media-src 'self' data: brainstorm: blob:; script-src 'self'"
		/>
		<title>${displayName}</title>
	</head>
	<body class="is-booting">
		<div id="root"></div>
		<script type="module" src="./main.tsx"></script>
	</body>
</html>
`,

	"src/css.d.ts": `/** Side-effect CSS imports carry no type; declare them so \`tsc\` resolves
 *  the specifier (mirrors apps/files/src/css.d.ts). */
declare module "*.css";
`,

	"src/runtime.ts": `/**
 * The slice of \`window.brainstorm\` this app reads. \`vaultEntities\` is the
 * live entity-snapshot service; the app subscribes to it through
 * \`@brainstorm-os/react-yjs\`'s \`useVaultEntities\`, never \`onChange\` directly.
 */

import type { VaultEntitiesService } from "@brainstorm-os/sdk-types";

export type ${comp}Runtime = {
	app?: { id: string; version: string; sdkVersion: string };
	capabilities?: readonly string[];
	services?: {
		vaultEntities?: VaultEntitiesService;
	} | null;
};

declare global {
	interface Window {
		brainstorm?: ${comp}Runtime | undefined;
	}
}

export function getBrainstorm(): ${comp}Runtime | null {
	return typeof window !== "undefined" ? (window.brainstorm ?? null) : null;
}
`,

	"src/main.tsx": `import "@brainstorm-os/sdk/app-theme.css";
import { initAnalytics } from "@brainstorm-os/sdk/analytics";
import { mountMenuHost } from "@brainstorm-os/sdk/menus";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ${comp} } from "./app";
import "./styles.css";

initAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("${displayName}: #root not found in index.html");
// Stand up the shared fancy-menus runtime (object / context menus).
mountMenuHost();
createRoot(root).render(
	<StrictMode>
		<${comp} />
	</StrictMode>,
);
`,

	"src/app.tsx": `import { useMemo } from "react";
import type { ReactElement } from "react";
import { useVaultEntities } from "@brainstorm-os/react-yjs";
import { getBrainstorm } from "./runtime";

/** The entity type this app owns. The list scopes to its OWN type — never
 *  "any entity is mine" (see the journal-own-type convention). */
const APP_TYPE = "${entityType}";

export function ${comp}(): ReactElement {
	// Live vault entities through the ONE shared reactivity stack. Adding or
	// editing one of these entities (here or on another device) re-renders
	// automatically — no hand-rolled \`vaultEntities.onChange\` loop.
	const service = getBrainstorm()?.services?.vaultEntities ?? null;
	const { entities } = useVaultEntities(service);
	const items = useMemo(() => entities.filter((e) => e.type === APP_TYPE), [entities]);

	return (
		<div className="app">
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<h1 className="app-header__title">${displayName}</h1>
				</div>
				{/* Trailing group: content actions / panel toggles first, the
				    object ⋯ menu LAST (see the app-header convention in CLAUDE.md). */}
				<div className="app-header__right" />
			</header>
			<main className="app-body">
				{items.length === 0 ? (
					<p className="app-empty">Nothing here yet.</p>
				) : (
					<ul className="app-list">
						{items.map((item) => (
							<li key={item.id} className="app-list__row">
								{String(item.properties.title ?? item.id)}
							</li>
						))}
					</ul>
				)}
			</main>
		</div>
	);
}
`,

	"src/styles.css": `/* Structural rules only. Colours, the \`.app-header\` chrome, glass, and the
   primary button come from the shell-injected @brainstorm-os/sdk app-theme. */
:root {
	color-scheme: light dark;
}

/* Base resets EVERY app needs — do not remove. Without these a new app looks
   subtly broken vs the others: \`box-sizing: border-box\` keeps the 1px
   \`.app-header\` border INSIDE the shell's 44px height (content-box renders it
   45px); the \`body\` reset kills the browser-default 8px margin that would
   otherwise inset the whole app so the header isn't flush. The shell
   (\`app-preload.ts\`) owns the header HEIGHT + the macOS traffic-light inset
   PADDING — never re-declare \`.app-header { height / padding }\` here. */
* {
	box-sizing: border-box;
}

body {
	margin: 0;
	padding: 0;
	height: 100%;
	overflow: hidden;
}

.app {
	display: flex;
	flex-direction: column;
	height: 100vh;
	overflow: hidden;
}

.app-body {
	flex: 1;
	overflow: auto;
	padding: 16px;
}

.app-empty {
	color: var(--color-text-muted, #888);
	font-size: 14px;
}

.app-list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: 2px;
}

.app-list__row {
	padding: 8px 10px;
	border-radius: 8px;
}

.app-list__row:hover {
	background: var(--color-accent-subtle, rgba(0, 0, 0, 0.04));
}
`,
};

for (const [rel, content] of Object.entries(files)) {
	const dest = join(appDir, rel);
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, content);
}

console.log(`✓ Scaffolded apps/${id} (${displayName}) on the reactive React track.\n`);
console.log("Next steps:");
console.log("  1. Register it in packages/shell/src/main/apps/first-party.ts (FIRST_PARTY_APPS).");
console.log("  2. bun install");
console.log(`  3. bun run dev — then launch "${displayName}".`);
console.log("\nThe app already lists its entities live via useVaultEntities; build from there.");
