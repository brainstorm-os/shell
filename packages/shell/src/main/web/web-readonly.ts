/**
 * Browser-8 — the **read-only browse mode** (OQ-WV-5 → yes: agent-driven
 * browsing is navigate-and-read; form submission needs a user in the loop).
 *
 * An autonomous loop that browses is, by construction, reading pages it does
 * not control — so the page's content is untrusted input that can try to steer
 * the loop. The mitigation is structural rather than advisory: an app granted
 * only `web.browse:read-only` gets a view whose **state-changing requests are
 * refused at the network layer**, so "the model was talked into submitting the
 * form" is not a reachable state, no matter what the page or the model does.
 *
 * Two rules make it hold:
 *  - the mode is derived from the capabilities the **broker verified on the
 *    call**, never from a flag the caller passes — {@link resolveBrowseMode};
 *  - the mode is decided ONCE, when the view is created, so a tab cannot be
 *    widened mid-life by a later call.
 *
 * Both halves are pure so the policy is exhaustively unit-tested; the Electron
 * hookup (`web-view-factory`) only calls {@link isReadOnlyRequestAllowed}.
 */

import { WEB_BROWSE_CAP, WEB_BROWSE_READONLY_CAP } from "@brainstorm-os/sdk-types";

export enum BrowseMode {
	/** Ordinary browsing — what the Browser app itself gets. */
	Full = "full",
	/** Navigate + read only; state-changing requests are refused. */
	ReadOnly = "read-only",
}

/** The HTTP verbs a read-only view may issue. Anything else — including a verb
 *  we don't recognise — is refused (fail closed, not "allow unless known bad"). */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/**
 * The mode a view opened by this call runs in. `Full` requires the caller to
 * have declared `web.browse` (which the broker checked against the ledger);
 * everything else — including no browse capability at all — is `ReadOnly`.
 */
export function resolveBrowseMode(declaredCaps: readonly string[]): BrowseMode {
	if (declaredCaps.includes(WEB_BROWSE_CAP)) return BrowseMode.Full;
	if (declaredCaps.includes(WEB_BROWSE_READONLY_CAP)) return BrowseMode.ReadOnly;
	return BrowseMode.ReadOnly;
}

/** Whether a read-only view may issue this request. */
export function isReadOnlyRequestAllowed(method: string | undefined): boolean {
	if (!method) return false;
	return READ_METHODS.has(method.toUpperCase());
}
