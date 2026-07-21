import { type Entity, IconKind, type Template, TemplateKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	TEMPLATE_ENTITY_TYPE,
	TEMPLATE_SNIPPET_KEY,
	type TemplateDraft,
	blockSnippetToTemplateProperties,
	entityToTemplate,
	instantiateObjectTemplate,
	objectToTemplateProperties,
	resolveDefaultTemplate,
	snippetFromTemplate,
	templateAppliesToType,
	templateToEntityProperties,
} from "./template-entity-codec";

const NOW = 1_700_000_000_000;

function sampleTemplate(overrides: Partial<Template> = {}): Template {
	return {
		id: "tpl-bug",
		templateKind: TemplateKind.Object,
		targetType: "brainstorm/Task/v1",
		name: "Bug report",
		icon: { kind: IconKind.Emoji, value: "🐞" },
		cover: null,
		prototype: {
			status: "todo",
			priority: "high",
			tags: ["bug", "triage"],
			checklist: { items: ["Repro", "Fix"] },
		},
		createdAt: NOW,
		updatedAt: NOW + 5,
		...overrides,
	};
}

function asEntity(template: Template): Entity {
	return {
		id: template.id,
		type: TEMPLATE_ENTITY_TYPE,
		properties: templateToEntityProperties(template),
		createdBy: "io.brainstorm.database",
		createdAt: template.createdAt,
		updatedAt: template.updatedAt,
	};
}

describe("template-entity-codec", () => {
	it("TEMPLATE_ENTITY_TYPE is the canonical type url", () => {
		expect(TEMPLATE_ENTITY_TYPE).toBe("brainstorm/Template/v1");
	});

	it("properties omit the Entity-owned fields (id, timestamps)", () => {
		const props = templateToEntityProperties(sampleTemplate());
		expect(props).not.toHaveProperty("id");
		expect(props).not.toHaveProperty("createdAt");
		expect(props).not.toHaveProperty("updatedAt");
		expect(Object.keys(props).sort()).toEqual(
			["cover", "icon", "name", "prototype", "targetType", "templateKind"].sort(),
		);
	});

	it("round-trips a well-formed object template", () => {
		const t = sampleTemplate();
		expect(entityToTemplate(asEntity(t))).toEqual(t);
	});

	it("round-trips a block-snippet template (no targetType)", () => {
		const t = sampleTemplate({
			templateKind: TemplateKind.BlockSnippet,
			targetType: null,
			prototype: {},
		});
		expect(entityToTemplate(asEntity(t))).toEqual(t);
	});

	it("returns null for a non-template entity", () => {
		const t = sampleTemplate();
		const wrong: Entity = { ...asEntity(t), type: "brainstorm/Task/v1" };
		expect(entityToTemplate(wrong)).toBeNull();
	});

	it("coerces a partial / malformed row to safe defaults", () => {
		const wrong: Entity = {
			id: "tpl-x",
			type: TEMPLATE_ENTITY_TYPE,
			properties: { templateKind: 42, targetType: 7, name: null, prototype: "nope" },
			createdBy: "x",
			createdAt: NOW,
			updatedAt: NOW,
		};
		expect(entityToTemplate(wrong)).toEqual({
			id: "tpl-x",
			templateKind: TemplateKind.BlockSnippet,
			targetType: null,
			name: "",
			icon: null,
			cover: null,
			prototype: {},
			createdAt: NOW,
			updatedAt: NOW,
		});
	});

	describe("instantiateObjectTemplate", () => {
		it("copies prototype properties onto an empty draft and resolves the type", () => {
			const draft: TemplateDraft = { properties: {} };
			const out = instantiateObjectTemplate(sampleTemplate(), draft);
			expect(out.type).toBe("brainstorm/Task/v1");
			expect(out.properties).toEqual({
				status: "todo",
				priority: "high",
				tags: ["bug", "triage"],
				checklist: { items: ["Repro", "Fix"] },
			});
		});

		it("criteria-inherited pins WIN over template values", () => {
			const draft: TemplateDraft = { properties: { status: "in-progress", assignee: "me" } };
			const out = instantiateObjectTemplate(sampleTemplate(), draft);
			// pin overrides the template's status; template fills the rest
			expect(out.properties.status).toBe("in-progress");
			expect(out.properties.assignee).toBe("me");
			expect(out.properties.priority).toBe("high");
		});

		it("draft.type wins over the template targetType when set", () => {
			const draft: TemplateDraft = { type: "brainstorm/Note/v1", properties: {} };
			const out = instantiateObjectTemplate(sampleTemplate(), draft);
			expect(out.type).toBe("brainstorm/Note/v1");
		});

		it("deep-clones nested prototype values (no shared references)", () => {
			const template = sampleTemplate();
			const out = instantiateObjectTemplate(template, { properties: {} });
			(out.properties.tags as string[]).push("mutated");
			(out.properties.checklist as { items: string[] }).items.push("mutated");
			// the template's prototype is untouched
			expect(template.prototype.tags).toEqual(["bug", "triage"]);
			expect((template.prototype.checklist as { items: string[] }).items).toEqual(["Repro", "Fix"]);
		});

		it("omits type for a snippet template with no targetType", () => {
			const snippet = sampleTemplate({ targetType: null });
			const out = instantiateObjectTemplate(snippet, { properties: {} });
			expect(out.type).toBeUndefined();
		});
	});

	describe("resolveDefaultTemplate", () => {
		it("view default wins (most specific)", () => {
			expect(
				resolveDefaultTemplate({
					viewDefault: "tpl-view",
					collectionDefault: "tpl-coll",
					typeDefault: "tpl-type",
				}),
			).toBe("tpl-view");
		});

		it("falls through to collection, then type, then null", () => {
			expect(
				resolveDefaultTemplate({
					viewDefault: null,
					collectionDefault: "tpl-coll",
					typeDefault: "tpl-type",
				}),
			).toBe("tpl-coll");
			expect(
				resolveDefaultTemplate({ viewDefault: null, collectionDefault: null, typeDefault: "tpl-type" }),
			).toBe("tpl-type");
			expect(
				resolveDefaultTemplate({ viewDefault: null, collectionDefault: null, typeDefault: null }),
			).toBeNull();
		});
	});

	describe("templateAppliesToType", () => {
		it("an object template matches its targetType", () => {
			expect(templateAppliesToType(sampleTemplate(), "brainstorm/Task/v1")).toBe(true);
			expect(templateAppliesToType(sampleTemplate(), "brainstorm/Note/v1")).toBe(false);
		});

		it("a block-snippet never matches the create-flow", () => {
			const snippet = sampleTemplate({
				templateKind: TemplateKind.BlockSnippet,
				targetType: "brainstorm/Task/v1",
			});
			expect(templateAppliesToType(snippet, "brainstorm/Task/v1")).toBe(false);
		});
	});

	describe("objectToTemplateProperties", () => {
		const object: Entity = {
			id: "ent-1",
			type: "brainstorm/Task/v1",
			properties: {
				name: "Ship the thing",
				icon: { kind: IconKind.Emoji, value: "🚀" },
				cover: { kind: "color", value: "#abc" },
				status: "todo",
				priority: "high",
				tags: ["release"],
			},
			createdBy: "io.brainstorm.tasks",
			createdAt: NOW,
			updatedAt: NOW,
		};

		it("targets the object's own type as an object template", () => {
			const props = objectToTemplateProperties(object);
			expect(props.templateKind).toBe(TemplateKind.Object);
			expect(props.targetType).toBe("brainstorm/Task/v1");
		});

		it("lifts name/icon/cover into the template presentation (not the prototype)", () => {
			const props = objectToTemplateProperties(object);
			expect(props.name).toBe("Ship the thing");
			expect(props.icon).toEqual({ kind: IconKind.Emoji, value: "🚀" });
			expect(props.cover).toEqual({ kind: "color", value: "#abc" });
			expect(props.prototype).not.toHaveProperty("name");
			expect(props.prototype).not.toHaveProperty("icon");
			expect(props.prototype).not.toHaveProperty("cover");
		});

		it("captures the remaining properties as the seeded prototype", () => {
			const props = objectToTemplateProperties(object);
			expect(props.prototype).toEqual({ status: "todo", priority: "high", tags: ["release"] });
		});

		it("lets an explicit name override the object's name", () => {
			expect(objectToTemplateProperties(object, { name: "Release checklist" }).name).toBe(
				"Release checklist",
			);
		});

		it("strips template-machinery keys from the prototype (re-saving a template)", () => {
			const templateEntity = asEntity(sampleTemplate());
			const props = objectToTemplateProperties(templateEntity);
			expect(props.prototype).not.toHaveProperty("templateKind");
			expect(props.prototype).not.toHaveProperty("targetType");
			expect(props.prototype).not.toHaveProperty("prototype");
		});

		it("deep-clones prototype values (no shared reference into the object)", () => {
			const props = objectToTemplateProperties(object);
			(props.prototype.tags as string[]).push("mutated");
			expect(object.properties.tags).toEqual(["release"]);
		});

		it("round-trips: saved object → template → instance seeds the prototype", () => {
			const props = objectToTemplateProperties(object);
			const template = entityToTemplate({
				id: "tpl-x",
				type: TEMPLATE_ENTITY_TYPE,
				properties: props,
				createdBy: "io.brainstorm.tasks",
				createdAt: NOW,
				updatedAt: NOW,
			});
			expect(template).not.toBeNull();
			const draft = instantiateObjectTemplate(template as Template, { properties: {} });
			expect(draft.type).toBe("brainstorm/Task/v1");
			expect(draft.properties.status).toBe("todo");
			expect(draft.properties).not.toHaveProperty("name");
		});
	});

	describe("prototype-key hygiene (defense-in-depth)", () => {
		// JSON.parse produces genuine own `__proto__`/`constructor`/`prototype`
		// keys (an object literal would set the prototype instead) — the shape a
		// crafted / hand-edited property bag could carry.
		it("drops dangerous keys from objectToTemplateProperties' prototype", () => {
			const properties = JSON.parse(
				'{"status":"todo","__proto__":{"polluted":1},"constructor":"x","prototype":"y"}',
			);
			const result = objectToTemplateProperties({ type: "brainstorm/Task/v1", properties });
			expect(result.prototype.status).toBe("todo");
			for (const key of ["__proto__", "constructor", "prototype"]) {
				expect(Object.prototype.hasOwnProperty.call(result.prototype, key)).toBe(false);
			}
		});

		it("does not carry dangerous keys or pollute Object.prototype on instantiate", () => {
			const prototype = JSON.parse('{"__proto__":{"polluted":1},"ok":1}');
			const draft = instantiateObjectTemplate(sampleTemplate({ prototype }), { properties: {} });
			expect(draft.properties.ok).toBe(1);
			expect(Object.prototype.hasOwnProperty.call(draft.properties, "__proto__")).toBe(false);
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		});
	});
});

describe("block-snippet templates (B11.10 surface #2)", () => {
	const SNIPPET = JSON.stringify({ version: 1, blocks: [{ type: "paragraph" }] });

	it("blockSnippetToTemplateProperties builds a block-snippet with the fragment in prototype", () => {
		const props = blockSnippetToTemplateProperties("Meeting notes", SNIPPET);
		expect(props.templateKind).toBe(TemplateKind.BlockSnippet);
		expect(props.targetType).toBeNull();
		expect(props.name).toBe("Meeting notes");
		expect(props.prototype[TEMPLATE_SNIPPET_KEY]).toBe(SNIPPET);
	});

	it("snippetFromTemplate reads the fragment back", () => {
		const template: Template = {
			id: "t1",
			createdAt: NOW,
			updatedAt: NOW,
			...blockSnippetToTemplateProperties("X", SNIPPET),
		};
		expect(snippetFromTemplate(template)).toBe(SNIPPET);
	});

	it("snippetFromTemplate returns null for an object template or a missing fragment", () => {
		const object: Template = {
			id: "o1",
			templateKind: TemplateKind.Object,
			targetType: "brainstorm/Note/v1",
			name: "Obj",
			icon: null,
			cover: null,
			prototype: { [TEMPLATE_SNIPPET_KEY]: SNIPPET },
			createdAt: NOW,
			updatedAt: NOW,
		};
		expect(snippetFromTemplate(object)).toBeNull();
		const empty: Template = { ...object, templateKind: TemplateKind.BlockSnippet, prototype: {} };
		expect(snippetFromTemplate(empty)).toBeNull();
	});

	it("round-trips through the entity codec", () => {
		const template: Template = {
			id: "t2",
			createdAt: NOW,
			updatedAt: NOW,
			...blockSnippetToTemplateProperties("RT", SNIPPET),
		};
		const back = entityToTemplate(asEntity(template));
		expect(back).not.toBeNull();
		expect(snippetFromTemplate(back as Template)).toBe(SNIPPET);
	});
});
