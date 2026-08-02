/**
 * `tools.call({ tool, args })` — Tool-4, the invocation half (doc 78).
 *
 * `tools.list` answers "what could act on this?"; this actually runs one, in
 * the providing app's own sandbox, over the Tool-1 reverse channel. Everything
 * before the dispatch is a gate, and the ORDER of those gates is itself a
 * security property:
 *
 *   1. **Authorization first, existence second.** The caller's grant is checked
 *      against an appId parsed out of the requested id, BEFORE the registry is
 *      touched. An unauthorized caller therefore cannot use the difference
 *      between `Denied` and `Unavailable` to enumerate which tools a vault has
 *      installed — every id it may not call answers the same way.
 *   2. Then the tool must actually be callable (present, intact declaration,
 *      provider not disabled, not the caller's own tool).
 *   3. Then the PROVIDER must still hold its declared effect's capability and
 *      `tools.provide` — a provider whose grant was revoked stops answering
 *      without an uninstall.
 *   4. Then arguments are validated against the declaration — the whole point
 *      of Tool-3 — including the `allowedTypes` check that could not be done
 *      there because it needs the entity store.
 *   5. Then friction: `pure` runs, an agent-initiated vault read asks first.
 *   6. Only then does anything cross into the provider.
 *
 * Two capability strings, both on the existing `(appId, capability, scope)`
 * shape with no new ledger machinery:
 *
 *   - `tools.provide` — held by the PROVIDER; an app cannot be called at all
 *     without it, so "stop answering calls" is a revoke, not an uninstall.
 *   - `tools.call:<appId>` / `tools.call:<appId>/<toolName>` — held by the
 *     CALLER, per-provider or narrowed to a single tool.
 *
 * The ledger has no prefix matching (`has()` is exact-string or literal `*`),
 * so the broad and narrow forms are checked as two explicit questions rather
 * than one glob. That is deliberate: a scope grammar the ledger cannot see is
 * a grammar that silently means nothing.
 */

import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import { isAgentPrincipal } from "@brainstorm-os/capabilities/principals";
import {
	APP_TOOL_NAME_RE,
	AppToolApprovalState,
	AppToolEffect,
	type AppToolInput,
	type AppToolRecord,
	ToolCallInitiator,
	ToolFrictionDecision,
	ValueType,
	appToolApprovalState,
	appToolFingerprint,
	decideAppToolFriction,
	isMultiValued,
} from "@brainstorm-os/sdk-types";
import { validateAppToolArgs } from "@brainstorm-os/sdk/app-tool-args";
import type { Envelope } from "../../ipc/envelope";
import { APP_ID_PATTERN } from "../apps/manifest";
import type { AppToolsRepository } from "../storage/registry-repo/app-tools-repo";
import { AppCallFailure, type AppCallHost } from "./app-call-host";
import { type ToolApprovalHost, approvalReasonFor } from "./tool-approval-host";
import { providerSatisfiesEffect } from "./tool-effect-gate";

/** Held by a PROVIDER. Unscoped: it is the right to be callable at all, not
 *  the right to be called by anyone in particular. */
export const TOOLS_PROVIDE_CAPABILITY = "tools.provide";
/** Held by a CALLER, always scoped — an unscoped `tools.call` grant means
 *  nothing and is never accepted. */
export const TOOLS_CALL_CAPABILITY = "tools.call";

/** `tools.call:<appId>` (whole provider) or `tools.call:<appId>/<toolName>`
 *  (one tool). The two are separate ledger rows; see the file header on why
 *  they are asked separately. */
export function toolsCallCapability(appId: string, toolName?: string): string {
	return toolName === undefined
		? `${TOOLS_CALL_CAPABILITY}:${appId}`
		: `${TOOLS_CALL_CAPABILITY}:${appId}/${toolName}`;
}

/** Split `app.<appId>.<toolName>` back into its parts.
 *
 * An appId contains dots and a tool name may not (`APP_TOOL_NAME_RE` is
 * dot-free precisely so this parse is unambiguous), so the LAST dot is the
 * separator. Returns null for anything that is not a well-formed app-tool id —
 * including an `mcp.*` id, which must never resolve here. */
export function parseAppToolId(id: string): { appId: string; toolName: string } | null {
	if (typeof id !== "string" || !id.startsWith("app.")) return null;
	const rest = id.slice("app.".length);
	const lastDot = rest.lastIndexOf(".");
	if (lastDot <= 0 || lastDot === rest.length - 1) return null;
	const appId = rest.slice(0, lastDot);
	const toolName = rest.slice(lastDot + 1);
	// Both halves must be shapes `appToolId()` could actually have MINTED. The
	// id here is caller-supplied, so without this the parse accepts an appId
	// containing `/` — and `tools.call:<appId>` for `a/b` is then byte-identical
	// to `tools.call:<appId>/<toolName>` for (`a`, `b`), i.e. a narrow per-tool
	// grant reads as a broad grant over a namespace that does not exist. (Found
	// by this rung's pentest, exploited end to end.)
	if (!APP_ID_PATTERN.test(appId) || !APP_TOOL_NAME_RE.test(toolName)) return null;
	return { appId, toolName };
}

function makeError(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

/** One uniform refusal for every "you cannot call this" case — missing,
 *  poisoned declaration, disabled provider, provider lacking its own grants,
 *  or the caller's own tool. Distinguishing them would hand a caller an
 *  enumeration oracle over the vault's installed apps. */
function notCallable(id: string): Error {
	return makeError("Unavailable", `tools.call: no callable tool ${id}`);
}

/** Metadata-only record of one call. Values NEVER appear — only the shape, the
 *  same rule `mcp-audit-log` follows. This is the seam Tool-8's trace row
 *  plugs into; nothing persists it yet. */
export type ToolCallRecord = {
	ts: number;
	callerAppId: string;
	toolId: string;
	providerAppId: string;
	argKeys: readonly string[];
	initiator: ToolCallInitiator;
	outcome: "ok" | "refused" | "error";
	reason?: string;
	durationMs: number;
};

export type ToolsCallOptions = {
	getRepo: () => Promise<AppToolsRepository | null> | AppToolsRepository | null;
	getLedger?: () => Promise<CapabilityLedger | null>;
	resolveDisabledContributors?: () => Promise<ReadonlySet<string>>;
	/** The Tool-1 reverse channel. Absent = calling is not wired up, which is a
	 *  refusal, never a silent success. */
	getCallHost?: () => AppCallHost | null;
	/** Resolve an entity's REAL type from the store. Required before a tool
	 *  declaring `allowedTypes` may be called; the caller's claim about a
	 *  referenced object's type is never trusted. */
	resolveEntityType?: (entityId: string) => Promise<string | null>;
	/** Is this object read-only? Required before a `proposes-write` tool may
	 *  touch it; absent ⇒ treated as locked (fail closed). */
	resolveEntityLocked?: (entityId: string) => Promise<boolean>;
	/** The shell-owned approval prompt (Tool-8). Absent = nothing can be
	 *  approved, so a call needing approval refuses rather than proceeding. */
	getApprovalHost?: () => ToolApprovalHost | null;
	/** Provider display name for the approval prompt. */
	resolveAppLabel?: (appId: string) => string | undefined | Promise<string | undefined>;
	/** The user's per-tool approval record (Tool-5). Absent = no rug-pull check,
	 *  which is the pre-Tool-5 behaviour and only used by callers that have no
	 *  registry (tests). */
	getApprovals?: () => Promise<ToolApprovals | null>;
	onCall?: (record: ToolCallRecord) => void;
	now?: () => number;
};

/** The slice of the approvals repo this path needs. */
export type ToolApprovals = {
	get(callerAppId: string, toolId: string): string | null;
	approve(callerAppId: string, toolId: string, appId: string, fingerprint: string, at: number): void;
};

export type ToolsCallInput = {
	tool: string;
	args?: Record<string, unknown>;
	/** REMOVED in Tool-8. A caller cannot assert on a human's behalf; the shell
	 *  asks. Still parsed and IGNORED so an older caller sending it neither
	 *  breaks nor gains anything. */
	confirmed?: never;
};

function parseCallInput(raw: unknown): ToolsCallInput {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw makeError("Invalid", "tools.call: expected { tool, args? }");
	}
	const a = raw as Record<string, unknown>;
	if (typeof a.tool !== "string" || a.tool.length === 0) {
		throw makeError("Invalid", "tools.call: tool must be a non-empty id");
	}
	// An absent `args` means "no arguments", which is not the same as a
	// malformed one — a non-object here is a caller bug and is refused rather
	// than coerced to {} (the coercion MCP does, which hides the mistake).
	if (
		a.args !== undefined &&
		(typeof a.args !== "object" || a.args === null || Array.isArray(a.args))
	) {
		throw makeError("Invalid", "tools.call: args must be an object");
	}
	return {
		tool: a.tool,
		args: (a.args as Record<string, unknown>) ?? {},
		// Deliberately not read — see `confirmed` on the type.
	};
}

async function readLedger(options: ToolsCallOptions): Promise<CapabilityLedger> {
	if (!options.getLedger) throw makeError("Unavailable", "tools.call: no capability ledger");
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "tools.call: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "tools.call: no active vault session");
	return ledger;
}

/** Fail-closed `has`: a ledger that throws is not a ledger that granted. */
function holds(ledger: CapabilityLedger, appId: string, capability: string): boolean {
	try {
		return ledger.has(appId, capability);
	} catch {
		return false;
	}
}

/** `tools.call` is checked against EXACT scopes only — a `tools.call:*` grant
 *  is refused.
 *
 * `ledger.has()` honours a literal `*` scope, which for most capabilities is a
 * reasonable "all of them". For this one it would mean "may call every app,
 * including every app installed after the grant was made" — authority that
 * silently grows without another consent. A caller that should reach many
 * providers holds many rows. */
export function holdsExactScope(
	ledger: CapabilityLedger,
	appId: string,
	required: string,
): boolean {
	const colon = required.indexOf(":");
	const capability = required.slice(0, colon);
	const scope = required.slice(colon + 1);
	try {
		return ledger
			.listActive(appId)
			.some((grant) => grant.capability === capability && grant.scope === scope);
	} catch {
		return false;
	}
}

/** Every entityRef argument whose declaration narrows `allowedTypes` is
 *  checked against the entity's REAL type from the store.
 *
 * This is the half of the declaration Tool-3 could not enforce (a pure module
 * has no business reading the vault). Trusting the caller here would be the
 * per-type read-isolation bypass in its classic form: pass the id of an object
 * whose type the tool was never granted, and let the provider read it back. */
async function enforceAllowedTypes(
	inputs: readonly AppToolInput[],
	args: Readonly<Record<string, unknown>>,
	options: ToolsCallOptions,
): Promise<string | null> {
	const constrained = inputs.filter(
		(i) =>
			i.valueType === ValueType.EntityRef && i.allowedTypes !== undefined && i.allowedTypes.length > 0,
	);
	if (constrained.length === 0) return null;
	if (!options.resolveEntityType) {
		// A declaration we cannot check is a declaration we cannot honour.
		return "entity-type resolution unavailable";
	}
	for (const input of constrained) {
		// `Object.hasOwn`, not `=== undefined`: an argument may legally be named
		// `valueOf` or `toString`, and on any object WITH a prototype an omitted
		// one reads back as the inherited FUNCTION. `validateAppToolArgs` already
		// returns a null-prototype bag; this is the second lock.
		if (!Object.hasOwn(args, input.name)) continue;
		const supplied = args[input.name];
		if (supplied === undefined) continue;
		const ids = isMultiValued(input.count) ? (supplied as unknown[]) : [supplied];
		for (const id of ids) {
			if (typeof id !== "string") return `${input.name}: expected an entity id`;
			let actual: string | null;
			try {
				actual = await options.resolveEntityType(id);
			} catch {
				return `${input.name}: entity type unresolvable`;
			}
			if (actual === null || !input.allowedTypes?.includes(actual)) {
				// Same message whether the object is of the wrong type or does not
				// exist — otherwise this is an existence oracle over the vault.
				return `${input.name}: not an allowed entity for this tool`;
			}
		}
	}
	return null;
}

/** The first entityRef argument naming a LOCKED object, or null.
 *
 * Fails closed: if the lock cannot be resolved we treat the object as locked,
 * because "we could not tell" and "it is editable" are not the same answer. */
async function lockedTarget(
	inputs: readonly AppToolInput[],
	args: Readonly<Record<string, unknown>>,
	options: ToolsCallOptions,
): Promise<string | null> {
	const refs = inputs.filter((i) => i.valueType === ValueType.EntityRef);
	if (refs.length === 0) return null;
	for (const input of refs) {
		if (!Object.hasOwn(args, input.name)) continue;
		const supplied = args[input.name];
		const ids = isMultiValued(input.count) ? (supplied as unknown[]) : [supplied];
		for (const id of ids) {
			if (typeof id !== "string") continue;
			if (!options.resolveEntityLocked) return input.name;
			try {
				if (await options.resolveEntityLocked(id)) return input.name;
			} catch {
				return input.name;
			}
		}
	}
	return null;
}

export async function handleToolsCall(
	envelope: Envelope,
	options: ToolsCallOptions,
): Promise<{ value: unknown }> {
	const now = options.now ?? Date.now;
	const startedMs = now();
	const input = parseCallInput(envelope.args[0]);

	const parsed = parseAppToolId(input.tool);
	// Not an app-tool id at all — refuse before anything else looks at it, so an
	// `mcp.*` id can never be routed through the app-tool path.
	if (!parsed) throw makeError("Invalid", "tools.call: tool must be an app.<appId>.<name> id");

	// Fail CLOSED into the *more* restricted class: `UserGesture` is the laxer
	// branch (it is the one that can auto-run at all), so it is granted
	// only to a principal that is a WELL-FORMED APP ID. Anything else — an agent
	// fingerprint, a malformed one, or something unrecognisable — is an agent.
	//
	// Testing the agent prefix instead is not enough, and the pentest's
	// verification pass proved it: `ED25519:deadbeef`, ` ed25519:deadbeef` and a
	// fullwidth-colon variant all miss a prefix test and land in the laxer
	// branch. Asking the positive question ("is this an app?") has no such tail,
	// because `APP_ID_PATTERN` forbids `:` outright.
	const initiator =
		!isAgentPrincipal(envelope.app) && APP_ID_PATTERN.test(envelope.app)
			? ToolCallInitiator.UserGesture
			: ToolCallInitiator.Agent;
	let providerAppId = parsed.appId;
	const record = (
		outcome: ToolCallRecord["outcome"],
		reason?: string,
		argKeys: readonly string[] = [],
	) => {
		options.onCall?.({
			ts: startedMs,
			callerAppId: envelope.app,
			toolId: input.tool,
			providerAppId,
			argKeys,
			initiator,
			outcome,
			...(reason === undefined ? {} : { reason }),
			durationMs: now() - startedMs,
		});
	};

	const ledger = await readLedger(options);

	// ── 1. Caller authorization, before the registry is touched ──────────────
	// Re-checked against the LEDGER, never `envelope.caps` — the app controls
	// what it declares in the envelope.
	const mayCall =
		holdsExactScope(ledger, envelope.app, toolsCallCapability(parsed.appId, parsed.toolName)) ||
		holdsExactScope(ledger, envelope.app, toolsCallCapability(parsed.appId));
	if (!mayCall) {
		record("refused", "denied");
		throw makeError(
			"Denied",
			`tools.call: ${envelope.app} lacks ${toolsCallCapability(parsed.appId, parsed.toolName)}`,
		);
	}

	// ── 2. Is there a callable tool behind that id? ──────────────────────────
	const repo = await options.getRepo();
	if (!repo) throw makeError("Unavailable", "tools.call: no active vault session");
	const tool: AppToolRecord | null = repo.get(input.tool);
	if (!tool || tool.declarationInvalid) {
		record("refused", tool ? "declaration-invalid" : "no-tool");
		throw notCallable(input.tool);
	}
	providerAppId = tool.appId;
	// The id parsed one provider and the registry stored another: impossible
	// through the installer, so treat it as corruption rather than reconciling.
	if (tool.appId !== parsed.appId || tool.name !== parsed.toolName) {
		record("refused", "id-mismatch");
		throw notCallable(input.tool);
	}
	if (tool.appId === envelope.app) {
		record("refused", "self-call");
		throw notCallable(input.tool);
	}

	const disabled = options.resolveDisabledContributors
		? await options.resolveDisabledContributors().catch(() => null)
		: new Set<string>();
	// Fail CLOSED on an unreadable disable set — it must not silently re-enable
	// a contributor the user switched off.
	if (disabled === null) {
		record("refused", "disable-set-unreadable");
		throw makeError("Unavailable", "tools.call: disabled-contributor set unreadable");
	}
	if (disabled.has(tool.appId)) {
		record("refused", "provider-disabled");
		throw notCallable(input.tool);
	}

	// ── 3. Provider authorization ────────────────────────────────────────────
	if (!holds(ledger, tool.appId, TOOLS_PROVIDE_CAPABILITY)) {
		record("refused", "no-tools-provide");
		throw notCallable(input.tool);
	}
	if (!providerSatisfiesEffect(ledger, tool)) {
		record("refused", "provider-effect");
		throw notCallable(input.tool);
	}

	// ── 4. Arguments ─────────────────────────────────────────────────────────
	const validation = validateAppToolArgs(tool.input, input.args ?? {});
	if (!validation.ok) {
		record("refused", "invalid-args");
		throw makeError("Invalid", `tools.call: ${validation.errors.join("; ")}`);
	}
	// Only the VALIDATED object crosses — never the caller's original, which
	// may carry keys the declaration never mentioned.
	const args = validation.args;
	const argKeys = Object.keys(args).sort();

	const typeError = await enforceAllowedTypes(tool.input, args, options);
	if (typeError) {
		record("refused", "entity-type", argKeys);
		throw makeError("Denied", `tools.call: ${typeError}`);
	}

	// Tool-8 — a locked object is read-only, and the lock has to hold on EVERY
	// write path or it is decoration (the lesson the read-only-lock fleet
	// already taught: inspector, cover, icon, drag, rename, delete and menu all
	// had to gate on it, not just the editor). A `proposes-write` tool takes an
	// object and comes back with a change to it, so it is a write path — the
	// proposal would be built against something the user froze. Refused BEFORE
	// the provider sees the id, so a locked object is not even readable this way.
	if (tool.effect === AppToolEffect.ProposesWrite) {
		const locked = await lockedTarget(tool.input, args, options);
		if (locked) {
			record("refused", "locked-object", argKeys);
			throw makeError("Denied", `tools.call: ${locked} is locked`);
		}
	}

	// ── 5. Friction ──────────────────────────────────────────────────────────
	// Tool-5 — a declaration that CHANGED since the user approved it (or was
	// never approved) needs a human answer regardless of what its `effect` would
	// otherwise buy. `effect` is self-declared, so without this an app update
	// could flip a tool from `pure` to something else, rewrite its description,
	// and keep the auto-run the old wording earned.
	// Fail CLOSED, exactly like the disable-set read above: an approvals store we
	// cannot read is not a store that approved anything. Treating it as
	// "approved" would silently restore pre-Tool-5 friction the moment the
	// registry hiccups — the failure mode nobody would notice.
	const approvals = options.getApprovals
		? await options.getApprovals().catch(() => null)
		: undefined;
	if (approvals === null) {
		record("refused", "approvals-unreadable", argKeys);
		throw makeError("Unavailable", "tools.call: approval record unreadable");
	}
	let approval = AppToolApprovalState.Approved;
	if (approvals) {
		try {
			approval = appToolApprovalState(tool, approvals.get(envelope.app, tool.id));
		} catch {
			// A store that throws mid-read is as unreadable as one that would not
			// open. Refuse rather than let a raw driver error escape unaudited.
			record("refused", "approvals-unreadable", argKeys);
			throw makeError("Unavailable", "tools.call: approval record unreadable");
		}
	}
	const friction =
		approval === AppToolApprovalState.Approved
			? decideAppToolFriction(tool.effect, initiator)
			: ToolFrictionDecision.Confirm;
	if (friction === ToolFrictionDecision.Confirm) {
		// Tool-8 — the SHELL asks, in the dashboard the user trusts, and the
		// answer never passes through the caller. `Tool-4`'s `confirmed: true`
		// was a caller assertion about a human it could not prove: sound for an
		// app backed by a real gesture, unsound for an agent (which would be
		// approving itself) and unverifiable from a compromised one. Removing it
		// closes both, and lets an AGENT-initiated call be approved at all —
		// previously it was refused outright, which made agent tool-calling dead.
		const approver = options.getApprovalHost?.();
		if (!approver) {
			record("refused", "no-approval-host", argKeys);
			throw makeError(
				"NeedsConfirm",
				`tools.call: ${input.tool} needs approval and none can be asked`,
			);
		}
		const accepted = await approver
			.request({
				callerAppId: envelope.app,
				tool,
				providerLabel: (await options.resolveAppLabel?.(tool.appId)) ?? tool.appId,
				reason: approvalReasonFor(approval),
				agentInitiated: initiator === ToolCallInitiator.Agent,
			})
			.catch(() => false);
		if (!accepted) {
			record("refused", `declined:${approvalReasonFor(approval)}`, argKeys);
			throw makeError("NeedsConfirm", `tools.call: ${input.tool} was not approved`);
		}
	}

	// ── 6. Dispatch ──────────────────────────────────────────────────────────
	const host = options.getCallHost?.() ?? null;
	if (!host) {
		record("refused", "no-call-host");
		throw makeError("Unavailable", "tools.call: the app call channel is unavailable");
	}

	let result: Awaited<ReturnType<AppCallHost["call"]>>;
	try {
		result = await host.call(tool.appId, tool.name, args);
	} catch (error) {
		// `AppCallHost.call` rejects on exactly one condition — the shell-owned
		// deadline — and resolves every other failure structurally.
		record("error", "timeout", argKeys);
		throw makeError("Timeout", `tools.call: ${(error as Error).message}`);
	}

	if (result.ok) {
		// Re-baseline THIS tool, for THIS caller, only after the call actually
		// worked — an approval recorded ahead of a failed dispatch would bless a
		// surface the user never saw function. Blessing the whole app on one
		// approval is the hole the MCP path documents.
		// A Confirm that reached here means the SHELL asked and a human said yes,
		// so this is a real approval to record — not a caller's claim.
		if (approvals && friction === ToolFrictionDecision.Confirm) {
			try {
				approvals.approve(envelope.app, tool.id, tool.appId, appToolFingerprint(tool), now());
			} catch {
				// Losing the baseline costs another prompt next time; it must not
				// cost the caller its result.
				record("ok", "approval-not-recorded", argKeys);
				return { value: result.value };
			}
		}
		record("ok", undefined, argKeys);
		return { value: result.value };
	}
	record("error", result.reason, argKeys);
	throw makeError(FAILURE_KIND[result.reason], failureMessage(input.tool, result));
}

/** Each transport failure keeps its own error kind so a caller can render a
 *  NAMED refusal rather than a generic one (doc 78 / Tool-8: a hung spinner or
 *  an unexplained failure is the bug). */
const FAILURE_KIND: Readonly<Record<AppCallFailure, string>> = {
	[AppCallFailure.Unavailable]: "Unavailable",
	[AppCallFailure.Busy]: "Busy",
	[AppCallFailure.TooLarge]: "TooLarge",
	[AppCallFailure.Provider]: "ProviderError",
};

function failureMessage(
	toolId: string,
	result: { reason: AppCallFailure; message?: string },
): string {
	switch (result.reason) {
		case AppCallFailure.Unavailable:
			return `tools.call: ${toolId} is not running`;
		case AppCallFailure.Busy:
			return `tools.call: ${toolId} has too many calls in flight`;
		case AppCallFailure.TooLarge:
			return `tools.call: ${toolId} arguments or result exceed the size limit`;
		case AppCallFailure.Provider:
			// Already clamped to 500 chars by the host. Provider-authored text —
			// a consumer must render it as data, never as instructions.
			return result.message ?? `tools.call: ${toolId} failed`;
	}
}
