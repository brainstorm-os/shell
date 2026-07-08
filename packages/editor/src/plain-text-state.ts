/**
 * Plain-text → `SerializedEditorState` — the lazy "legacy string field →
 * universal body" migration shape shared by every app that seeds an
 * entity's Y.Doc body from a flat text property on first open (Tasks'
 * `notes`, Contacts' `bio`). One paragraph per line, empty lines
 * preserved as empty paragraphs so the structure round-trips visually;
 * a blank / whitespace-only string yields an empty root (the editor
 * shows its placeholder, nothing to plant).
 *
 * Kept DOM-free + Lexical-runtime-free so the conversion is
 * unit-testable without an editor mount.
 */

import type { SerializedEditorState } from "lexical";

type SerializedNode = {
	type: string;
	version: number;
	[key: string]: unknown;
};

function textNode(text: string): SerializedNode {
	return {
		type: "text",
		version: 1,
		detail: 0,
		format: 0,
		mode: "normal",
		style: "",
		text,
	};
}

function paragraph(children: SerializedNode[]): SerializedNode {
	return {
		type: "paragraph",
		version: 1,
		format: "",
		indent: 0,
		direction: "ltr",
		children,
	};
}

export function plainTextToSerializedState(text: string): SerializedEditorState {
	const trimmed = text.trim();
	const children: SerializedNode[] =
		trimmed.length === 0
			? []
			: text.split("\n").map((line) => paragraph(line.length > 0 ? [textNode(line)] : []));
	return {
		root: {
			type: "root",
			version: 1,
			format: "",
			indent: 0,
			direction: "ltr",
			children,
		},
	} as unknown as SerializedEditorState;
}

/** True when a legacy string field is worth seeding into the body —
 *  i.e. there's actual content to carry over. */
export function hasLegacyText(text: string | undefined | null): text is string {
	return typeof text === "string" && text.trim().length > 0;
}

/**
 * Decide whether the first real body edit should clear the entity's
 * legacy string field. Fires once per entity: only when it still
 * carries non-empty text AND this session hasn't already migrated it
 * (the caller tracks migrated ids). The gated autosave plugin only
 * calls back after genuine user interaction, so a clear here means the
 * body now owns the content.
 */
export function shouldClearLegacyText(
	text: string | undefined | null,
	alreadyMigrated: boolean,
): boolean {
	return !alreadyMigrated && hasLegacyText(text);
}
