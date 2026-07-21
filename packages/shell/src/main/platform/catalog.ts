/**
 * The platform-catalog assembler (doc 63 — the Agent context layer).
 *
 * A pure transform from the registry's raw records (active apps + their manifest
 * display meta, registered entity types + their inline JSON-Schema, and every
 * registered intent) into the sanitized {@link PlatformCatalog} the Agent reads
 * to learn what world it is in. Kept pure + structurally-typed so it unit-tests
 * against plain fixtures and the broker service feeds it live repo records.
 *
 * SECURITY (doc 63 §Security): every app/contributor-declared string is bounded
 * + control-stripped via {@link sanitizeBoundedText} (a declaration can't blow
 * out or smuggle markup into the agent's context window), the per-type property
 * and enum lists are capped, and NO vault content appears — only metadata. Vault
 * data stays behind `entities` / `search`.
 */

import type {
	PlatformCatalog,
	PlatformCatalogApp,
	PlatformCatalogEntityType,
	PlatformCatalogIntent,
	PlatformCatalogProperty,
} from "@brainstorm-os/sdk-types";
import { sanitizeBoundedText } from "../intents/sanitize-label";

const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 280;
const MAX_LABEL_LENGTH = 64;
const MAX_PROPERTIES_PER_TYPE = 64;
const MAX_ENUM_VALUES = 32;

/** App display metadata read from a manifest (name/description/icon presence). */
export type AppManifestMeta = {
	name?: string | undefined;
	description?: string | undefined;
	hasIcon: boolean;
};

/** The registry slices the assembler consumes. Structural so the repo records
 *  (which carry extra columns) satisfy it directly. */
export type PlatformCatalogInput = {
	/** Active installed apps. */
	readonly apps: ReadonlyArray<{ readonly id: string }>;
	/** Resolve an app's display meta from its manifest. `null` when unreadable
	 *  (the app still appears, named by its id). */
	readonly readManifestMeta: (appId: string) => AppManifestMeta | null;
	/** Registered, non-orphaned entity types. */
	readonly entityTypes: ReadonlyArray<{
		readonly id: string;
		readonly introducedBy: string;
		readonly schemaInline: Record<string, unknown> | null;
	}>;
	/** Every registered intent across all installed apps. */
	readonly intents: ReadonlyArray<{
		readonly appId: string;
		readonly verb: string;
		readonly kind: string | null;
		readonly entityType: string | null;
		readonly label: string | null;
		readonly actionGroup?: string | null;
	}>;
};

/** Distil a type's inline JSON-Schema into a bounded property list. Reads the
 *  standard `{ properties: {...}, required: [...] }` shape; unknown shapes yield
 *  an empty list (the type still appears, sans properties). */
function propertiesFromSchema(schema: Record<string, unknown> | null): PlatformCatalogProperty[] {
	if (!schema || typeof schema !== "object") return [];
	const props = schema.properties;
	if (!props || typeof props !== "object") return [];
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : [],
	);
	const out: PlatformCatalogProperty[] = [];
	for (const [rawName, rawDef] of Object.entries(props as Record<string, unknown>)) {
		if (out.length >= MAX_PROPERTIES_PER_TYPE) break;
		const name = sanitizeBoundedText(rawName, MAX_LABEL_LENGTH);
		if (!name) continue;
		const def = (rawDef && typeof rawDef === "object" ? rawDef : {}) as Record<string, unknown>;
		const property: PlatformCatalogProperty = { name, required: required.has(rawName) };
		if (typeof def.type === "string") property.valueType = def.type;
		if (Array.isArray(def.enum)) {
			const enumValues = def.enum
				.filter((v): v is string => typeof v === "string")
				.slice(0, MAX_ENUM_VALUES);
			if (enumValues.length > 0) property.enumValues = enumValues;
		}
		out.push(property);
	}
	return out;
}

/** Assemble the sanitized platform catalog from registry records. */
export function buildPlatformCatalog(input: PlatformCatalogInput): PlatformCatalog {
	const apps: PlatformCatalogApp[] = input.apps.map((app) => {
		const meta = input.readManifestMeta(app.id);
		const name = sanitizeBoundedText(meta?.name, MAX_NAME_LENGTH) ?? app.id;
		const description = sanitizeBoundedText(meta?.description, MAX_DESCRIPTION_LENGTH);
		const entry: PlatformCatalogApp = { id: app.id, name, hasIcon: meta?.hasIcon ?? false };
		if (description) entry.description = description;
		return entry;
	});

	const entityTypes: PlatformCatalogEntityType[] = input.entityTypes.map((type) => ({
		id: type.id,
		ownerApp: type.introducedBy,
		properties: propertiesFromSchema(type.schemaInline),
	}));

	const intents: PlatformCatalogIntent[] = input.intents.map((intent) => {
		const entry: PlatformCatalogIntent = { ownerApp: intent.appId, verb: intent.verb };
		if (intent.kind) entry.kind = intent.kind;
		if (intent.entityType) entry.entityType = intent.entityType;
		const label = sanitizeBoundedText(intent.label, MAX_LABEL_LENGTH);
		if (label) entry.label = label;
		if (intent.actionGroup) entry.group = intent.actionGroup;
		return entry;
	});

	return { apps, entityTypes, intents };
}
