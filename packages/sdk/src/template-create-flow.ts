/**
 * Create-flow template selection (B11.10b) — the pure decision layer behind the
 * shared "+ New" template picker described in
 * 66-templates.md §The shared surfaces.
 *
 * When "+ New" / `Cmd+N` resolves a `targetType` (and optionally a view /
 * collection that set a `defaultTemplate`), this assembles the picker model:
 * *Blank* plus every **applicable** object template, the resolved default
 * surfaced first so it is the pre-highlighted Enter target. Block-snippet
 * templates never appear here — they are an editor-insert surface, filtered out
 * by `templateAppliesToType`.
 *
 * `hasTemplates === false` is the caller's signal to skip the picker entirely
 * and go straight to a blank draft (today's behavior, unchanged when a
 * type/collection has no applicable template — per doc 66 §The shared surfaces).
 *
 * Pure + dependency-free over `@brainstorm-os/sdk-types`: the picker chrome (the
 * shared fancy-menus runtime) and the body copy (the chosen template's `root`
 * Y.XmlText copied onto the new entity through the editor insert path) are the
 * consuming surface's job; this only decides *what is offered* and *what draft a
 * choice produces*.
 */

import type { Template } from "@brainstorm-os/sdk-types";
import {
	type DefaultTemplateLadder,
	type TemplateDraft,
	instantiateObjectTemplate,
	resolveDefaultTemplate,
	templateAppliesToType,
} from "./template-entity-codec";

/** Discriminator for a row in the create-flow picker. */
export enum CreateOptionKind {
	Blank = "blank",
	Template = "template",
}

/** One offered row: the always-present *Blank* draft, or an applicable object
 *  template (with `isDefault` marking the resolved default for pre-highlight). */
export type CreateTemplateOption =
	| { kind: CreateOptionKind.Blank }
	| { kind: CreateOptionKind.Template; template: Template; isDefault: boolean };

/** The picker model for one "+ New" invocation. */
export type CreateTemplateMenu = {
	/** Applicable templates (default first), then *Blank* last. When no template
	 *  applies this is just `[{ kind: Blank }]`. */
	options: CreateTemplateOption[];
	/** `false` → no applicable template; skip the picker, draft blank directly. */
	hasTemplates: boolean;
	/** The resolved + still-applicable default template id, or `null`. A default
	 *  resolved from a stale ladder that no longer applies to `targetType` is
	 *  dropped (never silently applied to the wrong type). */
	defaultTemplateId: string | null;
};

/**
 * Assemble the create-flow picker model for `targetType`.
 *
 * Applicable templates are object templates whose `targetType` matches
 * (`templateAppliesToType`); the default is the first non-null rung of the
 * ladder (`view → collection → type`) **only if** it is among the applicable
 * set. Ordering: default first, then the rest by display name (case-insensitive,
 * stable), then *Blank*.
 */
export function buildCreateTemplateMenu(
	templates: readonly Template[],
	targetType: string,
	ladder: Partial<DefaultTemplateLadder> = {},
): CreateTemplateMenu {
	const applicable = templates.filter((t) => templateAppliesToType(t, targetType));

	const resolvedDefault = resolveDefaultTemplate({
		viewDefault: ladder.viewDefault ?? null,
		collectionDefault: ladder.collectionDefault ?? null,
		typeDefault: ladder.typeDefault ?? null,
	});
	const defaultTemplateId = applicable.some((t) => t.id === resolvedDefault)
		? resolvedDefault
		: null;

	const ordered = [...applicable].sort((a, b) => {
		if (a.id === defaultTemplateId) return -1;
		if (b.id === defaultTemplateId) return 1;
		return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	});

	const options: CreateTemplateOption[] = ordered.map((template) => ({
		kind: CreateOptionKind.Template,
		template,
		isDefault: template.id === defaultTemplateId,
	}));
	options.push({ kind: CreateOptionKind.Blank });

	return { options, hasTemplates: applicable.length > 0, defaultTemplateId };
}

/**
 * The draft a chosen picker option produces. *Blank* hands back the base draft
 * unchanged (criteria-inherited pins only); a template runs
 * `instantiateObjectTemplate` (prototype props under the base draft, pins win).
 * The body copy is the caller's follow-up, not part of the draft shape.
 */
export function draftFromCreateOption(
	option: CreateTemplateOption,
	baseDraft: TemplateDraft,
): TemplateDraft {
	if (option.kind === CreateOptionKind.Blank) return baseDraft;
	return instantiateObjectTemplate(option.template, baseDraft);
}
