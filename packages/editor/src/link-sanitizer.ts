/**
 * Link-anchor URL sanitization for every Brainstorm editor surface.
 *
 * Lexical's `LinkNode.sanitizeUrl` (0.21) hardcodes an http(s) / mailto /
 * sms / tel allowlist and renders anything else as `href="about:blank"`.
 * That turned the app's OWN scheme into inert anchors: a
 * `brainstorm://entity/<id>` link (Mod+K link markup) and an imported
 * `brainstorm://asset/<id>` file link (a PDF planted by the Anytype /
 * Obsidian importer) both painted `about:blank`, so the Notes click
 * interceptor never saw an entity URI and the PDF anchor did nothing.
 *
 * `brainstorm:` is the shell's privileged, main-process-served protocol
 * (`protocol.handle("brainstorm", …)` in packages/shell `src/main/index.ts`)
 * — first-party vault content, safe to carry in an anchor. The allowlist
 * stays strict: http, https, mailto (already in Lexical's default) and
 * brainstorm. `javascript:`, `data:`, `file:` etc. remain blocked; sms/tel
 * are dropped — nothing in the app mints them.
 *
 * Why a prototype override rather than Lexical node replacement: the
 * `{replace: LinkNode, with: …}` hook only fires inside `$createLinkNode`
 * (`$applyNodeReplacement`). Yjs hydration constructs registered nodes
 * directly (`new nodeInfo.klass()` in @lexical/yjs) — and every Brainstorm
 * document editor is Yjs-backed, so the primary load path would miss a
 * replacement subclass entirely. Patching the method on the prototype
 * covers every construction path (importJSON, `$toggleLink`, paste, Yjs;
 * `AutoLinkNode` inherits it) with zero wire-format change — nodes stay
 * serialized type `"link"`.
 *
 * The override is applied at module evaluation; `nodes.ts` (the baseline
 * node set every full/headless editor registers) and `compact-editor.tsx`
 * (its own node list) both side-effect-import this module, and the file is
 * listed in package.json `sideEffects` so bundlers keep the patch.
 */

import { LinkNode } from "@lexical/link";

/** Schemes a link anchor may carry. Anything else renders `about:blank`. */
export const ALLOWED_LINK_PROTOCOLS: ReadonlySet<string> = new Set([
	"http:",
	"https:",
	"mailto:",
	"brainstorm:",
]);

/** Mirror of Lexical's `LinkNode.sanitizeUrl` contract with the Brainstorm
 *  allowlist: disallowed absolute URLs become `about:blank`; strings that
 *  don't parse as absolute URLs (`#block-…` anchors, relative paths) pass
 *  through unchanged, matching upstream behaviour. */
export function sanitizeLinkUrl(url: string): string {
	try {
		if (!ALLOWED_LINK_PROTOCOLS.has(new URL(url).protocol)) {
			return "about:blank";
		}
	} catch {
		return url;
	}
	return url;
}

LinkNode.prototype.sanitizeUrl = sanitizeLinkUrl;
