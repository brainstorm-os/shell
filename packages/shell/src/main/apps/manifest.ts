/**
 * App manifest schema + validator per §Manifest and
 * .
 *
 *   {
 *     "id": "io.example.text-editor",
 *     "name": "Text Editor",
 *     "version": "1.4.2",
 *     "sdk": "1",
 *     "description": "Rich-text editor for plain documents.",
 *     "icon": "assets/icon.png",
 *     "entry": "dist/index.html",
 *     "capabilities": ["storage.kv", "entities.read:io.example/Note/v1", ...],
 *     "registrations": {
 *       "openers": [
 *         { "mime": "text/markdown", "kind": "primary" },
 *         { "entityType": "io.example/Note/v1", "kind": "primary" }
 *       ],
 *       "blocks": [...],
 *       "entityTypes": [
 *         { "id": "io.example/Note/v1", "schemaUrl": "https://...", "schema": { ...inline } }
 *       ],
 *       "widgets": [...]
 *     },
 *     "shortcuts": [...],
 *     "menus": [...],
 *     "layouts": [...]
 *   }
 *
 * OQ-2 resolution (hybrid): entity types carry `schemaUrl` (required, canonical
 * identity) and optional `schema` (inline copy for offline install).
 *
 * Hand-written validator — no Zod runtime cost on the install hot path and no
 * runtime dep crosses into the shell main bundle.
 */

import {
	type AppLayoutManifestEntry,
	type LayoutContext,
	isHardBlockedScheme,
	validateAppLayouts,
} from "@brainstorm-os/sdk-types";
import { normalizeChord } from "../shortcuts/chord";
import { compareDottedVersions } from "../util/schema-version";
import { isBlockIdForApp, isValidBlockId } from "./block-id";

const APP_ID_PATTERN = /^[a-z][a-z0-9._-]{1,127}$/i; // reverse-DNS-like
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9._-]+)?$/;
const SDK_VERSION_PATTERN = /^\d+$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9._-]*(?::[\S]+)?$/;
const ENTITY_TYPE_URL_PATTERN = /^[A-Za-z0-9_.+~-]+\/[A-Za-z0-9_.+~-]+\/v\d+$/; // e.g. io.example/Note/v1
const MIME_PATTERN = /^[a-z0-9!#$&^_+.-]+\/[a-z0-9!#$&^_+.*-]+$/i;
// A URL scheme token (no trailing colon), per RFC 3986 scheme grammar.
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/i;
// A dot-less file extension (`csv`, `tar.gz`); no leading dot, no slash.
const EXTENSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const RELATIVE_PATH_PATTERN = /^[A-Za-z0-9_./-]+$/; // no leading slash, no ..

export const CURRENT_SDK_VERSION = "1" as const;

export type OpenerRegistration =
	| { kind: "primary" | "secondary"; entityType: string }
	| { kind: "primary" | "secondary"; mime: string }
	| { kind: "primary" | "secondary"; scheme: string }
	| { kind: "primary" | "secondary"; extension: string };

export type BlockRegistration = {
	id: string;
	name: string;
	/** Entity types this block renders, e.g. `["brainstorm/List/v1"]`. When an
	 *  entity of one of these types is embedded, the host picks THIS block id
	 *  instead of the generic shell card. Optional — a block with no types is
	 *  only reachable by an explicit `blockId`. */
	entityTypes?: string[];
};

export type EntityTypeRegistration = {
	id: string;
	schemaUrl: string;
	/** Optional inline JSON Schema per OQ-2 hybrid. */
	schema?: Record<string, unknown>;
};

export type WidgetRegistration = {
	id: string;
	name: string;
	size: "small" | "medium" | "large";
};

/**
 * Curated intent-verb namespace per.
 * Apps cannot invent new verbs at runtime; the shell ships the namespace.
 */
export const INTENT_VERBS = [
	"open",
	"insert",
	"share",
	"convert",
	"export",
	"import",
	"process",
	"compose",
	"quick-look",
	"move",
	"send",
	"reply",
	"forward",
] as const;

export type IntentVerb = (typeof INTENT_VERBS)[number];

/** Grouping buckets a contributed action may declare (doc 63 §Anti-rot). Wire
 *  values mirror the `ActionGroup` enum in `@brainstorm-os/sdk-types`; an unknown
 *  group falls back to `actions` at render time, but the manifest validator
 *  rejects a non-curated value so the catalog stays honest. */
export const ACTION_GROUPS = ["share", "convert", "actions"] as const;
const ACTION_GROUP_SET: ReadonlySet<string> = new Set(ACTION_GROUPS);

/** A shell IconName slug (doc 63 — `icon` is a shell IconName the host paints,
 *  never raw markup). Kebab/lower tokens only; the renderer falls back to a
 *  generic glyph on an unknown-but-well-formed name. */
const ICON_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export type IntentRegistration = {
	verb: IntentVerb;
	entityType?: string;
	mime?: string;
	format?: string;
	kind?: string;
	blockId?: string;
	label?: string;
	priority?: "primary" | "secondary";
	/** Action-surface presentation metadata (doc 63 §Contributor side). */
	icon?: string;
	group?: (typeof ACTION_GROUPS)[number];
};

export type ShortcutRegistration = {
	id: string;
	default: string;
	label: string;
	scope?: string;
	/** App opt-in to shadow a shell-layer binding for the same chord (per
	 *  §App opt-in shadowing). Without this flag, an install whose
	 *  manifest chord collides with a shell binding is rejected. */
	shadowsShell?: boolean;
};

export type MenuItem =
	| { id: string; label: string; shortcut?: string }
	| { type: "separator" }
	| { type: "system"; role: string };

export type MenuRegistration = {
	menu: string;
	items: MenuItem[];
};

export type LayoutRegistration = {
	type: string; // entity type URL
	context: "full" | "card" | "row" | "chip" | "preview" | "whiteboard" | "print";
	config: Record<string, unknown>; // cell tree — validated lazily by the layouts subsystem (Stage 8)
};

export type AppManifest = {
	id: string;
	name: string;
	version: string;
	sdk: string;
	description?: string;
	icon?: string;
	entry: string;
	capabilities: string[];
	registrations?: {
		openers?: OpenerRegistration[];
		blocks?: BlockRegistration[];
		entityTypes?: EntityTypeRegistration[];
		widgets?: WidgetRegistration[];
		intents?: IntentRegistration[];
	};
	shortcuts?: ShortcutRegistration[];
	menus?: MenuRegistration[];
	layouts?: LayoutRegistration[];
	/** Localization declaration (12.15 slice 15c). `source` is the language the
	 *  inline `t()` manifest is authored in (always `"en"` today); `locales` is
	 *  the full set the app ships — source plus every overlay-pack tag under
	 *  `src/i18n/<tag>.json`. The `check-app-i18n` gate verifies the declared set
	 *  matches the files on disk; the app's lazy loader walks the same set. */
	i18n?: {
		source: string;
		locales: string[];
	};
};

export type ValidationResult =
	| { ok: true; manifest: AppManifest }
	| { ok: false; reason: string; path: string };

export function validateManifest(value: unknown): ValidationResult {
	if (!value || typeof value !== "object") {
		return { ok: false, reason: "manifest must be an object", path: "$" };
	}
	const v = value as Record<string, unknown>;

	const idCheck = checkString(v.id, "id", APP_ID_PATTERN);
	if (idCheck) return idCheck;
	const nameCheck = checkNonEmptyString(v.name, "name");
	if (nameCheck) return nameCheck;
	const versionCheck = checkString(v.version, "version", SEMVER_PATTERN);
	if (versionCheck) return versionCheck;
	const sdkCheck = checkString(v.sdk, "sdk", SDK_VERSION_PATTERN);
	if (sdkCheck) return sdkCheck;
	if (compareDottedVersions(v.sdk as string, CURRENT_SDK_VERSION) > 0) {
		return {
			ok: false,
			reason: `manifest requires SDK ${v.sdk}; shell supports ${CURRENT_SDK_VERSION}`,
			path: "$.sdk",
		};
	}
	const entryCheck = checkString(v.entry, "entry", RELATIVE_PATH_PATTERN);
	if (entryCheck) return entryCheck;
	if (typeof v.entry === "string" && (v.entry.startsWith("/") || v.entry.includes(".."))) {
		return {
			ok: false,
			reason: "entry must be a relative path without `..`",
			path: "$.entry",
		};
	}

	if (v.description !== undefined && typeof v.description !== "string") {
		return { ok: false, reason: "description must be a string", path: "$.description" };
	}
	if (v.icon !== undefined) {
		const r = checkString(v.icon, "icon", RELATIVE_PATH_PATTERN);
		if (r) return r;
	}

	if (!Array.isArray(v.capabilities)) {
		return { ok: false, reason: "capabilities must be an array", path: "$.capabilities" };
	}
	for (const [i, cap] of v.capabilities.entries()) {
		if (typeof cap !== "string" || !CAPABILITY_PATTERN.test(cap)) {
			return {
				ok: false,
				reason: `invalid capability string at index ${i}: ${JSON.stringify(cap)}`,
				path: `$.capabilities[${i}]`,
			};
		}
	}

	const regs = v.registrations;
	if (regs !== undefined) {
		if (!regs || typeof regs !== "object") {
			return { ok: false, reason: "registrations must be an object", path: "$.registrations" };
		}
		const r = validateRegistrations(regs as Record<string, unknown>, v.id as string);
		if (r) return r;
	}

	if (v.shortcuts !== undefined) {
		const r = validateShortcuts(v.shortcuts);
		if (r) return r;
	}
	if (v.menus !== undefined) {
		const r = validateMenus(v.menus);
		if (r) return r;
	}
	if (v.layouts !== undefined) {
		const r = validateLayouts(v.layouts, collectOwnedEntityTypes(v));
		if (r) return r;
	}
	if (v.i18n !== undefined) {
		const r = validateI18n(v.i18n);
		if (r) return r;
	}

	return { ok: true, manifest: v as unknown as AppManifest };
}

function validateI18n(value: unknown): ValidationResult | null {
	if (!value || typeof value !== "object") {
		return { ok: false, reason: "i18n must be an object", path: "$.i18n" };
	}
	const i = value as Record<string, unknown>;
	const sourceCheck = checkNonEmptyString(i.source, "i18n.source");
	if (sourceCheck) return sourceCheck;
	if (!Array.isArray(i.locales) || i.locales.length === 0) {
		return { ok: false, reason: "i18n.locales must be a non-empty array", path: "$.i18n.locales" };
	}
	for (const [idx, tag] of i.locales.entries()) {
		if (typeof tag !== "string" || tag.trim().length === 0) {
			return {
				ok: false,
				reason: `i18n.locales[${idx}] must be a non-empty string`,
				path: `$.i18n.locales[${idx}]`,
			};
		}
	}
	if (!i.locales.includes(i.source)) {
		return {
			ok: false,
			reason: "i18n.locales must include the source language",
			path: "$.i18n.locales",
		};
	}
	return null;
}

function validateRegistrations(
	regs: Record<string, unknown>,
	appId: string,
): ValidationResult | null {
	if (regs.openers !== undefined) {
		if (!Array.isArray(regs.openers)) {
			return { ok: false, reason: "openers must be an array", path: "$.registrations.openers" };
		}
		for (const [i, op] of regs.openers.entries()) {
			const r = validateOpener(op, i);
			if (r) return r;
		}
	}
	if (regs.blocks !== undefined) {
		if (!Array.isArray(regs.blocks)) {
			return { ok: false, reason: "blocks must be an array", path: "$.registrations.blocks" };
		}
		for (const [i, b] of regs.blocks.entries()) {
			const r = validateBlock(b, appId, i);
			if (r) return r;
		}
	}
	if (regs.entityTypes !== undefined) {
		if (!Array.isArray(regs.entityTypes)) {
			return {
				ok: false,
				reason: "entityTypes must be an array",
				path: "$.registrations.entityTypes",
			};
		}
		for (const [i, et] of regs.entityTypes.entries()) {
			const r = validateEntityType(et, i);
			if (r) return r;
		}
	}
	if (regs.widgets !== undefined) {
		if (!Array.isArray(regs.widgets)) {
			return { ok: false, reason: "widgets must be an array", path: "$.registrations.widgets" };
		}
		for (const [i, w] of regs.widgets.entries()) {
			const r = validateWidget(w, i);
			if (r) return r;
		}
	}
	if (regs.intents !== undefined) {
		if (!Array.isArray(regs.intents)) {
			return { ok: false, reason: "intents must be an array", path: "$.registrations.intents" };
		}
		for (const [i, it] of regs.intents.entries()) {
			const r = validateIntent(it, i);
			if (r) return r;
		}
	}
	return null;
}

const INTENT_VERB_SET: ReadonlySet<string> = new Set(INTENT_VERBS);

function validateIntent(value: unknown, i: number): ValidationResult | null {
	if (!value || typeof value !== "object") {
		return { ok: false, reason: "intent must be an object", path: `$.registrations.intents[${i}]` };
	}
	const it = value as Record<string, unknown>;
	if (typeof it.verb !== "string" || !INTENT_VERB_SET.has(it.verb)) {
		return {
			ok: false,
			reason: `intent.verb must be one of ${INTENT_VERBS.join(", ")}`,
			path: `$.registrations.intents[${i}].verb`,
		};
	}
	if (it.entityType !== undefined) {
		if (typeof it.entityType !== "string" || !ENTITY_TYPE_URL_PATTERN.test(it.entityType)) {
			return {
				ok: false,
				reason: "intent.entityType must match <ns>/<Name>/v<n>",
				path: `$.registrations.intents[${i}].entityType`,
			};
		}
	}
	if (it.mime !== undefined) {
		if (typeof it.mime !== "string" || !MIME_PATTERN.test(it.mime)) {
			return {
				ok: false,
				reason: `intent.mime must be a valid MIME pattern: ${String(it.mime)}`,
				path: `$.registrations.intents[${i}].mime`,
			};
		}
	}
	if (it.format !== undefined) {
		if (typeof it.format !== "string" || !MIME_PATTERN.test(it.format)) {
			return {
				ok: false,
				reason: `intent.format must be a MIME-style format identifier: ${String(it.format)}`,
				path: `$.registrations.intents[${i}].format`,
			};
		}
	}
	if (it.kind !== undefined && (typeof it.kind !== "string" || it.kind.length === 0)) {
		return {
			ok: false,
			reason: "intent.kind must be a non-empty string",
			path: `$.registrations.intents[${i}].kind`,
		};
	}
	if (it.blockId !== undefined) {
		if (!isValidBlockId(it.blockId)) {
			return {
				ok: false,
				reason: "intent.blockId must be <app-id>/<block-name>",
				path: `$.registrations.intents[${i}].blockId`,
			};
		}
	}
	if (it.label !== undefined && typeof it.label !== "string") {
		return {
			ok: false,
			reason: "intent.label must be a string",
			path: `$.registrations.intents[${i}].label`,
		};
	}
	if (it.priority !== undefined && it.priority !== "primary" && it.priority !== "secondary") {
		return {
			ok: false,
			reason: "intent.priority must be 'primary' or 'secondary'",
			path: `$.registrations.intents[${i}].priority`,
		};
	}
	if (it.icon !== undefined) {
		if (typeof it.icon !== "string" || !ICON_NAME_PATTERN.test(it.icon)) {
			return {
				ok: false,
				reason: "intent.icon must be a shell IconName slug (lower-kebab)",
				path: `$.registrations.intents[${i}].icon`,
			};
		}
	}
	if (it.group !== undefined) {
		if (typeof it.group !== "string" || !ACTION_GROUP_SET.has(it.group)) {
			return {
				ok: false,
				reason: `intent.group must be one of ${ACTION_GROUPS.join(", ")}`,
				path: `$.registrations.intents[${i}].group`,
			};
		}
	}
	return null;
}

function validateOpener(value: unknown, i: number): ValidationResult | null {
	if (!value || typeof value !== "object") {
		return { ok: false, reason: "opener must be an object", path: `$.registrations.openers[${i}]` };
	}
	const op = value as Record<string, unknown>;
	if (op.kind !== "primary" && op.kind !== "secondary") {
		return {
			ok: false,
			reason: "opener.kind must be 'primary' or 'secondary'",
			path: `$.registrations.openers[${i}].kind`,
		};
	}
	// Exactly one target dimension. `scheme`/`extension` were added for the
	// open-resolution ladder (OpenRes-1a, doc 57 §Openable targets) — the
	// Web Browser registers `scheme:https`, Files an `extension` tail, etc.
	const dims = (["entityType", "mime", "scheme", "extension"] as const).filter(
		(k) => typeof op[k] === "string",
	);
	if (dims.length !== 1) {
		return {
			ok: false,
			reason: "opener must specify exactly one of entityType, mime, scheme or extension",
			path: `$.registrations.openers[${i}]`,
		};
	}
	const dim = dims[0] as "entityType" | "mime" | "scheme" | "extension";
	if (dim === "entityType" && !ENTITY_TYPE_URL_PATTERN.test(op.entityType as string)) {
		return {
			ok: false,
			reason: `opener.entityType must match <ns>/<Name>/v<n>: ${String(op.entityType)}`,
			path: `$.registrations.openers[${i}].entityType`,
		};
	}
	if (dim === "mime" && !MIME_PATTERN.test(op.mime as string)) {
		return {
			ok: false,
			reason: `opener.mime must be a valid MIME pattern: ${String(op.mime)}`,
			path: `$.registrations.openers[${i}].mime`,
		};
	}
	if (dim === "scheme") {
		const scheme = op.scheme as string;
		if (!SCHEME_PATTERN.test(scheme)) {
			return {
				ok: false,
				reason: `opener.scheme must be a bare URL scheme token: ${String(scheme)}`,
				path: `$.registrations.openers[${i}].scheme`,
			};
		}
		// Defense in depth: an app may never register for a hard-blocked
		// scheme (doc 57 §Security floor) — the resolver would refuse it
		// anyway, but rejecting at install keeps the registry honest.
		if (isHardBlockedScheme(scheme)) {
			return {
				ok: false,
				reason: `opener.scheme is on the hard-block security floor and cannot be registered: ${scheme}`,
				path: `$.registrations.openers[${i}].scheme`,
			};
		}
	}
	if (dim === "extension" && !EXTENSION_PATTERN.test(op.extension as string)) {
		return {
			ok: false,
			reason: `opener.extension must be a dot-less file extension: ${String(op.extension)}`,
			path: `$.registrations.openers[${i}].extension`,
		};
	}
	return null;
}

function validateBlock(value: unknown, appId: string, i: number): ValidationResult | null {
	if (!value || typeof value !== "object") {
		return { ok: false, reason: "block must be an object", path: `$.registrations.blocks[${i}]` };
	}
	const b = value as Record<string, unknown>;
	if (!isValidBlockId(b.id)) {
		return {
			ok: false,
			reason: "block.id must be <app-id>/<block-name>",
			path: `$.registrations.blocks[${i}].id`,
		};
	}
	if (!isBlockIdForApp(b.id, appId)) {
		return {
			ok: false,
			reason: "block.id must be namespaced under the app id",
			path: `$.registrations.blocks[${i}].id`,
		};
	}
	if (typeof b.name !== "string" || b.name.length === 0) {
		return {
			ok: false,
			reason: "block.name must be non-empty",
			path: `$.registrations.blocks[${i}].name`,
		};
	}
	if (b.entityTypes !== undefined) {
		if (!Array.isArray(b.entityTypes) || b.entityTypes.some((t) => typeof t !== "string")) {
			return {
				ok: false,
				reason: "block.entityTypes must be an array of type-id strings",
				path: `$.registrations.blocks[${i}].entityTypes`,
			};
		}
	}
	return null;
}

function validateEntityType(value: unknown, i: number): ValidationResult | null {
	if (!value || typeof value !== "object") {
		return {
			ok: false,
			reason: "entityType must be an object",
			path: `$.registrations.entityTypes[${i}]`,
		};
	}
	const et = value as Record<string, unknown>;
	if (typeof et.id !== "string" || !ENTITY_TYPE_URL_PATTERN.test(et.id)) {
		return {
			ok: false,
			reason: "entityType.id must match <ns>/<Name>/v<n>",
			path: `$.registrations.entityTypes[${i}].id`,
		};
	}
	if (typeof et.schemaUrl !== "string" || et.schemaUrl.length === 0) {
		return {
			ok: false,
			reason: "entityType.schemaUrl is required (canonical identity per OQ-2)",
			path: `$.registrations.entityTypes[${i}].schemaUrl`,
		};
	}
	try {
		new URL(et.schemaUrl);
	} catch {
		return {
			ok: false,
			reason: `entityType.schemaUrl must be a valid URL: ${String(et.schemaUrl)}`,
			path: `$.registrations.entityTypes[${i}].schemaUrl`,
		};
	}
	if (et.schema !== undefined) {
		if (!et.schema || typeof et.schema !== "object") {
			return {
				ok: false,
				reason: "entityType.schema (when present) must be a JSON object",
				path: `$.registrations.entityTypes[${i}].schema`,
			};
		}
	}
	return null;
}

function validateWidget(value: unknown, i: number): ValidationResult | null {
	if (!value || typeof value !== "object") {
		return { ok: false, reason: "widget must be an object", path: `$.registrations.widgets[${i}]` };
	}
	const w = value as Record<string, unknown>;
	if (typeof w.id !== "string" || w.id.length === 0) {
		return {
			ok: false,
			reason: "widget.id required",
			path: `$.registrations.widgets[${i}].id`,
		};
	}
	if (typeof w.name !== "string" || w.name.length === 0) {
		return {
			ok: false,
			reason: "widget.name required",
			path: `$.registrations.widgets[${i}].name`,
		};
	}
	if (w.size !== "small" && w.size !== "medium" && w.size !== "large") {
		return {
			ok: false,
			reason: "widget.size must be small | medium | large",
			path: `$.registrations.widgets[${i}].size`,
		};
	}
	return null;
}

function validateShortcuts(value: unknown): ValidationResult | null {
	if (!Array.isArray(value)) {
		return { ok: false, reason: "shortcuts must be an array", path: "$.shortcuts" };
	}
	const seenIds = new Set<string>();
	const seenChords = new Map<string, number>();
	for (const [i, s] of value.entries()) {
		if (!s || typeof s !== "object") {
			return { ok: false, reason: "shortcut must be an object", path: `$.shortcuts[${i}]` };
		}
		const sh = s as Record<string, unknown>;
		if (typeof sh.id !== "string" || sh.id.length === 0) {
			return { ok: false, reason: "shortcut.id required", path: `$.shortcuts[${i}].id` };
		}
		if (typeof sh.default !== "string" || sh.default.length === 0) {
			return { ok: false, reason: "shortcut.default required", path: `$.shortcuts[${i}].default` };
		}
		if (typeof sh.label !== "string" || sh.label.length === 0) {
			return { ok: false, reason: "shortcut.label required", path: `$.shortcuts[${i}].label` };
		}
		if (sh.scope !== undefined && typeof sh.scope !== "string") {
			return {
				ok: false,
				reason: "shortcut.scope must be a string when present",
				path: `$.shortcuts[${i}].scope`,
			};
		}
		if (sh.shadowsShell !== undefined && typeof sh.shadowsShell !== "boolean") {
			return {
				ok: false,
				reason: "shortcut.shadowsShell must be a boolean when present",
				path: `$.shortcuts[${i}].shadowsShell`,
			};
		}
		if (seenIds.has(sh.id)) {
			return {
				ok: false,
				reason: `duplicate shortcut id ${JSON.stringify(sh.id)}`,
				path: `$.shortcuts[${i}].id`,
			};
		}
		seenIds.add(sh.id);
		const normalized = normalizeChord(sh.default);
		const existing = seenChords.get(normalized);
		if (existing !== undefined) {
			return {
				ok: false,
				reason: `shortcut chord ${JSON.stringify(sh.default)} conflicts with shortcut at index ${existing}`,
				path: `$.shortcuts[${i}].default`,
			};
		}
		seenChords.set(normalized, i);
	}
	return null;
}

/**
 * Install-time check: manifest shortcuts that collide with a shell-layer
 * chord must declare `shadowsShell: true` (per §App opt-in
 * shadowing). Pure — `shellChords` is the normalized-chord snapshot taken
 * from the live `ShortcutRegistry` at install time, so a user-rebound shell
 * binding frees its original chord for apps.
 *
 * Separate from `validateManifest` because the rule is install-context-
 * dependent (the shell registry state) and not a pure-shape check.
 */
export function validateShortcutShellCollisions(
	manifest: AppManifest,
	shellChords: ReadonlySet<string>,
): { ok: false; reason: string; path: string } | null {
	const shortcuts = manifest.shortcuts ?? [];
	for (const [i, s] of shortcuts.entries()) {
		const normalized = normalizeChord(s.default);
		if (!shellChords.has(normalized)) continue;
		if (s.shadowsShell === true) continue;
		return {
			ok: false,
			reason: `shortcut chord ${JSON.stringify(s.default)} collides with a shell binding; declare shadowsShell: true to opt in`,
			path: `$.shortcuts[${i}].default`,
		};
	}
	return null;
}

function validateMenus(value: unknown): ValidationResult | null {
	if (!Array.isArray(value)) {
		return { ok: false, reason: "menus must be an array", path: "$.menus" };
	}
	for (const [i, m] of value.entries()) {
		if (!m || typeof m !== "object") {
			return { ok: false, reason: "menu must be an object", path: `$.menus[${i}]` };
		}
		const mn = m as Record<string, unknown>;
		if (typeof mn.menu !== "string" || mn.menu.length === 0) {
			return { ok: false, reason: "menu.menu required", path: `$.menus[${i}].menu` };
		}
		if (!Array.isArray(mn.items)) {
			return { ok: false, reason: "menu.items must be an array", path: `$.menus[${i}].items` };
		}
	}
	return null;
}

/** App-default entity-type URLs — the ids the app *introduces* via its
 *  entity-type registrations. An app may only ship a default layout for
 *  a type it owns (doc 27 §App-shipped defaults); cross-type layouts are
 *  user-created. */
function collectOwnedEntityTypes(v: Record<string, unknown>): string[] {
	const regs = v.registrations;
	if (!regs || typeof regs !== "object") return [];
	const ets = (regs as Record<string, unknown>).entityTypes;
	if (!Array.isArray(ets)) return [];
	return ets
		.map((et) => (et && typeof et === "object" ? (et as Record<string, unknown>).id : undefined))
		.filter((id): id is string => typeof id === "string");
}

/**
 * Install-time validation of the manifest's `layouts:` array. Delegates
 * to the frozen `@brainstorm-os/sdk-types` `validateAppLayouts` contract
 * (Stage 8.1) — the single source of truth, so install rejects the same
 * malformed app-default layouts the resolver/editor would (DRY; replaces
 * the prior ad-hoc shallow check). Enforces doc 27 §App-shipped defaults:
 * non-empty + app-owned `type`, a valid `LayoutContext`, no duplicate
 * `(type, context)`, and a well-formed `config` body.
 */
function validateLayouts(value: unknown, ownedTypes: readonly string[]): ValidationResult | null {
	if (!Array.isArray(value)) {
		return { ok: false, reason: "layouts must be an array", path: "$.layouts" };
	}
	const entries: AppLayoutManifestEntry[] = [];
	for (const [i, l] of value.entries()) {
		if (!l || typeof l !== "object") {
			return { ok: false, reason: "layout must be an object", path: `$.layouts[${i}]` };
		}
		const ly = l as Record<string, unknown>;
		entries.push({
			type: typeof ly.type === "string" ? ly.type : "",
			context: (ly.context ?? null) as LayoutContext | null,
			config: ly.config as AppLayoutManifestEntry["config"],
		});
	}
	const first = validateAppLayouts(entries, ownedTypes)[0];
	if (first) {
		return { ok: false, reason: first.message, path: `$.layouts[${first.entryIndex}]` };
	}
	return null;
}

function checkString(value: unknown, name: string, pattern: RegExp): ValidationResult | null {
	if (typeof value !== "string") {
		return { ok: false, reason: `${name} must be a string`, path: `$.${name}` };
	}
	if (!pattern.test(value)) {
		return {
			ok: false,
			reason: `${name} does not match required pattern: ${String(value)}`,
			path: `$.${name}`,
		};
	}
	return null;
}

function checkNonEmptyString(value: unknown, name: string): ValidationResult | null {
	if (typeof value !== "string" || value.length === 0) {
		return { ok: false, reason: `${name} must be a non-empty string`, path: `$.${name}` };
	}
	return null;
}

/**
 * Compare two manifests' capability sets. Used by the update flow to know
 * what's newly-requested (needs user re-consent) and what's gone (can be
 * dropped silently per §Update).
 */
export function diffCapabilities(
	previous: readonly string[],
	next: readonly string[],
): { added: string[]; removed: string[]; unchanged: string[] } {
	const prev = new Set(previous);
	const ne = new Set(next);
	return {
		added: next.filter((c) => !prev.has(c)),
		removed: previous.filter((c) => !ne.has(c)),
		unchanged: next.filter((c) => prev.has(c)),
	};
}
