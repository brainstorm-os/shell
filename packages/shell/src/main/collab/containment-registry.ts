/**
 * Containment registry (Collab-C5 — collection sharing; design
 * [`docs/data/71-collection-sharing.md`]).
 *
 * The ONE declarative coupling between the app-agnostic sharing core and the
 * app-specific shape of a "collection" — a container entity whose child
 * entities reference it by a property. One rule per collection kind. From a
 * rule the sharing engine derives BOTH directions it needs:
 *
 *   - container → children: a `byFilter` {@link ListSource} the built
 *     `queryListSource` resolves server-side, used to cascade an initial share
 *     onto a container's existing children. Reuses the membership engine, so no
 *     app must migrate onto `List/v1` for cascade-sharing to enumerate children.
 *   - child → container: the property key on a freshly-created child that holds
 *     its container's id, read at the `entities.create` chokepoint to auto-share
 *     a new child into an already-shared collection.
 *
 * Single-entity collections (Note, Whiteboard — their content lives inside the
 * one Y.Doc) have NO rule: they share as a whole entity, the per-entity path.
 * Calendar has no rule yet (its events are source-keyed with no container
 * entity — design 71 §Calendar, deferred to M3).
 *
 * The type URLs + property keys below MIRROR the app-side wire contracts
 * (`apps/chat` `CHANNEL_TYPE` / `conversation`; `apps/tasks` `PROJECT_ENTITY_TYPE`
 * / `TASK_TYPE` / its `project` ref key). They are frozen reverse-DNS wire
 * identifiers; the main process cannot import a sandboxed app, so this is their
 * main-process mirror. `MESSAGE_TYPE_URL` already lives canonically in
 * `@brainstorm/sdk-types`, so it is imported rather than re-declared.
 */

import {
	CompositeOp,
	type ListSource,
	ListSourceKind,
	MESSAGE_TYPE_URL,
} from "@brainstorm/sdk-types";

/** One collection kind: a `parentType` container whose `childType` children
 *  each carry the container's entity id under `childParentProp`. */
export type ContainmentRule = {
	readonly parentType: string;
	readonly childType: string;
	readonly childParentProp: string;
};

/** Chat: a Channel contains its Messages, linked by the message's
 *  `conversation` property (`apps/chat/src/logic/chat.ts` `CHANNEL_TYPE` +
 *  `buildMessageProperties`). */
const CHAT_CHANNEL_TYPE = "io.brainstorm.chat/Channel/v1";
const CHAT_MESSAGE_PARENT_PROP = "conversation";

/** Tasks: a Project contains its Tasks, linked by the task's project ref
 *  (`apps/tasks` `PROJECT_ENTITY_TYPE` / `TASK_TYPE` / the `project` PropertyDef
 *  key). NB the key contains dots — see the M2 note on `childrenSourceFor`. */
const TASKS_PROJECT_TYPE = "brainstorm/Project/v1";
const TASKS_TASK_TYPE = "brainstorm/Task/v1";
const TASKS_PROJECT_PARENT_PROP = "io.brainstorm.tasks/project";

/** Whiteboard: a board contains its edge entities, linked by `whiteboardId`
 *  (`apps/whiteboard/src/types/edge.ts` — nodes are inlined in the board doc,
 *  edges are separate entities, OQ-WB-1). The FK has no dots, so the byFilter
 *  cascade enumerates cleanly (like chat's `conversation`). */
const WHITEBOARD_TYPE = "brainstorm/Whiteboard/v1";
const WHITEBOARD_EDGE_TYPE = "brainstorm/WhiteboardEdge/v1";
const WHITEBOARD_EDGE_PARENT_PROP = "whiteboardId";

const RULES: readonly ContainmentRule[] = Object.freeze([
	Object.freeze({
		parentType: CHAT_CHANNEL_TYPE,
		childType: MESSAGE_TYPE_URL,
		childParentProp: CHAT_MESSAGE_PARENT_PROP,
	}),
	Object.freeze({
		parentType: TASKS_PROJECT_TYPE,
		childType: TASKS_TASK_TYPE,
		childParentProp: TASKS_PROJECT_PARENT_PROP,
	}),
	Object.freeze({
		parentType: WHITEBOARD_TYPE,
		childType: WHITEBOARD_EDGE_TYPE,
		childParentProp: WHITEBOARD_EDGE_PARENT_PROP,
	}),
]);

/** The rule whose container is `parentType`, or `null` when the type is not a
 *  shareable collection (single-entity types and everything unknown). */
export function containmentRuleForParent(parentType: string): ContainmentRule | null {
	return RULES.find((r) => r.parentType === parentType) ?? null;
}

/** The rule whose child is `childType`, or `null` when the type is not a
 *  collection child (the overwhelming-majority path on the create hook). */
export function containmentRuleForChild(childType: string): ContainmentRule | null {
	return RULES.find((r) => r.childType === childType) ?? null;
}

/**
 * The {@link ListSource} enumerating the children of `containerId` under `rule`:
 * `type == childType AND properties[childParentProp] == containerId`. Resolved
 * server-side by `queryListSource` (the `byType` half takes the SQL fast path;
 * the `byFilter` half runs the shared predicate evaluator; the `And` composite
 * intersects). Reusing the built engine is why no app needs migrating onto
 * `List/v1` for the cascade to see a collection's children.
 */
export function childrenSourceFor(rule: ContainmentRule, containerId: string): ListSource {
	return {
		kind: ListSourceKind.Composite,
		op: CompositeOp.And,
		sources: [
			{ kind: ListSourceKind.ByType, types: [rule.childType] },
			{ kind: ListSourceKind.ByFilter, where: { $eq: { [rule.childParentProp]: containerId } } },
		],
	};
}
