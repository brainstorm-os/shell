/**
 * Template ⇄ `brainstorm/Template/v1` entity codec + instantiation (B11.10).
 *
 * The pure, dependency-free keystone the templating foundation
 * (66-templates.md) goes through:
 *  - `templateToEntityProperties` / `entityToTemplate` — serialize a `Template`
 *    to/from the property bag on a `brainstorm/Template/v1` `Entity`. `id` and
 *    timestamps are carried by the `Entity`, never duplicated into properties.
 *  - `instantiateObjectTemplate` — compute the create-flow draft for "new X
 *    from template Y": deep-copy the prototype property values onto the draft,
 *    with **criteria-inherited pins winning** over the template (the pins are
 *    what make the new entity match the list it is being created in — a
 *    template must not knock the entity out of its own view).
 *  - `resolveDefaultTemplate` — the default-template ladder
 *    (`view.defaultTemplate → collection.defaultTemplate → type-default →
 *    blank`).
 *
 * The prototype **body** (the rich text copied into instances) lives in the
 * template entity's universal `"root"` Y.XmlText, not in the property bag — so
 * the body copy is a Y.Doc operation owned by the instantiation surface (it
 * copies `template.root` onto the new entity's `root` through the editor's
 * insert path), not by this pure codec.
 *
 * `entityToTemplate` is defensive — a partial / foreign / hand-edited row
 * coerces to safe defaults rather than throwing, and a wrong-type entity
 * returns `null` so a mixed query can `.map(entityToTemplate).filter(Boolean)`.
 */

import {
	type Cover,
	type Entity,
	type Icon,
	TEMPLATE_CONTROL_KEYS,
	TEMPLATE_PRESENTATION_KEYS,
	TEMPLATE_TYPE_URL,
	type Template,
	TemplateKind,
} from "@brainstorm/sdk-types";

/** Re-exported for call sites that create/query the entity by type. */
export const TEMPLATE_ENTITY_TYPE = TEMPLATE_TYPE_URL;

/** The `properties` bag persisted on a `brainstorm/Template/v1` entity — the
 *  `Template` minus the fields the `Entity` itself owns (`id`, `createdAt`,
 *  `updatedAt`). */
export type TemplateEntityProperties = {
	templateKind: TemplateKind;
	targetType: string | null;
	name: string;
	icon: Icon | null;
	cover: Cover | null;
	prototype: Record<string, unknown>;
};

/** Serialize a `Template` into the entity `properties` bag for
 *  `entities.create(TEMPLATE_ENTITY_TYPE, props, template.id)` / `update`. */
export function templateToEntityProperties(template: Template): TemplateEntityProperties {
	return {
		templateKind: template.templateKind,
		targetType: template.targetType,
		name: template.name,
		icon: template.icon,
		cover: template.cover,
		prototype: template.prototype,
	};
}

/** Options a "Save as template" affordance threads in. */
export type SaveObjectAsTemplateOptions = {
	/** The template's display name in the picker. Defaults to the object's own
	 *  `name` property. Presentation only — never seeded onto instances. */
	name?: string;
};

/**
 * Build the `Template/v1` property bag for "Save as template" — clone an
 * existing object `entity` into an object template (the object-⋯ affordance in
 * 66-templates.md §The shared surfaces).
 *
 * The object's `name`/`icon`/`cover` become the **template's** picker
 * presentation (not seeded onto instances per OQ-TPL-1); every other property
 * becomes the `prototype` that instances inherit. Template-machinery keys
 * (`templateKind`/`targetType`/`prototype`) are stripped from the prototype
 * defensively, so re-saving a template never nests its own machinery. The body
 * copy (the object's `root` Y.XmlText → the template's `root`) is the caller's
 * follow-up through the editor insert path, mirroring `instantiateObjectTemplate`.
 */
export function objectToTemplateProperties(
	entity: Pick<Entity, "type" | "properties">,
	options: SaveObjectAsTemplateOptions = {},
): TemplateEntityProperties {
	const props = entity.properties as Record<string, unknown>;
	const excluded = new Set<string>([...TEMPLATE_PRESENTATION_KEYS, ...TEMPLATE_CONTROL_KEYS]);
	const prototype: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(props)) {
		if (!excluded.has(k)) prototype[k] = deepCloneValue(v);
	}
	return {
		templateKind: TemplateKind.Object,
		targetType: entity.type,
		name: options.name ?? asString(props.name, ""),
		icon: asObjectOrNull<Icon>(props.icon),
		cover: asObjectOrNull<Cover>(props.cover),
		prototype,
	};
}

/** Reconstruct a `Template` from a `brainstorm/Template/v1` entity. Returns
 *  `null` for a non-template entity. Every field coerces to a safe default when
 *  missing / malformed so one bad row never takes down a picker. */
export function entityToTemplate(entity: Entity): Template | null {
	if (entity.type !== TEMPLATE_ENTITY_TYPE) return null;
	const p = entity.properties as Record<string, unknown>;
	return {
		id: entity.id,
		templateKind: asTemplateKind(p.templateKind),
		targetType: asStringOrNull(p.targetType),
		name: asString(p.name, ""),
		icon: asObjectOrNull<Icon>(p.icon),
		cover: asObjectOrNull<Cover>(p.cover),
		prototype: asRecord(p.prototype),
		createdAt: entity.createdAt,
		updatedAt: entity.updatedAt,
	};
}

/** The shape the create-flow hands to `entities.create` — a type plus the
 *  property values to seed. Mirrors the Database app's `EntityDraft` minus its
 *  app-local scalar typing, so this stays dependency-free. */
export type TemplateDraft = {
	type?: string;
	properties: Record<string, unknown>;
};

/**
 * Compute the create-flow draft for "new X from template Y".
 *
 * Deep-copies the template's prototype property values onto `draft`, then
 * re-layers `draft.properties` on top so **criteria-inherited pins win** over
 * template values for any key they both set (per 66-templates.md §Instantiation
 * — pin precedence). The resulting `type` is the draft's resolved type if any,
 * else the template's `targetType`.
 *
 * Body copy is *not* done here — the caller copies the template entity's `root`
 * Y.XmlText onto the new entity through the editor insert path after the entity
 * is created. A `block-snippet` template has no `targetType`; passing one here
 * is a caller error (it returns a draft with no type, which `entities.create`
 * will reject) — snippets go through the editor insert path, not this function.
 */
export function instantiateObjectTemplate(template: Template, draft: TemplateDraft): TemplateDraft {
	const properties: Record<string, unknown> = {
		...deepCloneRecord(template.prototype),
		...draft.properties,
	};
	const result: TemplateDraft = { properties };
	const type = draft.type ?? template.targetType ?? undefined;
	if (type !== undefined && type !== null) result.type = type;
	return result;
}

/** The default-template ladder rungs, most-specific first. Each is an entity
 *  id of a `Template/v1`, or `null` when that scope sets no default. */
export type DefaultTemplateLadder = {
	viewDefault: string | null;
	collectionDefault: string | null;
	typeDefault: string | null;
};

/** Resolve the default template for "+ New" — first non-null rung of
 *  `view.defaultTemplate → collection.defaultTemplate → type-default`, else
 *  `null` (blank draft). More-specific-wins per the layered precedence in
 * . */
export function resolveDefaultTemplate(ladder: DefaultTemplateLadder): string | null {
	return ladder.viewDefault ?? ladder.collectionDefault ?? ladder.typeDefault ?? null;
}

/** True when a template applies to objects being created of `targetType`. An
 *  `object` template matches its own `targetType`; a `block-snippet` never
 *  matches the create-flow (it is an editor-insert surface). */
export function templateAppliesToType(template: Template, targetType: string): boolean {
	return template.templateKind === TemplateKind.Object && template.targetType === targetType;
}

function deepCloneRecord(value: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = deepCloneValue(v);
	return out;
}

/** Structural deep copy of a JSON-shaped property value (scalars, arrays, plain
 *  objects). Prototype values are JSON by construction (they came from an
 *  entity property bag), so this never sees functions / class instances. */
function deepCloneValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(deepCloneValue);
	if (value && typeof value === "object") return deepCloneRecord(value as Record<string, unknown>);
	return value;
}

function asTemplateKind(value: unknown): TemplateKind {
	return value === TemplateKind.Object ? TemplateKind.Object : TemplateKind.BlockSnippet;
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function asStringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asObjectOrNull<T>(value: unknown): T | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
