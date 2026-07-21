/**
 * The Agent's capabilities context (doc 63 — the Agent context layer). Turns the
 * read-only platform catalog (`services.platform.catalog()` — installed apps,
 * the object types they produce + properties, and their action vocabulary) into
 * a compact, bounded instruction block the model reads to learn WHAT WORLD it is
 * in: this is Brainstorm, here are the apps, the objects they make, and what can
 * be done to them. The `CLAUDE.md`-analog "here is your environment" preamble.
 *
 * Pure + deterministic (no React / SDK runtime) so the bounded formatting is
 * unit-testable in isolation — mirrors `retrieval.ts` / the memory block. The
 * catalog is already sanitized + bounded at the source (the shell's
 * `buildPlatformCatalog`); this only shapes it into prose and applies a render
 * cap so a large vault can't blow up the prompt.
 */

import type { PlatformCatalog, PlatformCatalogIntent } from "@brainstorm-os/sdk-types";

/** Properties listed per object type in the prose (the catalog caps the source
 *  at 64; this keeps a single line readable). */
const MAX_PROPERTIES_RENDERED = 12;

/** Render one app's action vocabulary as `verb (kindA, kindB), verb2` — verbs
 *  deduped, their `kind`s collected. The agent reads this as "what this app can
 *  do"; the curated dispatch path (Agent-3/-5) governs what it may actually
 *  invoke. */
function renderActions(intents: readonly PlatformCatalogIntent[]): string {
	const kindsByVerb = new Map<string, Set<string>>();
	for (const intent of intents) {
		let kinds = kindsByVerb.get(intent.verb);
		if (!kinds) {
			kinds = new Set();
			kindsByVerb.set(intent.verb, kinds);
		}
		if (intent.kind) kinds.add(intent.kind);
	}
	return [...kindsByVerb.entries()]
		.map(([verb, kinds]) => (kinds.size > 0 ? `${verb} (${[...kinds].join(", ")})` : verb))
		.join(", ");
}

/** Build the workspace-context instruction block, or `""` when the catalog is
 *  empty (no apps) so the caller can chain it fail-soft. */
export function buildWorkspaceContextBlock(catalog: PlatformCatalog): string {
	if (catalog.apps.length === 0) return "";

	const typesByApp = new Map<string, PlatformCatalog["entityTypes"]>();
	for (const type of catalog.entityTypes) {
		const list = typesByApp.get(type.ownerApp) ?? [];
		list.push(type);
		typesByApp.set(type.ownerApp, list);
	}
	const intentsByApp = new Map<string, PlatformCatalogIntent[]>();
	for (const intent of catalog.intents) {
		const list = intentsByApp.get(intent.ownerApp) ?? [];
		list.push(intent);
		intentsByApp.set(intent.ownerApp, list);
	}

	const lines: string[] = [
		"## Your workspace (Brainstorm)",
		"You are an agent inside Brainstorm — a knowledge workspace where installed apps create typed objects in the user's vault. Use this map of what exists and what each app can do. Reference objects by their type id when grounding or citing.",
		"",
		"Installed apps:",
	];

	for (const app of catalog.apps) {
		const description = app.description ? ` — ${app.description}` : "";
		lines.push(`- **${app.name}** (\`${app.id}\`)${description}`);
		for (const type of typesByApp.get(app.id) ?? []) {
			const names = type.properties.slice(0, MAX_PROPERTIES_RENDERED).map((p) => p.name);
			const more = type.properties.length > MAX_PROPERTIES_RENDERED ? ", …" : "";
			const props = names.length > 0 ? ` (${names.join(", ")}${more})` : "";
			lines.push(`  - Object type \`${type.id}\`${props}`);
		}
		const actions = renderActions(intentsByApp.get(app.id) ?? []);
		if (actions) lines.push(`  - Actions: ${actions}`);
	}

	return lines.join("\n");
}

/** Join the agent's instruction-context blocks in priority order — environment
 *  preamble, vault data, retrieval grounding, memory — dropping the empty ones
 *  and separating the rest with a blank line. One joiner for every slice so the
 *  call site stays a flat, ordered list. */
export function joinContextBlocks(blocks: readonly string[]): string {
	return blocks.filter((block) => block.length > 0).join("\n\n");
}
