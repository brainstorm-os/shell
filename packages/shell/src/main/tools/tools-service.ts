/**
 * The `tools` broker service — Tool-2's read half (doc 78).
 *
 * `tools.list({ appliesTo?, surface? })` answers "what tools could act on
 * this?" from the REGISTRY only: applicability matches on declared entity
 * types, never on content, so a menu open costs one indexed read (doc 78
 * §Performance budgets).
 *
 * Three filters compose, all fail-closed:
 *   1. **Applicability** — declared `appliesTo` (empty = any) and `surfaces`.
 *   2. **Provider capability** — a tool is only offered while its OWNING app
 *      still holds every capability its declared `effect` implies. An app
 *      whose grant was revoked stops appearing without an uninstall.
 *   3. **Per-app disable** (AS-4) — the caller-side disable list; a disabled
 *      provider is invisible, not merely unclickable.
 *
 * The caller never learns about tools it may not see: filtering happens here,
 * not in the renderer.
 *
 * NOTE (Tool-2 scope): this rung *lists*. `tools.call` is Tool-4 — the
 * registry deliberately has no dispatch path yet.
 */

import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import {
	AppToolEffect,
	type AppToolRecord,
	type AppToolSurface,
	appToolApplies,
	isAppToolEffect,
	isAppToolSurface,
} from "@brainstorm-os/sdk-types";
import type { Envelope } from "../../ipc/envelope";
import type { AppToolsRepository } from "../storage/registry-repo/app-tools-repo";

/** Broker error shape — `name` is the machine-readable code the broker maps
 *  onto the envelope reply (same local helper the roster service uses). */
function makeError(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

/** Reading the tool catalogue is not a scarce act — any app may ask what can
 *  act on an object — but it IS capability-gated so a manifest-less caller
 *  (or a revoked app) can't enumerate the vault's provider surface. */
export const TOOLS_READ_CAPABILITY = "tools.read";

/** What each declared effect requires of the PROVIDER app. `pure` requires
 *  nothing; the rest ride the capability paths that already exist. A provider
 *  missing its own requirement is dropped from the listing — the declaration
 *  lowers friction, the ledger decides authority (doc 78). */
const EFFECT_REQUIREMENTS: Readonly<Record<AppToolEffect, readonly string[]>> = {
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

export type ToolsServiceOptions = {
	/** The registry repo, or null when no vault is open. */
	getRepo: () => Promise<AppToolsRepository | null> | AppToolsRepository | null;
	getLedger?: () => Promise<CapabilityLedger | null>;
	/** AS-4 — the user's disabled-contributor set, resolved per call (the store
	 *  is async; a sync predicate is what left this filter unwired at first). */
	resolveDisabledContributors?: () => Promise<ReadonlySet<string>>;
};

async function requireCapability(envelope: Envelope, options: ToolsServiceOptions): Promise<void> {
	if (!options.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "tools: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "tools: no active vault session");
	let held: boolean;
	try {
		held = ledger.has(envelope.app, TOOLS_READ_CAPABILITY);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "tools: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw makeError(
			"Denied",
			`tools.${envelope.method}: ${envelope.app} lacks ${TOOLS_READ_CAPABILITY}`,
		);
	}
}

/** Does the provider still hold what its declared effect implies? Any ledger
 *  trouble drops the tool (fail-closed) rather than offering it. */
function providerSatisfiesEffect(ledger: CapabilityLedger | null, tool: AppToolRecord): boolean {
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

export type ToolsListInput = {
	/** Entity type the caller wants tools for. Omit for "any". */
	appliesTo?: string;
	/** Surface the caller is rendering. Omit for "any surface". */
	surface?: AppToolSurface;
};

export async function handleToolsList(
	envelope: Envelope,
	options: ToolsServiceOptions,
): Promise<AppToolRecord[]> {
	await requireCapability(envelope, options);
	const repo = await options.getRepo();
	if (!repo) throw makeError("Unavailable", "tools: no active vault session");

	const raw = (envelope.args[0] ?? {}) as Record<string, unknown>;
	const appliesTo = typeof raw.appliesTo === "string" && raw.appliesTo ? raw.appliesTo : null;
	if (raw.surface !== undefined && !isAppToolSurface(raw.surface)) {
		throw makeError("Invalid", "tools.list: surface must be menu | agent | automation");
	}
	const surface = isAppToolSurface(raw.surface) ? raw.surface : null;

	const ledger = options.getLedger ? await options.getLedger().catch(() => null) : null;
	// Fail CLOSED on a disable-store read error: an unreadable disable set must
	// not silently re-enable every contributor the user switched off.
	const disabled = options.resolveDisabledContributors
		? await options.resolveDisabledContributors().catch(() => null)
		: new Set<string>();
	if (disabled === null)
		throw makeError("Unavailable", "tools: disabled-contributor set unreadable");

	return repo.listAll().filter((tool) => {
		// Tool-3 — a persisted declaration that failed to re-validate on read is
		// never offered. Checked first: everything below reasons about a tool
		// whose contract is intact.
		if (tool.declarationInvalid) return false;
		// A tool never offers itself back to its own provider's menu — the app
		// already has the function; the catalogue is for OTHER callers.
		if (tool.appId === envelope.app) return false;
		if (disabled.has(tool.appId)) return false;
		// "Registered but never presented" must hold on the UNFILTERED listing
		// too, or a naive menu consumer renders agent-only tools.
		if (tool.surfaces.length === 0) return false;
		if (surface !== null && !tool.surfaces.includes(surface)) return false;
		if (appliesTo !== null && !appToolApplies(tool, appliesTo)) return false;
		return providerSatisfiesEffect(ledger, tool);
	});
}

export function makeToolsServiceHandler(options: ToolsServiceOptions) {
	return async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case "list":
				return await handleToolsList(envelope, options);
			default:
				throw makeError("Invalid", `unknown tools method: ${envelope.method}`);
		}
	};
}
