/**
 * B5.10(a) keystone — the property-block clipboard wire format + the
 * paste-rebind decision tree.
 *
 * Copying a Notes `PropertyBlockNode` (or a Database cell, later) puts a
 * `application/x-brainstorm-property-block` flavour on the clipboard
 * carrying `{ propertyKey, view, value? }`. Pasting it elsewhere — a
 * different note, a different vault — must decide: the property key
 * already exists in the target → **re-bind** directly; it doesn't →
 * **prompt-or-create** (the host surfaces a picker / create flow);
 * the payload isn't ours / is malformed → **ignore** (fall through to
 * the host's normal paste).
 *
 * Pure + framework-free so the round-trip + the decision tree are unit
 * tested without a DOM or a clipboard. The remaining B5.10 halves (the
 * lazy usage index rebuilt on note-save, and the shell Settings →
 * Properties pane) are shell-integration work tracked separately.
 */

import { PropertyView, enumGuard } from "@brainstorm-os/sdk-types";

/** Clipboard flavour. A custom MIME so a paste into a plain-text field
 *  never accidentally consumes it and the host can feature-detect us. */
export const PROPERTY_BLOCK_MIME = "application/x-brainstorm-property-block";

/** Bumped only on a breaking wire change; an unknown version parses to
 *  `null` (treated as "not ours") rather than mis-binding. */
const WIRE_VERSION = 1;

export interface PropertyBlockClip {
	/** Stable `prop_…` key the block is bound to. */
	propertyKey: string;
	/** Rendered view, or `null` to mean "the def's default view". */
	view: PropertyView | null;
	/** Opt-in copied value. Opaque here — its per-`ValueType` shape is
	 *  validated by the host on apply, not by the transport. Absent when
	 *  only the binding (not a concrete value) was copied. */
	value?: unknown;
}

const isPropertyView = enumGuard(Object.values(PropertyView));

/** Serialize a clip to the wire string put on the clipboard flavour. */
export function serializePropertyBlock(clip: PropertyBlockClip): string {
	const wire: Record<string, unknown> = {
		v: WIRE_VERSION,
		propertyKey: clip.propertyKey,
		view: clip.view,
	};
	if (clip.value !== undefined) wire.value = clip.value;
	return JSON.stringify(wire);
}

/**
 * Parse a wire string back to a clip, or `null` when it isn't a
 * well-formed current-version property-block payload. Tolerant by
 * design: bad JSON, a wrong/absent version, a missing/empty
 * `propertyKey`, or a non-object all yield `null`; an unrecognised
 * `view` degrades to `null` (default view) rather than rejecting the
 * whole clip.
 */
export function parsePropertyBlock(raw: string | null | undefined): PropertyBlockClip | null {
	if (typeof raw !== "string" || raw.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const o = parsed as Record<string, unknown>;
	if (o.v !== WIRE_VERSION) return null;
	if (typeof o.propertyKey !== "string" || o.propertyKey.length === 0) return null;
	const view = isPropertyView(o.view) ? o.view : null;
	const clip: PropertyBlockClip = { propertyKey: o.propertyKey, view };
	if (o.value !== undefined) clip.value = o.value;
	return clip;
}

export enum PasteRebindKind {
	/** The key resolves in the target — bind the pasted block straight to it. */
	Rebind = "rebind",
	/** The key is unknown to the target — host prompts to pick/create. */
	CreateOrPrompt = "create-or-prompt",
	/** Not a property-block payload (or malformed) — host handles the
	 *  paste normally. */
	Ignore = "ignore",
}

export type PasteRebindDecision =
	| {
			kind: PasteRebindKind.Rebind;
			propertyKey: string;
			view: PropertyView | null;
			value?: unknown;
	  }
	| { kind: PasteRebindKind.CreateOrPrompt; clip: PropertyBlockClip }
	| { kind: PasteRebindKind.Ignore };

/**
 * The paste-rebind decision tree. `hasPropertyKey` answers "does this
 * key exist in the target vault's property defs?" — the only host fact
 * the decision needs, kept as a callback so this stays pure and the
 * caller owns the property-store lookup.
 */
export function decidePasteRebind(
	raw: string | null | undefined,
	hasPropertyKey: (key: string) => boolean,
): PasteRebindDecision {
	const clip = parsePropertyBlock(raw);
	if (!clip) return { kind: PasteRebindKind.Ignore };
	if (hasPropertyKey(clip.propertyKey)) {
		return clip.value !== undefined
			? {
					kind: PasteRebindKind.Rebind,
					propertyKey: clip.propertyKey,
					view: clip.view,
					value: clip.value,
				}
			: { kind: PasteRebindKind.Rebind, propertyKey: clip.propertyKey, view: clip.view };
	}
	return { kind: PasteRebindKind.CreateOrPrompt, clip };
}
