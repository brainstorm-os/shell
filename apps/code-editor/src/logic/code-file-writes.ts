/**
 * The ONE write path onto a `CodeFile` row — Lock-5(l).
 *
 * Code-editor derived `isCodeFileEditable(row)` (`contentKey === "content" &&
 * !row.locked`) and used it for the PANE's read-only state and the language
 * dropdown, then wrote through `entities.update` from three places that never
 * consulted it: the save (`persistSelected`, which writes the file's whole
 * CONTENT), the rename (path + language), and the folder move that re-paths a
 * batch of rows at once. A locked file was saved over, renamed and moved.
 *
 * So the decision lives here, once, over the shared `entity-lock` reading, and
 * the gate is inseparable from the write. Pure apart from the injected
 * `update`.
 */

import { lockRefusesWrite } from "@brainstorm-os/sdk/entity-lock";
import type { CodeFileRow } from "./code-projection";

export type CodeWriteContext = {
	/** The live row for an id, or `undefined` when it is gone. */
	find: (id: string) => CodeFileRow | undefined;
	/** `entities.update`, absent on a shell without the service. */
	update: ((id: string, patch: Record<string, unknown>) => Promise<unknown> | undefined) | undefined;
};

/** The current STORED lock for `id` — read at write time, never from a row the
 *  caller has been holding since the render that built the callback. */
export function codeFileLocked(ctx: Pick<CodeWriteContext, "find">, id: string): boolean {
	return ctx.find(id)?.locked === true;
}

/** Whether the lock refuses this write. `patch` omitted ⇒ a write with no
 *  patch to exempt. */
export function codeWriteRefused(
	ctx: Pick<CodeWriteContext, "find">,
	id: string,
	patch?: Record<string, unknown>,
): boolean {
	return lockRefusesWrite(codeFileLocked(ctx, id), patch);
}

/** Issue a property write onto a code file, or refuse it. Returns whether the
 *  write landed, so callers that mirror the row locally ride that answer
 *  rather than painting a save the vault never took. */
export async function writeCodeFilePatch(
	ctx: CodeWriteContext,
	id: string,
	patch: Record<string, unknown>,
): Promise<boolean> {
	if (codeWriteRefused(ctx, id, patch)) return false;
	const update = ctx.update;
	if (!update) return false;
	await update(id, patch);
	return true;
}
