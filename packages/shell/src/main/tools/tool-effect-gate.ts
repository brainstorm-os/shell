/**
 * The provider-side effect gate, shared by `tools.list` (Tool-2) and
 * `tools.call` (Tool-4).
 *
 * A tool's declared `effect` says what it intends to do; this says whether its
 * OWNING app still holds the capability that intent implies. Listing uses it to
 * stop offering a tool whose provider's grant was revoked; calling uses it to
 * refuse the call. They must not drift — a tool that lists but cannot be
 * called (or worse, the reverse) is the kind of gap a reviewer finds after it
 * has already shipped — so the rule lives in one place.
 *
 * `effect` LOWERS FRICTION BUT IS NEVER A SECURITY BOUNDARY (doc 78): the
 * ledger decides authority. A lying provider gets less friction, not more
 * power — it still cannot read what it has no grant for.
 */

import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { AppToolEffect, type AppToolRecord, isAppToolEffect } from "@brainstorm-os/sdk-types";

/** What each declared effect requires of the PROVIDER app. `pure` requires
 *  nothing; the rest ride the capability paths that already exist. */
export const EFFECT_REQUIREMENTS: Readonly<Record<AppToolEffect, readonly string[]>> = {
	[AppToolEffect.Pure]: [],
	// Matched by capability NAME, any live scope: the consent path only ever
	// grants scoped capabilities (`network.egress:<origin>`,
	// `entities.read:<type>`), so requiring a literal `*` scope would make the
	// filter unsatisfiable — a control that can never pass is a control nobody
	// notices regressing.
	[AppToolEffect.ReadsVault]: ["entities.read"],
	[AppToolEffect.External]: ["network.egress"],
	// A proposal is inert until a human approves it, so the tool itself needs
	// nothing; the approving write is gated where it happens.
	[AppToolEffect.ProposesWrite]: [],
};

/** Does the provider still hold what its declared effect implies? Any ledger
 *  trouble drops the tool (fail-closed) rather than offering it. */
export function providerSatisfiesEffect(
	ledger: CapabilityLedger | null,
	tool: AppToolRecord,
): boolean {
	// Validate BEFORE indexing: a plain object literal inherits `toString`,
	// `valueOf`, … so a corrupt row whose effect is an Object.prototype key
	// would resolve to a FUNCTION whose `.length === 0` — read as "requires
	// nothing" and skip this filter entirely, defeating the very guard the
	// repo's raw-effect passthrough exists to feed.
	if (!isAppToolEffect(tool.effect)) return false;
	const required = EFFECT_REQUIREMENTS[tool.effect];
	if (required === undefined) return false;
	if (required.length === 0) return true;
	if (!ledger) return false;
	try {
		return required.some(
			(capability) =>
				ledger.listActive(tool.appId).some((grant) => grant.capability === capability) ||
				ledger.has(tool.appId, capability),
		);
	} catch {
		return false;
	}
}
