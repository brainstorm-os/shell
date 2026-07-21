/**
 * JournalMentionClickPlugin — click-through routing for `@`-mention chips
 * inside the Journal day-body editor (F-237).
 *
 * The shared `MentionNode` renders an inline chip carrying `data-entity-id`
 * + `data-entity-type` but no click handler — by design, the host wires
 * navigation so it travels the one shared path (`dispatchOpenEntity`, per
 * ). Notes does this via its
 * `LinkMarkupPlugin`'s editor-root interceptor; the Journal editor is the
 * light baseline (no Mod+K link markup), so it carries the slimmer
 * mention-only interceptor here. Without it, inserting a link rendered a
 * chip that did nothing on click (the second half of F-237).
 *
 * A single capture-phase listener on the editor root resolves the clicked
 * chip lazily via `closest('[data-entity-id]')` — no per-chip listeners.
 * Modifier-held clicks pass the navigation mode through (plain = replace,
 * Cmd/Ctrl = new tab, Shift = new window), matching Notes.
 */

import { dispatchOpenEntity } from "@brainstorm-os/editor";
import { navModeFromEvent } from "@brainstorm-os/sdk";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useEffect } from "react";

const ENTITY_ID_ATTR = "data-entity-id";
const ENTITY_TYPE_ATTR = "data-entity-type";

/** Resolve a click target to the mention chip's entity id + type, or null
 *  when the click didn't land on (or inside) a mention chip. Exported for a
 *  headless unit test. */
export function resolveMentionTarget(
	target: EventTarget | null,
	root: HTMLElement,
): { entityId: string; entityType?: string } | null {
	const el = (target as HTMLElement | null)?.closest<HTMLElement>(`[${ENTITY_ID_ATTR}]`) ?? null;
	if (!el || !root.contains(el)) return null;
	const entityId = el.getAttribute(ENTITY_ID_ATTR);
	if (!entityId) return null;
	const entityType = el.getAttribute(ENTITY_TYPE_ATTR);
	return entityType ? { entityId, entityType } : { entityId };
}

export function JournalMentionClickPlugin(): null {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		const root = editor.getRootElement();
		if (!root) return;
		const onClick = (event: MouseEvent): void => {
			const mention = resolveMentionTarget(event.target, root);
			if (!mention) return;
			event.preventDefault();
			event.stopPropagation();
			dispatchOpenEntity({ ...mention, mode: navModeFromEvent(event) });
		};
		root.addEventListener("click", onClick, true);
		return () => root.removeEventListener("click", onClick, true);
	}, [editor]);
	return null;
}
