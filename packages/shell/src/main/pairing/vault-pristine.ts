/**
 * F-493 — is this vault safe to re-point at another identity?
 *
 * Pairing hands the joining device the SOURCE's sovereign identity. Every
 * authorization decision downstream keys off that identity, so adopting one is
 * an authority transfer, not a settings change. The sharp edge is
 * `authorizesWrapInstall`, whose FIRST rule is:
 *
 *     if (keyBytesEqual(input.senderKey, input.selfPub)) return true;
 *
 * — a frame from this vault's own sovereign key may install or ROTATE a DEK on
 * any entity, bypassing the Owner check entirely. That rule is correct and
 * exists for exactly the paired-device case. But it means that if a vault which
 * already holds the user's own work is re-pointed at someone else's identity,
 * that someone else silently gains unconditional rotation authority over
 * content they were never a member of — and rotation is worse than read,
 * because the victim then emits under a key the attacker holds.
 *
 * So joining is refused when the vault holds anything the user authored. The
 * supported shape is the one the product already assumes (see the comment on
 * `saveIdentitySecret` in `ipc/pairing-handlers.ts`): you join a vault, you do
 * not merge two.
 *
 * **Provenance, not type.** The classification is by WHO created the row, not
 * what kind it is. `SYSTEM_ENTITY_TYPES` exists but its own contract says it is
 * presentation-only and must "never change query or filtering semantics", so it
 * is the wrong input for a refusal. Bootstrap principals are a closed set this
 * repo controls; anything else is the user.
 *
 * Fail-closed: an unrecognised principal counts as user content, so a new
 * bootstrap writer that forgets to register here makes pairing refuse (visible,
 * recoverable) rather than silently permitting an authority transfer.
 */

/** Rows written by first-launch bootstrap rather than by the person. Each is a
 *  constant this repo owns — keep in sync with its definition site. */
export const BOOTSTRAP_PRINCIPALS: ReadonlySet<string> = new Set([
	"brainstorm.shell", // SHELL_ACTOR — the vault root Folder (vault/session.ts)
	"io.brainstorm.welcome", // WELCOME_SEED_CREATED_BY (welcome/welcome-content.ts)
	"io.brainstorm.welcome/template", // TEMPLATE_CREATED_BY (welcome/seed-template.ts)
	"shell", // SHELL_PRINCIPAL — seeded agent records (agents/agent-record.ts)
]);

/** The subset of an entity row this decision reads. */
export type PristineCandidate = { createdBy: string };

export type PristineVerdict = {
	/** True when every row came from a bootstrap principal. */
	pristine: boolean;
	/** How many rows look user-authored — for the refusal message. */
	userAuthored: number;
};

/**
 * Classify a vault's rows. Empty is pristine; so is a fresh install carrying
 * only its root Folder, welcome seed and stock agents.
 */
export function assessVaultPristine(rows: readonly PristineCandidate[]): PristineVerdict {
	let userAuthored = 0;
	for (const row of rows) {
		const principal = typeof row?.createdBy === "string" ? row.createdBy : "";
		if (!BOOTSTRAP_PRINCIPALS.has(principal)) userAuthored += 1;
	}
	return { pristine: userAuthored === 0, userAuthored };
}
