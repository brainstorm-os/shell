/**
 * The ONE write path onto a `Person/v1` row — Lock-5(e), Lock-5(f), F-484.
 *
 * Lock-5(b) gated `patchPerson` / `deletePerson` and stopped there, which left
 * three write paths that never reach either: "+ Add company" (writes `company`
 * onto the person), the page body editor, and the duplicates merge (which
 * patches the survivor and BINS the losers). Lock-5(e) added the gates.
 *
 * Lock-5(f) then showed the gates were still decoration: they were four
 * separable `if (contactWriteRefused(…)) return;` lines sitting ABOVE their
 * writes in `app.tsx`, so a mutation pass could delete all four — and neuter
 * `contactWriteRefused` itself — with the whole Contacts suite green, because
 * every test asserted CHROME (`disabled` / `readOnly` / `contenteditable`) and
 * none asserted a refusal.
 *
 * So the gate is no longer separable from the write: each function below both
 * DECIDES and ISSUES, and `app.tsx` has no other spelling of a `Person` write
 * in scope. Deleting a guard now deletes the write behind it. Pure apart from
 * the injected service + local-mirror callbacks, so the refusals are
 * unit-testable without mounting the app.
 */

import { anyLockRefusesWrite } from "@brainstorm-os/sdk/entity-lock";

/** The slice of the entities service a Contacts write touches. Structural, so
 *  the app's own narrowed service type is assignable without a cast. */
export type ContactEntitiesService = {
	create(type: string, properties: Record<string, unknown>): Promise<{ id: string }>;
	update(id: string, patch: Record<string, unknown>): Promise<unknown>;
	delete(id: string): Promise<unknown>;
	merge?(
		survivorId: string,
		loserIds: readonly string[],
		patch: Record<string, unknown>,
	): Promise<unknown>;
};

/** Everything a gated write needs. Built fresh per call (from refs) so a
 *  callback that outlives its render — a blur commit, a confirm dialog, a
 *  picker's `onChange` — reads the CURRENT lock, not the one that held when it
 *  was built. */
export type ContactWriteContext = {
	isLocked: (id: string) => boolean;
	/** The entities service under the shell; `null` on the in-memory demo set. */
	vault: ContactEntitiesService | null;
	/** Mirror a landed property write onto the local (optimistic / demo) list. */
	applyPatch: (id: string, patch: Record<string, unknown>) => void;
	/** Drop a landed delete / merged-away rows from the local list. */
	applyRemoval: (ids: readonly string[]) => void;
	/** Mint a local id for a demo-mode Company (no service to mint one). */
	demoId: () => string;
	/** Mirror a landed demo merge onto the local list. */
	applyDemoMerge?: (
		survivorId: string,
		loserIds: readonly string[],
		patch: Record<string, unknown>,
	) => void;
};

/** Refuse a write that touches `ids`. `patch` is the property patch for a
 *  property write (so the lock-flip can be let through when it is the WHOLE
 *  patch), and is OMITTED for a write with no patch to exempt — a delete, or a
 *  merge that destroys its losers. */
export function contactWriteRefused(
	isLocked: (id: string) => boolean,
	ids: readonly string[],
	patch?: Record<string, unknown>,
): boolean {
	return anyLockRefusesWrite(isLocked, ids, patch);
}

/**
 * Patch a person's properties, or refuse. The gate every editable surface
 * reaches: the inline rows, the slide-over inspector, rename, icon, cover, the
 * bio migration, and the Lock toggle itself.
 *
 * Flipping the lock is the sole exception — or a lock could never be undone —
 * and only when it is the WHOLE patch (Lock-5(e): the old key-presence reading
 * let `{ locked, name }` walk a rename through on the lock's ticket).
 *
 * Returns whether the write went out.
 */
export async function patchPersonWrite(
	ctx: ContactWriteContext,
	id: string,
	patch: Record<string, unknown>,
): Promise<boolean> {
	if (contactWriteRefused(ctx.isLocked, [id], patch)) return false;
	if (ctx.vault) await ctx.vault.update(id, patch);
	ctx.applyPatch(id, patch);
	return true;
}

/** Delete a person, or refuse. Delete is a write with no patch to exempt, so a
 *  locked contact refuses it outright — the ⋯ already offers Delete
 *  disabled-with-the-reason, but this is the same rule where the write happens,
 *  which the chord and the confirm cannot skip. */
export async function deletePersonWrite(ctx: ContactWriteContext, id: string): Promise<boolean> {
	if (contactWriteRefused(ctx.isLocked, [id])) return false;
	if (ctx.vault) await ctx.vault.delete(id);
	ctx.applyRemoval([id]);
	return true;
}

/**
 * Mint a brand-new Company and link it to the person in one step — the shared
 * ref picker can only pick EXISTING entities and nothing else in the founder's
 * toolset mints a Company, so Contacts owns this.
 *
 * The refusal is checked BEFORE the Company is minted: refusing halfway would
 * leave an orphan Company nobody asked for. Asked WITHOUT a patch — the write
 * is `{ company: <new id> }`, which the lock-flip exemption could never cover,
 * and the id does not exist yet.
 *
 * Returns the new Company id, or `null` when refused / the name was blank.
 */
export async function createCompanyForWrite(
	ctx: ContactWriteContext,
	companyType: string,
	personId: string,
	rawName: string,
): Promise<string | null> {
	const name = rawName.trim();
	if (!name) return null;
	if (contactWriteRefused(ctx.isLocked, [personId])) return null;
	if (ctx.vault) {
		const company = await ctx.vault.create(companyType, { name });
		await ctx.vault.update(personId, { company: company.id });
		ctx.applyPatch(personId, { company: company.id });
		return company.id;
	}
	const id = ctx.demoId();
	ctx.applyPatch(personId, { company: id });
	return id;
}

/**
 * Merge duplicates: the survivor takes a property patch, every loser is BINNED.
 * Detection already excludes locked contacts, so this is the gate at the write
 * itself — a lock that arrives between the dialog opening and the merge button
 * still holds. ONE locked participant, survivor or loser, refuses the whole
 * operation: a half-landed merge is worse than no merge.
 */
export async function mergeContactsWrite(
	ctx: ContactWriteContext,
	survivorId: string,
	loserIds: readonly string[],
	patch: Record<string, unknown>,
): Promise<boolean> {
	if (contactWriteRefused(ctx.isLocked, [survivorId, ...loserIds])) return false;
	const merge = ctx.vault?.merge;
	if (ctx.vault && merge) {
		await merge.call(ctx.vault, survivorId, loserIds, patch);
		ctx.applyRemoval(loserIds);
		return true;
	}
	ctx.applyDemoMerge?.(survivorId, loserIds, patch);
	return true;
}
