/**
 * `dispatchOpenEntity` — the single editor-side entry to the host's
 * open-entity navigation (per §The
 * Link component — one navigation path, not a per-surface hand-roll).
 *
 * Every in-editor surface that renders a `brainstorm://entity/<id>` link
 * (Mod+K link markup, `@`-mention chips, the derived backlinks section,
 * page-ref / transclusion cards) routes its click through here so
 * navigation always travels the same path as launcher / right-click.
 * Surfaces that live *outside* the Lexical contenteditable (backlinks)
 * can't rely on the editor-root click interceptor — they call this
 * directly, which also avoids the raw `brainstorm://entity/...` GET that
 * would 404 at the protocol handler.
 *
 * The actual intent dispatch is wired by the host app via
 * `setEditorHost({ openEntity })`; the package stays free of intent
 * internals. `entityType`, when known (mention chips / backlink rows
 * carry it), is forwarded so the shell reaches the type-specific opener
 * without a resolver round-trip.
 */

import type { NavigationMode } from "@brainstorm-os/sdk";
import { getEditorHost } from "./editor-host";

export function dispatchOpenEntity(target: {
	entityId: string;
	entityType?: string;
	mode?: NavigationMode;
	/** `#block-<id>` anchor (B11.13) — forwarded so the receiving app can
	 *  scroll to the block after opening. */
	blockId?: string;
}): void {
	const open = getEditorHost().openEntity;
	if (!open) {
		console.warn("[editor/open-entity] no host openEntity wired for", target.entityId);
		return;
	}
	open(target);
}
