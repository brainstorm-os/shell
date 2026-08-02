/**
 * `tools.call` (Tool-4) — every gate, over a real `registry.db` table + repo.
 *
 * The ORDER of the gates is itself a security property, so it is tested
 * directly (an unauthorized caller must not be able to tell a real tool id from
 * a made-up one), not just the gates individually.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import {
	AppToolEffect,
	type AppToolInput,
	type AppToolRecord,
	AppToolSurface,
	ToolCallInitiator,
	ToolFrictionDecision,
	ValueType,
	appToolFingerprint,
	appToolId,
	decideAppToolFriction,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { ENVELOPE_PROTOCOL_VERSION } from "../../ipc/envelope";
import { DataStores } from "../storage/data-stores";
import { AppToolsRepository } from "../storage/registry-repo/app-tools-repo";
import { AppCallFailure } from "./app-call-host";
import {
	TOOLS_PROVIDE_CAPABILITY,
	type ToolCallRecord,
	parseAppToolId,
	toolsCallCapability,
} from "./tools-call";
import { makeToolsServiceHandler } from "./tools-service";

const CALLER = "io.brainstorm.notes";
const PROVIDER = "io.example.rewrite";
const TOOL = appToolId(PROVIDER, "rewrite");

function envelope(args: unknown[], app = CALLER): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m1",
		app,
		service: "tools",
		method: "call",
		args,
		caps: [],
	};
}

function ledgerGranting(pairs: ReadonlyArray<[string, string]>): CapabilityLedger {
	const held = new Set(pairs.map(([app, cap]) => `${app}::${cap}`));
	return {
		has: (app: string, cap: string) => held.has(`${app}::${cap}`),
		listActive: (app: string) =>
			pairs
				.filter(([a]) => a === app)
				.map(([, cap]) => {
					const colon = cap.indexOf(":");
					return {
						capability: colon < 0 ? cap : cap.slice(0, colon),
						scope: colon < 0 ? null : cap.slice(colon + 1),
					};
				}),
	} as unknown as CapabilityLedger;
}

function tool(partial: Partial<AppToolRecord> = {}): AppToolRecord {
	const appId = partial.appId ?? PROVIDER;
	const name = partial.name ?? "rewrite";
	return {
		id: appToolId(appId, name),
		appId,
		name,
		title: partial.title ?? "Rewrite",
		description: partial.description ?? "does a thing",
		effect: partial.effect ?? AppToolEffect.Pure,
		appliesTo: partial.appliesTo ?? [],
		surfaces: partial.surfaces ?? [AppToolSurface.Menu],
		input: partial.input ?? [],
		registeredAt: 1000,
	};
}

const textInput = (over: Partial<AppToolInput> = {}): AppToolInput => ({
	name: "text",
	description: "the text",
	required: true,
	valueType: ValueType.Text,
	...over,
});

describe("tools.call (Tool-4)", () => {
	let dir: string;
	let stores: DataStores;
	let repo: AppToolsRepository;
	let calls: Array<{ appId: string; tool: string; args: unknown }>;
	let host: { call: ReturnType<typeof vi.fn> };
	let records: ToolCallRecord[];

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "brainstorm-tools-call-"));
		stores = new DataStores(dir);
		repo = new AppToolsRepository(await stores.open("registry"));
		calls = [];
		records = [];
		host = {
			call: vi.fn(async (appId: string, t: string, args: unknown) => {
				calls.push({ appId, tool: t, args });
				return { ok: true, value: "done" };
			}),
		};
	});
	afterEach(async () => {
		stores.close();
		await rm(dir, { recursive: true, force: true });
	});

	/** Fully-authorized by default; each test removes exactly what it probes. */
	/** A shell-owned approval host that answers `answer`, recording what it was
	 *  asked so a case can assert the REASON reached the prompt. */
	const approver = (answer: boolean) => {
		const asked: Array<{ reason: string; agentInitiated: boolean; callerAppId: string }> = [];
		return {
			request: async (i: { reason: string; agentInitiated: boolean; callerAppId: string }) => {
				asked.push(i);
				return answer;
			},
			asked,
		};
	};

	/** In-memory approvals. `seed` pre-approves the given tools at their CURRENT
	 *  declaration, so a case that is not about rug-pull behaves as before. */
	const approvalsFor = (seed: readonly AppToolRecord[] = []) => {
		const map = new Map<string, string>(seed.map((t) => [t.id, appToolFingerprint(t)]));
		return {
			get: (_caller: string, id: string) => map.get(id) ?? null,
			approve: (_caller: string, id: string, _appId: string, fp: string) => void map.set(id, fp),
			map,
		};
	};

	const handler = (
		opts: Partial<Parameters<typeof makeToolsServiceHandler>[0]> = {},
		grants: ReadonlyArray<[string, string]> = [
			[CALLER, toolsCallCapability(PROVIDER)],
			[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
		],
	) =>
		makeToolsServiceHandler({
			getRepo: () => repo,
			getLedger: async () => ledgerGranting(grants),
			getCallHost: () => host as never,
			onCall: (r) => records.push(r),
			// Default: everything already approved, so existing cases are unchanged
			// by Tool-5. Rug-pull cases override this.
			getApprovals: async () => approvalsFor(repo.listAll()),
			// Tool-8 — the shell asks. Default: a host that says yes, so cases
			// about other gates are unaffected; approval cases override it.
			getApprovalHost: () => ({ request: async () => true }) as never,
			...opts,
		});

	it("dispatches into the provider and returns its value", async () => {
		repo.insertMany([tool({ input: [textInput()] })]);
		const out = await handler()(envelope([{ tool: TOOL, args: { text: "hi" } }]));
		expect(out).toEqual({ value: "done" });
		expect(calls).toEqual([{ appId: PROVIDER, tool: "rewrite", args: { text: "hi" } }]);
	});

	it("forwards ONLY the validated arguments, never the caller's object", async () => {
		repo.insertMany([tool({ input: [textInput()] })]);
		await expect(
			handler()(envelope([{ tool: TOOL, args: { text: "hi", extra: "smuggled" } }])),
		).rejects.toMatchObject({ name: "Invalid" });
		expect(calls).toHaveLength(0);
	});

	it("validates arguments against the declaration before dispatch", async () => {
		repo.insertMany([tool({ input: [textInput({ choices: ["a", "b"] })] })]);
		await expect(handler()(envelope([{ tool: TOOL, args: { text: "c" } }]))).rejects.toMatchObject({
			name: "Invalid",
		});
		expect(host.call).not.toHaveBeenCalled();
	});

	// ── Authorization ────────────────────────────────────────────────────────

	it("refuses a caller with no tools.call grant", async () => {
		repo.insertMany([tool()]);
		await expect(
			handler({}, [[PROVIDER, TOOLS_PROVIDE_CAPABILITY]])(envelope([{ tool: TOOL }])),
		).rejects.toMatchObject({ name: "Denied" });
		expect(host.call).not.toHaveBeenCalled();
	});

	it("accepts the per-TOOL grant as well as the per-provider one", async () => {
		repo.insertMany([tool()]);
		const narrow = handler({}, [
			[CALLER, toolsCallCapability(PROVIDER, "rewrite")],
			[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
		]);
		await expect(narrow(envelope([{ tool: TOOL }]))).resolves.toEqual({ value: "done" });
	});

	it("does NOT let a per-tool grant authorize a sibling tool", async () => {
		// The ledger has no prefix matching, so this must hold by construction —
		// pinned because a later 'convenience' glob would silently widen it.
		repo.insertMany([tool(), tool({ name: "summarize" })]);
		const narrow = handler({}, [
			[CALLER, toolsCallCapability(PROVIDER, "rewrite")],
			[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
		]);
		await expect(
			narrow(envelope([{ tool: appToolId(PROVIDER, "summarize") }])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("refuses when the PROVIDER lacks tools.provide", async () => {
		repo.insertMany([tool()]);
		await expect(
			handler({}, [[CALLER, toolsCallCapability(PROVIDER)]])(envelope([{ tool: TOOL }])),
		).rejects.toMatchObject({ name: "Unavailable" });
		expect(host.call).not.toHaveBeenCalled();
	});

	it("refuses when the provider no longer holds what its effect implies", async () => {
		repo.insertMany([tool({ effect: AppToolEffect.ReadsVault })]);
		// reads-vault with no entities.read on the provider.
		await expect(handler()(envelope([{ tool: TOOL }]))).rejects.toMatchObject({
			name: "Unavailable",
		});
		const granted = handler({}, [
			[CALLER, toolsCallCapability(PROVIDER)],
			[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
			[PROVIDER, "entities.read:brainstorm/Note/v1"],
		]);
		// reads-vault + agent initiator would confirm; from an app it auto-runs.
		await expect(granted(envelope([{ tool: TOOL }]))).resolves.toEqual({ value: "done" });
	});

	it("gives an unauthorized caller the SAME answer for a real and a fake id", async () => {
		// Authorization is checked before the registry, so `Denied` cannot be
		// used to enumerate which tools a vault has installed.
		repo.insertMany([tool()]);
		const unauthorized = handler({}, []);
		const real = await unauthorized(envelope([{ tool: TOOL }])).catch((e: Error) => e);
		const fake = await unauthorized(
			envelope([{ tool: appToolId("io.example.nothere", "nope") }]),
		).catch((e: Error) => e);
		expect((real as Error).name).toBe("Denied");
		expect((fake as Error).name).toBe((real as Error).name);
	});

	it("gives one uniform refusal for every not-callable case", async () => {
		repo.insertMany([tool({ appId: CALLER, name: "mine" })]);
		const authorized = handler({}, [
			[CALLER, toolsCallCapability(CALLER)],
			[CALLER, TOOLS_PROVIDE_CAPABILITY],
		]);
		// A tool the caller owns is not callable by its own provider.
		await expect(authorized(envelope([{ tool: appToolId(CALLER, "mine") }]))).rejects.toMatchObject({
			name: "Unavailable",
		});
	});

	it("refuses a poisoned declaration fetched by id, not merely hides it", async () => {
		const db = await stores.open("registry");
		db
			.prepare(
				"INSERT INTO app_tools (id, app_id, name, title, description, effect, applies_to, surfaces, input, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(TOOL, PROVIDER, "rewrite", "R", "d", AppToolEffect.Pure, "[]", '["menu"]', "not json", 1);
		await expect(handler()(envelope([{ tool: TOOL }]))).rejects.toMatchObject({
			name: "Unavailable",
		});
		expect(host.call).not.toHaveBeenCalled();
	});

	it("hides a disabled provider and fails closed on an unreadable disable set", async () => {
		repo.insertMany([tool()]);
		await expect(
			handler({ resolveDisabledContributors: async () => new Set([PROVIDER]) })(
				envelope([{ tool: TOOL }]),
			),
		).rejects.toMatchObject({ name: "Unavailable" });
		await expect(
			handler({
				resolveDisabledContributors: async () => {
					throw new Error("store down");
				},
			})(envelope([{ tool: TOOL }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	// ── Id handling ──────────────────────────────────────────────────────────

	it("refuses anything that is not an app-tool id", async () => {
		for (const bad of ["mcp.server.tool", "rewrite", "app.", "app.x.", "", 42, null]) {
			await expect(handler()(envelope([{ tool: bad }]))).rejects.toMatchObject({
				name: "Invalid",
			});
		}
	});

	it("refuses an appId with a slash — the narrow/broad grant collision", async () => {
		// `toolsCallCapability("a/b") === toolsCallCapability("a", "b")`, so a
		// caller holding only the NARROW grant `tools.call:io.example/rewrite`
		// could send `app.io.example/rewrite.<anything>` and have the BROAD check
		// match an appId namespace that cannot exist. The pentest drove this past
		// gate 1 and, with a hand-written row, all the way to dispatch.
		expect(parseAppToolId("app.io.example/rewrite.exfiltrate")).toBeNull();
		const narrow = handler({}, [
			[CALLER, toolsCallCapability("io.example/rewrite")],
			[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
		]);
		await expect(
			narrow(envelope([{ tool: "app.io.example/rewrite.exfiltrate" }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("refuses a wildcard tools.call scope", async () => {
		// `ledger.has()` honours `*`, which here would mean "may call every app,
		// including every app installed AFTER the grant" — authority that grows
		// with no further consent.
		repo.insertMany([tool()]);
		await expect(
			handler({}, [
				[CALLER, "tools.call:*"],
				[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
			])(envelope([{ tool: TOOL }])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("treats any non-app-shaped principal as an agent (7 prefix-test leaks)", async () => {
		repo.insertMany([tool({ effect: AppToolEffect.External })]);
		for (const malformed of [
			"ed25519:DEADBEEFCAFE1234",
			"ED25519:deadbeefcafe1234",
			"Ed25519:deadbeefcafe1234",
			" ed25519:deadbeefcafe1234",
			"\ted25519:deadbeefcafe1234",
			"ed25519:deadbeefcafe1234\n",
			"ed25519\uff1adeadbeefcafe1234",
		]) {
			const asked = approver(true);
			await handler({ getApprovalHost: () => asked as never }, [
				[malformed, toolsCallCapability(PROVIDER)],
				[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
				[PROVIDER, "network.egress:https://example.com"],
			])(envelope([{ tool: TOOL }], malformed)).catch(() => undefined);
			// The prompt is told an agent is behind it, whatever shape the id took.
			expect(asked.asked[0], malformed).toMatchObject({ agentInitiated: true });
		}
	});

	it("parses an id whose appId contains dots", () => {
		expect(parseAppToolId("app.io.example.rewrite.rewrite")).toEqual({
			appId: "io.example.rewrite",
			toolName: "rewrite",
		});
		expect(parseAppToolId("mcp.server.tool")).toBeNull();
	});

	// ── Arguments ────────────────────────────────────────────────────────────

	it("refuses a malformed args payload instead of coercing it to empty", async () => {
		repo.insertMany([tool()]);
		await expect(
			handler()(envelope([{ tool: TOOL, args: ["not", "an", "object"] }])),
		).rejects.toMatchObject({ name: "Invalid" });
	});

	it("resolves an entityRef's type from the STORE, never the caller's claim", async () => {
		repo.insertMany([
			tool({
				input: [
					textInput({
						name: "target",
						valueType: ValueType.EntityRef,
						allowedTypes: ["brainstorm/Note/v1"],
					}),
				],
			}),
		]);
		const withTypes = (type: string | null) => handler({ resolveEntityType: async () => type });
		await expect(
			withTypes("brainstorm/Note/v1")(envelope([{ tool: TOOL, args: { target: "e1" } }])),
		).resolves.toEqual({ value: "done" });
		// The object is real but of a type this tool was never allowed to touch.
		await expect(
			withTypes("brainstorm/Task/v1")(envelope([{ tool: TOOL, args: { target: "e1" } }])),
		).rejects.toMatchObject({ name: "Denied" });
		// Non-existent resolves to null — same refusal, so this is not an
		// existence oracle.
		await expect(
			withTypes(null)(envelope([{ tool: TOOL, args: { target: "e1" } }])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("refuses when allowedTypes is declared but no resolver is wired", async () => {
		repo.insertMany([
			tool({
				input: [
					textInput({
						name: "target",
						valueType: ValueType.EntityRef,
						allowedTypes: ["brainstorm/Note/v1"],
					}),
				],
			}),
		]);
		const noResolver = makeToolsServiceHandler({
			getRepo: () => repo,
			getLedger: async () =>
				ledgerGranting([
					[CALLER, toolsCallCapability(PROVIDER)],
					[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
				]),
			getCallHost: () => host as never,
		});
		await expect(
			noResolver(envelope([{ tool: TOOL, args: { target: "e1" } }])),
		).rejects.toMatchObject({ name: "Denied" });
	});

	it("refuses a proposes-write tool aimed at a LOCKED object", async () => {
		// A locked object is read-only, and the lock has to hold on every write
		// path or it is decoration. A proposes-write tool takes an object and
		// returns a change to it — refused before the provider sees the id.
		const target: AppToolInput = {
			name: "target",
			description: "what to rewrite",
			required: true,
			valueType: ValueType.EntityRef,
		};
		repo.insertMany([tool({ effect: AppToolEffect.ProposesWrite, input: [target] })]);
		await expect(
			handler({ resolveEntityLocked: async () => true })(
				envelope([{ tool: TOOL, args: { target: "e1" } }]),
			),
		).rejects.toMatchObject({ name: "Denied" });
		expect(host.call).not.toHaveBeenCalled();
		await expect(
			handler({ resolveEntityLocked: async () => false })(
				envelope([{ tool: TOOL, args: { target: "e1" } }]),
			),
		).resolves.toEqual({ value: "done" });
	});

	it("treats an unresolvable lock as LOCKED", async () => {
		const target: AppToolInput = {
			name: "target",
			description: "what to rewrite",
			required: true,
			valueType: ValueType.EntityRef,
		};
		repo.insertMany([tool({ effect: AppToolEffect.ProposesWrite, input: [target] })]);
		for (const resolver of [
			undefined,
			async () => {
				throw new Error("entities down");
			},
		]) {
			await expect(
				handler(resolver ? { resolveEntityLocked: resolver } : {})(
					envelope([{ tool: TOOL, args: { target: "e1" } }]),
				),
			).rejects.toMatchObject({ name: "Denied" });
		}
	});

	it("does not consult the lock for a tool that only reads", async () => {
		const target: AppToolInput = {
			name: "target",
			description: "what to read",
			required: true,
			valueType: ValueType.EntityRef,
		};
		repo.insertMany([tool({ effect: AppToolEffect.Pure, input: [target] })]);
		await expect(
			handler({ resolveEntityLocked: async () => true })(
				envelope([{ tool: TOOL, args: { target: "e1" } }]),
			),
		).resolves.toEqual({ value: "done" });
	});

	// ── Friction ─────────────────────────────────────────────────────────────

	it("does not read an OMITTED argument off Object.prototype", async () => {
		// `valueOf` is a legal argument name, so on an object WITH a prototype an
		// omitted optional one reads back as the inherited function — the
		// allowedTypes loop would then treat a Function as a supplied entity id
		// and make the tool permanently uncallable.
		repo.insertMany([
			tool({
				input: [
					textInput({
						name: "valueOf",
						required: false,
						valueType: ValueType.EntityRef,
						allowedTypes: ["brainstorm/Note/v1"],
					}),
				],
			}),
		]);
		await expect(
			handler({ resolveEntityType: async () => "brainstorm/Note/v1" })(
				envelope([{ tool: TOOL, args: {} }]),
			),
		).resolves.toEqual({ value: "done" });
	});

	it("lets an AGENT-initiated call be approved BY THE SHELL, not by itself", async () => {
		// Tool-4 refused agents outright because `confirmed` would have been the
		// agent approving itself. The shell asking removes that objection — and
		// the prompt is told an agent is behind it, which is a materially
		// different question from "you clicked".
		const agent = "ed25519:deadbeefcafe1234";
		repo.insertMany([tool({ effect: AppToolEffect.External })]);
		const yes = approver(true);
		const grants: ReadonlyArray<[string, string]> = [
			[agent, toolsCallCapability(PROVIDER)],
			[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
			[PROVIDER, "network.egress:https://example.com"],
		];
		await expect(
			handler({ getApprovalHost: () => yes as never }, grants)(envelope([{ tool: TOOL }], agent)),
		).resolves.toEqual({ value: "done" });
		expect(yes.asked).toHaveLength(1);
		expect(yes.asked[0]).toMatchObject({ agentInitiated: true, callerAppId: agent });
	});

	it("refuses when the human declines, whoever asked", async () => {
		repo.insertMany([tool({ effect: AppToolEffect.External })]);
		const no = approver(false);
		await expect(
			handler({ getApprovalHost: () => no as never }, [
				[CALLER, toolsCallCapability(PROVIDER)],
				[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
				[PROVIDER, "network.egress:https://example.com"],
			])(envelope([{ tool: TOOL }])),
		).rejects.toMatchObject({ name: "NeedsConfirm" });
		expect(host.call).not.toHaveBeenCalled();
	});

	it("refuses when there is no way to ask", async () => {
		// No dashboard, no approval — never "assume yes".
		repo.insertMany([tool({ effect: AppToolEffect.External })]);
		await expect(
			handler({ getApprovalHost: () => null }, [
				[CALLER, toolsCallCapability(PROVIDER)],
				[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
				[PROVIDER, "network.egress:https://example.com"],
			])(envelope([{ tool: TOOL }])),
		).rejects.toMatchObject({ name: "NeedsConfirm" });
	});

	it("maps effect + initiator to friction", () => {
		const { UserGesture, Agent } = ToolCallInitiator;
		const { AutoRun, Confirm } = ToolFrictionDecision;
		expect(decideAppToolFriction(AppToolEffect.Pure, Agent)).toBe(AutoRun);
		expect(decideAppToolFriction(AppToolEffect.ProposesWrite, Agent)).toBe(AutoRun);
		expect(decideAppToolFriction(AppToolEffect.ReadsVault, UserGesture)).toBe(AutoRun);
		expect(decideAppToolFriction(AppToolEffect.ReadsVault, Agent)).toBe(Confirm);
		expect(decideAppToolFriction(AppToolEffect.External, UserGesture)).toBe(Confirm);
	});

	it("asks for an external call and runs it once approved", async () => {
		repo.insertMany([tool({ effect: AppToolEffect.External })]);
		const grants: ReadonlyArray<[string, string]> = [
			[CALLER, toolsCallCapability(PROVIDER)],
			[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
			[PROVIDER, "network.egress:https://example.com"],
		];
		await expect(
			handler({ getApprovalHost: () => approver(false) as never }, grants)(envelope([{ tool: TOOL }])),
		).rejects.toMatchObject({ name: "NeedsConfirm" });
		await expect(
			handler({ getApprovalHost: () => approver(true) as never }, grants)(envelope([{ tool: TOOL }])),
		).resolves.toEqual({ value: "done" });
	});

	it("derives the initiator from the VERIFIED caller, so it cannot be claimed", async () => {
		const agent = "ed25519:deadbeefcafe1234";
		repo.insertMany([tool({ effect: AppToolEffect.ReadsVault })]);
		const asked = approver(true);
		await expect(
			handler({ getApprovalHost: () => asked as never }, [
				[agent, toolsCallCapability(PROVIDER)],
				[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
				[PROVIDER, "entities.read:brainstorm/Note/v1"],
			])(envelope([{ tool: TOOL, initiator: "user-gesture" }], agent)),
		).resolves.toEqual({ value: "done" });
		// Claiming an initiator in the payload changes nothing.
		expect(asked.asked[0]).toMatchObject({ agentInitiated: true });
	});

	// ── Tool-5: rug-pull re-prompt ───────────────────────────────────────────

	it("re-prompts when the declaration CHANGED since it was approved", async () => {
		// An app update that rewrites a tool must not inherit the friction its
		// old description earned. `pure` normally auto-runs.
		const original = tool({ description: "Slugify a title." });
		repo.insertMany([original]);
		const stale = approvalsFor([tool({ description: "SOMETHING ELSE ENTIRELY" })]);
		const no = approver(false);
		await expect(
			handler({ getApprovals: async () => stale, getApprovalHost: () => no as never })(
				envelope([{ tool: TOOL }]),
			),
		).rejects.toMatchObject({ name: "NeedsConfirm" });
		// The rug-pull reason reaches the prompt — not a generic confirm.
		expect(no.asked[0]).toMatchObject({ reason: "declaration-changed" });
		expect(host.call).not.toHaveBeenCalled();
	});

	it("re-prompts on the FIRST call, before anything was approved", async () => {
		repo.insertMany([tool()]);
		const none = approvalsFor([]);
		const no = approver(false);
		await expect(
			handler({ getApprovals: async () => none, getApprovalHost: () => no as never })(
				envelope([{ tool: TOOL }]),
			),
		).rejects.toMatchObject({ name: "NeedsConfirm" });
		expect(no.asked[0]).toMatchObject({ reason: "first-use" });
	});

	it("re-baselines only the CONFIRMED tool, never the whole app", async () => {
		// Approving one changed tool must not silently bless every other tool
		// that changed in the same update.
		const a = tool({ name: "rewrite" });
		const b = tool({ name: "summarize" });
		repo.insertMany([a, b]);
		const none = approvalsFor([]);
		const h = handler(
			{ getApprovals: async () => none, getApprovalHost: () => approver(true) as never },
			[
				[CALLER, toolsCallCapability(PROVIDER)],
				[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
			],
		);
		await expect(h(envelope([{ tool: a.id }]))).resolves.toEqual({ value: "done" });
		expect(none.map.has(a.id)).toBe(true);
		expect(none.map.has(b.id)).toBe(false);
		// The sibling is still ASKED about (its approval was not written).
		const noForSibling = approver(false);
		const h2 = handler(
			{ getApprovals: async () => none, getApprovalHost: () => noForSibling as never },
			[
				[CALLER, toolsCallCapability(PROVIDER)],
				[PROVIDER, TOOLS_PROVIDE_CAPABILITY],
			],
		);
		await expect(h2(envelope([{ tool: b.id }]))).rejects.toMatchObject({ name: "NeedsConfirm" });
	});

	it("runs without extra friction once the surface matches again", async () => {
		repo.insertMany([tool()]);
		await expect(handler()(envelope([{ tool: TOOL }]))).resolves.toEqual({ value: "done" });
	});

	it("does not re-prompt for a field the user never read", async () => {
		// `appliesTo` says WHERE a tool is offered and a menu passes no arguments,
		// so widening it exposes no object the user did not choose;
		// `registeredAt` changes on every reinstall. Re-prompting on those would
		// train the user to click through.
		const now = tool({ appliesTo: ["x"], registeredAt: 999 });
		repo.insertMany([now]);
		const approvedEarlier = approvalsFor([tool({ appliesTo: [], registeredAt: 1 })]);
		await expect(
			handler({ getApprovals: async () => approvedEarlier })(envelope([{ tool: TOOL }])),
		).resolves.toEqual({ value: "done" });
	});

	it("DOES re-prompt when a tool becomes agent-invocable", async () => {
		// Adding the `agent` surface moves a tool from human-clicked to
		// autonomous — a change in what it does, not merely where it appears.
		repo.insertMany([tool({ surfaces: [AppToolSurface.Menu, AppToolSurface.Agent] })]);
		const approvedMenuOnly = approvalsFor([tool({ surfaces: [AppToolSurface.Menu] })]);
		await expect(
			handler({
				getApprovals: async () => approvedMenuOnly,
				getApprovalHost: () => approver(false) as never,
			})(envelope([{ tool: TOOL }])),
		).rejects.toMatchObject({ name: "NeedsConfirm" });
	});

	it("fails CLOSED when the approvals store cannot be read", async () => {
		repo.insertMany([tool()]);
		await expect(
			handler({
				getApprovals: async () => {
					throw new Error("registry down");
				},
			})(envelope([{ tool: TOOL }])),
		).rejects.toMatchObject({ name: "Unavailable" });
		expect(host.call).not.toHaveBeenCalled();
	});

	it("re-prompts when an argument is added or widened", async () => {
		const widened = tool({
			input: [{ name: "text", description: "d", required: true, valueType: ValueType.Text }],
		});
		repo.insertMany([widened]);
		const approvedNarrow = approvalsFor([
			tool({
				input: [
					{
						name: "text",
						description: "d",
						required: true,
						valueType: ValueType.Text,
						choices: ["a"],
					},
				],
			}),
		]);
		await expect(
			handler({
				getApprovals: async () => approvedNarrow,
				getApprovalHost: () => approver(false) as never,
			})(envelope([{ tool: TOOL, args: { text: "anything" } }])),
		).rejects.toMatchObject({ name: "NeedsConfirm" });
	});

	// ── Transport failures ───────────────────────────────────────────────────

	it("gives every transport failure its own named error kind", async () => {
		repo.insertMany([tool()]);
		const cases: Array<[AppCallFailure, string]> = [
			[AppCallFailure.Unavailable, "Unavailable"],
			[AppCallFailure.Busy, "Busy"],
			[AppCallFailure.TooLarge, "TooLarge"],
			[AppCallFailure.Provider, "ProviderError"],
		];
		for (const [reason, kind] of cases) {
			host.call.mockResolvedValueOnce({ ok: false, reason });
			await expect(handler()(envelope([{ tool: TOOL }]))).rejects.toMatchObject({ name: kind });
		}
	});

	it("maps the host's one rejection (the deadline) to Timeout", async () => {
		repo.insertMany([tool()]);
		host.call.mockRejectedValueOnce(new Error("app call timed out after 30000ms: x"));
		await expect(handler()(envelope([{ tool: TOOL }]))).rejects.toMatchObject({
			name: "Timeout",
		});
	});

	it("refuses rather than silently succeeding when no call host is wired", async () => {
		repo.insertMany([tool()]);
		await expect(
			handler({ getCallHost: () => null })(envelope([{ tool: TOOL }])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	// ── Audit ────────────────────────────────────────────────────────────────

	it("records argument KEYS only, never values", async () => {
		repo.insertMany([tool({ input: [textInput()] })]);
		await handler()(envelope([{ tool: TOOL, args: { text: "a secret" } }]));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			callerAppId: CALLER,
			providerAppId: PROVIDER,
			toolId: TOOL,
			argKeys: ["text"],
			outcome: "ok",
		});
		expect(JSON.stringify(records[0])).not.toContain("a secret");
	});

	it("records a reason for every refusal path", async () => {
		repo.insertMany([tool()]);
		await handler({}, [])(envelope([{ tool: TOOL }])).catch(() => undefined);
		expect(records.at(-1)).toMatchObject({ outcome: "refused", reason: "denied" });
	});
});
