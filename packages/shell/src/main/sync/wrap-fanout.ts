/**
 * Stage 10.3c — the multi-device DEK wrap fan-out **producer**.
 *
 * 10.3b built the entire receive half and no producer at all, so nothing in
 * production ever wrapped an entity DEK for a paired device: two of one user's
 * own devices have never synced a single entity. This is the missing half.
 *
 * Pure + injected, like the rest of `main/sync/`: no crypto, no relay, no
 * session. The caller supplies `wrapFor` (HPKE seal) and `emit` (envelope
 * pipeline), so every rule below is testable without a vault.
 *
 * ── Addressing ──────────────────────────────────────────────────────────
 * A sibling wrap rides the **identity** inbox (`inbox:<identityPub>`), which
 * both of a user's devices already subscribe, and the receiver ignores any
 * wrap whose `recipientPubB64` is not its own device key.
 *
 * The rung's original design chose a per-DEVICE inbox instead, on the premise
 * that the relay already sees device keys as the frame `sender` and so learns
 * nothing new. **That premise was wrong**: `PipelineContext.devicePub` is
 * `session.identity.publicKey` — the sovereign USER key — so every device of
 * one identity sends under the same `sender`, and the relay currently cannot
 * tell them apart. A per-device channel would hand it a brand-new identifier
 * revealing how many devices an identity has and which frames belong to which.
 * On a blind relay that is a real regression, and it buys only the bandwidth
 * of a sibling dropping a frame addressed to someone else.
 *
 * The drop is exact, not a decryption failure: `MemberWrapPayload` carries
 * `recipientPubB64`, so a device compares one string and stops. See the guard
 * at the `installWrap` receiver.
 *
 * ── Ordinals ────────────────────────────────────────────────────────────
 * `installEntityDek` accepts a STRICTLY-NEWER version only, and a device that
 * boots first mints placeholder DEKs at version 0 for rows it cannot read
 * (`RETRO_WRAP_PLACEHOLDER_VERSION`). A real wrap therefore has to carry the
 * real ordinal to outrank one. The trap runs the other way from what the rung
 * anticipated: fanning out an entity that is ITSELF still on the placeholder
 * would ship version 0, which every receiver rejects forever. So that is
 * refused here rather than emitted.
 *
 * ── Revocation ──────────────────────────────────────────────────────────
 * Every device this reaches keeps every DEK it is handed. That is precisely
 * what makes rotate-on-revoke (`LAN-2b(d)` / ROT-3a) load-bearing rather than
 * theoretical: without it, revoking a device does not take its access away.
 * Callers pass `devices` from `DevicesStore.listActive()`, which already drops
 * revoked devices, so a revoked device is never a fresh-wrap recipient.
 */

/** The version `retro-wrap-deks` stamps on a DEK minted for a row this device
 *  cannot read. Never fan one out — see the ordinal note above. */
export const PLACEHOLDER_DEK_VERSION = 0;

/** The subset of a `SignedAddDeviceRecord` the fan-out needs. */
export type FanoutDevice = {
	deviceEd25519Pub: string;
	/** Absent on a record written before device X25519 keys existed, and the
	 *  only key a DEK can be sealed to. */
	deviceX25519Pub?: string;
};

export type WrapFanoutResult = {
	/** Wraps successfully handed to the relay. */
	sent: number;
	/** `deviceEd25519Pub` of every sibling whose emit threw. */
	failed: string[];
	/** Set when the whole fan-out was declined before any emit. */
	refused?: "placeholder-dek";
};

/**
 * The devices that should receive a fresh wrap: every active device except
 * this one, that actually has a key to seal to.
 *
 * Self is excluded because it already holds the DEK — wrapping to yourself is
 * the bug 10.3b's `installEntityWrap` shipped (it hard-coded the local device
 * as the *only* recipient, which is why nothing ever reached a sibling).
 */
export function planWrapFanout(
	devices: readonly FanoutDevice[],
	selfDeviceEd25519Pub: string,
): FanoutDevice[] {
	return devices.filter(
		(d) =>
			d.deviceEd25519Pub !== selfDeviceEd25519Pub &&
			typeof d.deviceX25519Pub === "string" &&
			d.deviceX25519Pub.length > 0,
	);
}

export type FanOutEntityWrapArgs<TWrap> = {
	entityId: string;
	dek: Uint8Array;
	/** The entity's REAL DEK ordinal. Refused when not strictly positive. */
	version: number;
	type?: string;
	devices: readonly FanoutDevice[];
	selfDeviceEd25519Pub: string;
	/** `inbox:<identityPub>` — both of this identity's devices subscribe it. */
	identityRoute: string;
	wrapFor(
		dek: Uint8Array,
		recipientPubB64: string,
		entityId: string,
		type?: string,
		version?: number,
	): TWrap;
	emit(entityId: string, wrap: TWrap, route: string): Promise<void>;
};

/**
 * Seal this entity's DEK for every sibling device and hand each wrap to the
 * relay. Never throws: one unreachable device must not abort the rest, and a
 * backfill that dies on its first failure would strand every later entity.
 */
export async function fanOutEntityWrap<TWrap>(
	args: FanOutEntityWrapArgs<TWrap>,
): Promise<WrapFanoutResult> {
	if (!Number.isInteger(args.version) || args.version <= PLACEHOLDER_DEK_VERSION) {
		// Shipping this would be worse than shipping nothing: the receiver's
		// anti-rollback rule rejects it permanently, so the entity would look
		// fanned-out while staying unreadable on every sibling.
		return { sent: 0, failed: [], refused: "placeholder-dek" };
	}
	const recipients = planWrapFanout(args.devices, args.selfDeviceEd25519Pub);
	const failed: string[] = [];
	let sent = 0;
	for (const device of recipients) {
		const recipientPubB64 = device.deviceX25519Pub;
		if (!recipientPubB64) continue; // narrowed by planWrapFanout; belt and braces
		try {
			const wrap = args.wrapFor(args.dek, recipientPubB64, args.entityId, args.type, args.version);
			await args.emit(args.entityId, wrap, args.identityRoute);
			sent += 1;
		} catch {
			failed.push(device.deviceEd25519Pub);
		}
	}
	return { sent, failed };
}
