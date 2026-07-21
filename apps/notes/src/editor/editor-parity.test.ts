/**
 * Editor capability drift-fence — Notes hand-assembles its plugin tree
 * (it interleaves Notes-only commands into the slash menu), while Journal /
 * Tasks / Bookmarks mount the shared `<FullEditorPlugins>`. That split is
 * the structural risk this file guards: a generic capability must never
 * live on one surface and not the other.
 *
 * The invariant is one-directional and intentional: the shared editor is
 * the capability FLOOR. Notes must offer every generic command + register
 * every node the shared full editor provides (so Notes never falls behind),
 * and Notes' generic commands must BE the shared commands (so Notes never
 * forks a bespoke copy). Per-surface palettes may still curate DOWN
 * (Journal/Bookmarks drop columns) — that's product choice, not drift.
 *
 * If this fails, a capability drifted: either the shared catalogue grew a
 * command/node Notes didn't pick up, or Notes re-authored a generic command.
 * Resolve by wiring the shared source through, not by copying.
 */

import {
	FULL_EDITOR_NODES,
	MEDIA_COMMAND_IDS,
	createEditorT,
	createMediaBlockCommands,
	createStandardBlockCommands,
} from "@brainstorm-os/editor";
import { describe, expect, it } from "vitest";
import { BLOCK_COMMANDS } from "./commands";
import { NOTES_ADDITIONAL_NODES } from "./notes-nodes";

const t = createEditorT();

describe("editor capability parity (Notes ⊇ shared full editor)", () => {
	it("registers every node the shared full editor provides", () => {
		// Any node added to FULL_EDITOR_NODES (what Journal/Tasks/Bookmarks
		// register) must also be registered by Notes, or peer-authored content
		// using that node fails to deserialize in Notes.
		for (const node of FULL_EDITOR_NODES) {
			expect(
				NOTES_ADDITIONAL_NODES,
				`${node.name} is in FULL_EDITOR_NODES but missing from NOTES_ADDITIONAL_NODES`,
			).toContain(node);
		}
	});

	it("offers every generic command the shared full editor exposes by default", () => {
		const mountedIds = new Set(BLOCK_COMMANDS.map((c) => c.id));
		// The command ids `<FullEditorPlugins>` mounts with its defaults:
		// the standard catalogue + media + the host-gated entity-embed and
		// transclusion commands.
		const sharedFullIds = [
			...createStandardBlockCommands(t).map((c) => c.id),
			...MEDIA_COMMAND_IDS,
			"block.embed.entity",
			"block.transclusion",
		];
		for (const id of sharedFullIds) {
			expect(mountedIds.has(id), `shared command ${id} must be mounted in Notes' slash menu`).toBe(
				true,
			);
		}
	});

	it("uses the SHARED media commands verbatim (no Notes-authored fork)", () => {
		const shared = createMediaBlockCommands(t);
		expect(shared.map((c) => c.id)).toEqual([...MEDIA_COMMAND_IDS]);
		for (const sharedCmd of shared) {
			const mounted = BLOCK_COMMANDS.find((c) => c.id === sharedCmd.id);
			expect(mounted, `${sharedCmd.id} must be mounted`).toBeTruthy();
			// Same wording as Journal/Tasks/Bookmarks — one media experience
			// everywhere (F-070), enforced by construction (Notes calls the
			// shared factory) and re-checked here.
			expect(mounted?.label).toBe(sharedCmd.label);
			expect(mounted?.description).toBe(sharedCmd.description);
		}
	});
});
