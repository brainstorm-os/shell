/**
 * `share_invites` repository (Collab-C5-invite-anchor) — this vault's own
 * outstanding and spent share invites.
 *
 * The invitee mints a `ShareInvite` carrying a fresh 32-byte secret, hands the
 * token to a collaborator out-of-band, and keeps the secret here. When that
 * collaborator's first share frame arrives, the grant naming us carries the
 * granter's MAC under this secret; redeeming it is what admits the bootstrap
 * (see `main/collab/invite-anchor.ts`). Persistence is the point — an invite must
 * stay spent across a restart, and must stay redeemable while a collaborator
 * takes a day to act on it.
 *
 * Per the Stage 5 repository-pattern decision, all `share_invites` SQL lives
 * here; the anchor policy (MAC verification, expiry, the pin) lives in
 * `invite-anchor.ts` and reaches the table only through these methods.
 */

import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import type { PinShareInviteInput, ShareInviteRecord } from "../../collab/invite-anchor";

type ShareInviteRow = {
	invite_id: string;
	secret: string;
	member_pub: string;
	created_at: number;
	expires_at: number;
	redeemed_at: number | null;
	redeemed_entity_id: string | null;
	redeemed_by: string | null;
	revoked_at: number | null;
};

export type MintShareInviteInput = {
	inviteId: string;
	secretB64: string;
	memberPubB64: string;
	createdAt: number;
	expiresAt: number;
};

const COLUMNS =
	"invite_id, secret, member_pub, created_at, expires_at, redeemed_at, redeemed_entity_id, redeemed_by, revoked_at";

function toRecord(row: ShareInviteRow): ShareInviteRecord {
	return {
		inviteId: row.invite_id,
		secretB64: row.secret,
		memberPubB64: row.member_pub,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		redeemedAt: row.redeemed_at,
		redeemedEntityId: row.redeemed_entity_id,
		redeemedBy: row.redeemed_by,
		revokedAt: row.revoked_at,
	};
}

export class ShareInvitesRepository {
	constructor(private readonly db: SqliteDatabase) {}

	/** Record a freshly minted invite. The id is a hash of the secret, so a
	 *  collision means the same invite — keep the existing (possibly spent) row
	 *  rather than resurrecting it. */
	mint(input: MintShareInviteInput): void {
		this.db
			.prepare(
				`INSERT INTO share_invites (invite_id, secret, member_pub, created_at, expires_at)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(invite_id) DO NOTHING`,
			)
			.run(input.inviteId, input.secretB64, input.memberPubB64, input.createdAt, input.expiresAt);
	}

	get(inviteId: string): ShareInviteRecord | null {
		const row = this.db
			.prepare(`SELECT ${COLUMNS} FROM share_invites WHERE invite_id = ?`)
			.get(inviteId) as ShareInviteRow | undefined;
		return row ? toRecord(row) : null;
	}

	/** Pin an invite to the one entity + granter it authorizes, CREATING the row
	 *  when this device has no record of the invite. A missing row is the normal
	 *  state on a cold-restored vault or a paired sibling, and the anchor's secret
	 *  is re-derived from the sovereign key rather than read from here, so the row
	 *  is a replay ledger rather than the trust root. The `IS NULL` guard makes the
	 *  first writer win even if two frames race: a second, losing pin changes
	 *  nothing and the caller's re-read refuses the mismatched pair. */
	pin(input: PinShareInviteInput): void {
		this.db
			.prepare(
				`INSERT INTO share_invites
					(invite_id, secret, member_pub, created_at, expires_at,
					 redeemed_at, redeemed_entity_id, redeemed_by)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(invite_id) DO UPDATE SET
					redeemed_at = excluded.redeemed_at,
					redeemed_entity_id = excluded.redeemed_entity_id,
					redeemed_by = excluded.redeemed_by
				WHERE share_invites.redeemed_entity_id IS NULL
					AND share_invites.redeemed_by IS NULL`,
			)
			.run(
				input.inviteId,
				input.secretB64,
				input.memberPubB64,
				input.now,
				input.now,
				input.now,
				input.entityId,
				input.ownerPubB64,
			);
	}

	/** Withdraw an invite that has not been redeemed yet (and stop a spent one
	 *  being retried). Returns true when a row was marked. */
	revoke(inviteId: string, now: number): boolean {
		const result = this.db
			.prepare("UPDATE share_invites SET revoked_at = ? WHERE invite_id = ? AND revoked_at IS NULL")
			.run(now, inviteId);
		return Number(result.changes) > 0;
	}

	/** Invites that can still be redeemed: unspent, unrevoked, unexpired. */
	listOutstanding(now: number): ShareInviteRecord[] {
		const rows = this.db
			.prepare(
				`SELECT ${COLUMNS} FROM share_invites
				WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at >= ?
				ORDER BY created_at, invite_id`,
			)
			.all(now) as ShareInviteRow[];
		return rows.map(toRecord);
	}

	/** Drop invites that expired without ever being redeemed, once they are
	 *  `graceMs` past expiry. A SPENT row is never purged — it is the record that
	 *  stops the invite being replayed at some other entity. */
	purgeExpired(now: number, graceMs: number): number {
		const result = this.db
			.prepare("DELETE FROM share_invites WHERE redeemed_at IS NULL AND expires_at < ?")
			.run(now - graceMs);
		return Number(result.changes);
	}
}
