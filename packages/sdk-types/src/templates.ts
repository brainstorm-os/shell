/**
 * Templates contract (B11.10) — the cross-app, dependency-free core of the
 * platform templating foundation
 * (66-templates.md).
 *
 * A **template** is its own Block-Protocol entity type,
 * `brainstorm/Template/v1` — *not* a regular entity tagged `isTemplate`
 * (resolves OQ-LD-10 → option (a)). Keeping templates in their own type keeps
 * them out of normal `byType` queries by construction (no query pollution) and
 * makes "templates for type T" a lookup, not a full-scan-plus-filter.
 *
 * One template type covers the two *applied* concepts that share a data shape:
 *  - **object** — a prototype entity of some `targetType`; applied by the
 *    create-flow ("new X from template Y" clones body + prototype properties).
 *  - **block-snippet** — a reusable rich-text fragment; applied by the editor
 *    slash-menu (insert the fragment at the cursor; no entity is created).
 *
 * This module owns only the shared, app-dep-free pieces: the type id, the
 * `templateKind` enum, the `Template` app-facing shape, and the property-bag
 * partition (which keys are template control/presentation vs the prototype
 * to copy). The codec + instantiation live in `@brainstorm-os/sdk`
 * (`template-entity-codec`), and the picker / slash-menu surfaces live in the
 * apps that already host a create-flow / `@brainstorm-os/editor`.
 */

import type { Cover } from "./cover";
import type { Icon } from "./icon";

/** Stable Block-Protocol type id for a template. Part of the on-disk
 *  protocol; unchanged across versions until a v2 bump. */
export const TEMPLATE_TYPE_URL = "brainstorm/Template/v1" as const;

/** How a template is *applied*. The enum values are the wire form persisted in
 *  the template entity's `templateKind` property (per the no-bare-literal
 *  convention — never `"object"` inline). */
export enum TemplateKind {
	/** Prototype entity stamped out by the create-flow into a `targetType`. */
	Object = "object",
	/** Rich-text fragment inserted at the editor cursor. */
	BlockSnippet = "block-snippet",
}

/** The app-facing template shape. `id` / `createdAt` / `updatedAt` are carried
 *  by the backing `Entity`, never duplicated into its property bag. The
 *  prototype body (the rich text copied into instances) lives in the entity's
 *  universal `"root"` Y.XmlText, *not* in this shape — body copy is a Y.Doc
 *  operation handled by the instantiation surface, not the pure codec. */
export type Template = {
	id: string;
	templateKind: TemplateKind;
	/** The BP entity-type URL an `object` template instantiates (e.g.
	 *  `brainstorm/Task/v1`). `null` for `block-snippet`. */
	targetType: string | null;
	/** How the template presents *in the picker* — its own name, not the
	 *  instance's (the instance gets a default name in v1; see OQ-TPL-1). */
	name: string;
	icon: Icon | null;
	cover: Cover | null;
	/** The prototype property values copied onto a new instance (object
	 *  templates only). Stored nested under one reserved key so a prototype
	 *  property can never collide with a template control/presentation field. */
	prototype: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
};

/** Reserved property keys on a `Template/v1` entity's bag that are template
 *  *machinery* — never copied onto an instance. */
export const TEMPLATE_CONTROL_KEYS = ["templateKind", "targetType", "prototype"] as const;

/** Property keys that describe the template *in the picker* and are not seeded
 *  onto an instance in v1 (OQ-TPL-1: copy body + prototype properties only;
 *  `icon`/`cover` describe the template, not the instance). */
export const TEMPLATE_PRESENTATION_KEYS = ["name", "icon", "cover"] as const;
