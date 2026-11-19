/**
 * END-TO-END app-tools pipeline (Tool-10, doc 78) — the first LIVE provider
 * and consumer, exercised the way the running product does it.
 *
 * `tools-call.test.ts` proves each gate against hand-built records and a fake
 * ledger. This proves the PAIR that actually ships, in-process:
 *
 *   the real `apps/tasks` + `apps/notes` manifests
 *     → real `AppInstaller` → real `CapabilityLedger` + real `registry.db`
 *     → real `Broker` (production-equivalent capability check)
 *     → real `tools` service, with production's own entity resolvers
 *     → real `ToolApprovalHost` (a stand-in dashboard answers the prompt)
 *     → real `AppCallHost` (a stand-in Tasks renderer answers the call)
 *     → Tasks' REAL `create-task` handler
 *     → back through the Broker as Tasks → real `entities` service → entities.db
 *
 * The only stand-ins are the two renderers, and each is the thinnest thing
 * that can sit on its wire: one calls the shipped handler, the other clicks.
 * If Notes' menu row would be dead, refuse, or write the wrong thing in the
 * product, it fails here first.
 */

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AgentCapabilityRefusedError,
	CapabilityLedger,
	GrantedVia,
} from "@brainstorm-os/capabilities/ledger";
import {
	AppToolApprovalState,
	AppToolEffect,
	type AppToolRecord,
	AppToolSurface,
	appToolFingerprint,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CREATE_TASK_TOOL,
	type CreateTaskToolDeps,
	runCreateTaskTool,
} from "../../../../../apps/tasks/src/tools/create-task-tool";
import { Broker } from "../../ipc/broker";
import { makeEnvelope } from "../../ipc/envelope";
import { __ydocCacheResetForTest, handleYDocEnvelope } from "../../workers/ydoc";
import { AppInstaller } from "../apps/installer";
import { generateSymmetricKey } from "../credentials/crypto";
import { makeEntitiesServiceHandler } from "../entities/entities-service";
import { EntityDekStore } from "../entities/entity-dek-store";
import { DataStores } from "../storage/data-stores";
import { EntitiesRepository, EntityDeksRepository } from "../storage/entities-repo";
import { AppToolApprovalsRepository } from "../storage/registry-repo/app-tool-approvals-repo";
import { AppToolsRepository } from "../storage/registry-repo/app-tools-repo";
import { AppCallHost, type AppCallRequest, TOOLS_CALL_CHANNEL } from "../tools/app-call-host";
import {
	TOOL_APPROVAL_PROMPT_CHANNEL,
	ToolApprovalHost,
	ToolApprovalReason,
	type ToolApprovalRequest,
} from "../tools/tool-approval-host";
import { makeToolEntityResolvers } from "../tools/tool-entity-resolvers";
import type { ToolCallRecord } from "../tools/tools-call";
import { makeToolsServiceHandler } from "../tools/tools-service";

const APPS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../../apps");
const NOTES = "io.brainstorm.notes";
const TASKS = "io.brainstorm.tasks";
const NOTE_TYPE = "io.brainstorm.notes/Note/v1";
const TASK_TYPE = "brainstorm/Task/v1";
const TOOL_ID = `app.${TASKS}.${CREATE_TASK_TOOL}`;
const NOTES_GRANT = `tools.call:${TASKS}/${CREATE_TASK_TOOL}`;

/** Stage a first-party app's REAL manifest as an installable bundle. */
async function stageBundle(root: string, dir: string): Promise<string> {
	const bundle = join(root, dir);
	await mkdir(join(bundle, "dist"), { recursive: true });
	await writeFile(join(bundle, "dist", "index.html"), "<!doctype html>", "utf8");
	await cp(join(APPS_DIR, dir, "manifest.json"), join(bundle, "manifest.json"));
	const manifest = JSON.parse(await readFile(join(bundle, "manifest.json"), "utf8")) as {
		icon?: string;
	};
	if (manifest.icon) {
		await cp(join(APPS_DIR, dir, manifest.icon), join(bundle, manifest.icon)).catch(() =>
			writeFile(join(bundle, manifest.icon as string), "<svg/>", "utf8"),
		);
	}
	return bundle;
}

type Reply = Awaited<ReturnType<Broker["dispatch"]>>;

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "bs-tools-pipeline-"));
	const sourceDir = await mkdtemp(join(tmpdir(), "bs-tools-pipeline-src-"));
	const stores = new DataStores(vaultDir);
	const ledger = new CapabilityLedger(await stores.open("ledger"));
	const registry = await stores.open("registry");
	const installer = new AppInstaller(vaultDir, registry, ledger);
	for (const dir of ["tasks", "notes"]) {
		const result = await installer.install({ bundleDir: await stageBundle(sourceDir, dir) });
		if (!result.ok) throw new Error(`install ${dir}: ${JSON.stringify(result)}`);
	}

	const entities = new EntitiesRepository(await stores.open("entities"));
	const now = Date.now();
	const seed = (id: string, type: string, properties: Record<string, unknown>, by: string) =>
		entities.create({ id, type, createdBy: by, properties, dekId: null, now });
	seed("n1", NOTE_TYPE, { title: "Plan the offsite" }, NOTES);
	seed("n-locked", NOTE_TYPE, { title: "Frozen minutes", locked: true }, NOTES);
	seed("t-existing", TASK_TYPE, { name: "An existing task" }, TASKS);
	seed("x-secret", "io.example/Secret/v1", { title: "Payroll" }, "io.example.hr");

	const broker = new Broker({
		services: new Map(),
		verifyAppIdentity: () => true,
		// Production-equivalent (`broker-context.ts`): every declared cap must be
		// a live ledger grant for the app.
		checkCapability: (app, _s, _m, caps) => caps.every((c) => ledger.has(app, c)),
	});

	const dekStore = new EntityDekStore(
		new EntityDeksRepository(await stores.open("entities")),
		generateSymmetricKey(),
	);
	let minted = 0;
	broker.registerService(
		"entities",
		makeEntitiesServiceHandler({
			getRepo: async () => entities,
			getLedger: async () => ledger,
			getDekStore: async () => dekStore,
			newId: () => `ent_${++minted}`,
			getVaultPath: () => vaultDir,
			ydoc: async (method, a) => {
				const reply = await handleYDocEnvelope({
					v: 1,
					msg: "y",
					app: "io.brainstorm.shell",
					service: "ydoc",
					method,
					args: [a],
					caps: [],
				});
				if (!reply.ok) throw new Error(`ydoc.${method} failed: ${reply.error.message}`);
				return reply.value;
			},
		}),
	);

	const send = (app: string, service: string, method: string, args: unknown[], caps: string[]) =>
		broker.dispatch(makeEnvelope({ msg: "m", app, service, method, args, caps }), "renderer");

	// ── The stand-in dashboard: records every prompt, answers as told. ───────
	const approvalHost = new ToolApprovalHost();
	const prompts: ToolApprovalRequest[] = [];
	const dashboard = { answer: true };
	approvalHost.setDashboard({
		send: (channel, request) => {
			expect(channel).toBe(TOOL_APPROVAL_PROMPT_CHANNEL);
			prompts.push(request);
			queueMicrotask(() =>
				approvalHost.handleReply({ requestId: request.requestId, accept: dashboard.answer }),
			);
		},
	});

	// ── The stand-in Tasks renderer: runs the SHIPPED handler, and reaches the
	// vault only the way the real app can — through the broker, as Tasks. ────
	const callHost = new AppCallHost();
	const providerCalls: AppCallRequest[] = [];
	const provider: { fail: string | null } = { fail: null };
	let taskSeq = 0;
	const tasksDeps: CreateTaskToolDeps = {
		getEntity: async (id) => {
			const reply = await send(TASKS, "entities", "get", [{ id }], []);
			if (!reply.ok) throw new Error(reply.error.message);
			return reply.value as { type: string; properties: Record<string, unknown> } | null;
		},
		createTask: async (task) => {
			const { id, ...properties } = task;
			const reply = await send(
				TASKS,
				"entities",
				"create",
				[{ type: TASK_TYPE, properties, id }],
				[`entities.write:${TASK_TYPE}`],
			);
			if (!reply.ok) throw new Error(reply.error.message);
		},
		newId: () => `task-made-${++taskSeq}`,
		now: () => now,
		untitledName: () => "Untitled task",
		describeSource: (title) => `From “${title}”`,
	};
	const attachTasks = () =>
		callHost.attachApp(TASKS, 1, {
			send: (channel: string, request: AppCallRequest) => {
				expect(channel).toBe(TOOLS_CALL_CHANNEL);
				providerCalls.push(request);
				void (async () => {
					try {
						if (provider.fail !== null) throw new Error(provider.fail);
						if (request.tool !== CREATE_TASK_TOOL) throw new Error("no handler");
						const value = await runCreateTaskTool(request.args, tasksDeps);
						callHost.handleResult(TASKS, { callId: request.callId, ok: true, value });
					} catch (error) {
						callHost.handleResult(TASKS, {
							callId: request.callId,
							ok: false,
							error: (error as Error).message.slice(0, 500),
						});
					}
				})();
			},
		} as never);
	attachTasks();

	const audit: ToolCallRecord[] = [];
	const toolsRepo = new AppToolsRepository(registry);
	const approvals = new AppToolApprovalsRepository(registry);
	broker.registerService(
		"tools",
		makeToolsServiceHandler({
			getRepo: () => toolsRepo,
			getLedger: async () => ledger,
			getCallHost: () => callHost,
			getApprovalHost: () => approvalHost,
			getApprovals: async () => approvals,
			resolveAppLabel: (appId) => (appId === TASKS ? "Tasks" : undefined),
			resolveDisabledContributors: async () => new Set<string>(),
			// The SAME closures `main/index.ts` wires.
			...makeToolEntityResolvers(async () => entities),
			onCall: (record) => audit.push(record),
		}),
	);

	const listAsNotes = async (): Promise<AppToolRecord[]> => {
		const reply = await send(
			NOTES,
			"tools",
			"list",
			[{ appliesTo: NOTE_TYPE, surface: AppToolSurface.Menu }],
			["tools.read"],
		);
		if (!reply.ok) throw new Error(`tools.list refused: ${reply.error.kind}`);
		return reply.value as AppToolRecord[];
	};
	/** The envelope `appToolsProxy.call` builds: no declared caps, the handler
	 *  re-checks the ledger itself. */
	const callTool = (app: string, input: unknown): Promise<Reply> =>
		send(app, "tools", "call", [input], []);
	const tasksInVault = () =>
		entities
			.query({ type: TASK_TYPE })
			.filter((row) => row.id !== "t-existing")
			.map((row) => ({ id: row.id, createdBy: row.createdBy, ...row.properties }));

	return {
		vaultDir,
		sourceDir,
		stores,
		ledger,
		entities,
		toolsRepo,
		approvals,
		callHost,
		approvalHost,
		attachTasks,
		prompts,
		dashboard,
		provider,
		providerCalls,
		audit,
		listAsNotes,
		callTool,
		tasksInVault,
		send,
	};
}

function refusal(reply: Reply): { kind: string; message: string } {
	if (reply.ok) throw new Error("expected a refusal, got a result");
	return { kind: reply.error.kind, message: reply.error.message };
}

describe("app-tools pipeline — Tasks provides, Notes consumes (Tool-10)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		__ydocCacheResetForTest();
		env = await setup();
	});
	afterEach(async () => {
		__ydocCacheResetForTest();
		env.callHost.dispose();
		env.stores.close();
		for (const dir of [env.vaultDir, env.sourceDir]) {
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
		}
	});

	it("the real manifests install one tool and the narrowest grants that work", () => {
		const tool = env.toolsRepo.get(TOOL_ID);
		expect(tool).toMatchObject({
			id: TOOL_ID,
			appId: TASKS,
			name: CREATE_TASK_TOOL,
			effect: AppToolEffect.WritesVault,
			appliesTo: [NOTE_TYPE],
			surfaces: [AppToolSurface.Menu],
		});
		expect(tool?.declarationInvalid).toBeUndefined();
		expect(env.toolsRepo.listAll().map((t) => t.id)).toEqual([TOOL_ID]);

		const grantsOf = (app: string) =>
			env.ledger
				.listActive(app)
				.filter((g) => g.capability.startsWith("tools."))
				.map((g) => (g.scope === null ? g.capability : `${g.capability}:${g.scope}`))
				.sort();
		expect(grantsOf(TASKS)).toEqual(["tools.provide"]);
		expect(grantsOf(NOTES)).toEqual([NOTES_GRANT, "tools.read"]);
		// No whole-provider grant, and nothing that grows with later installs.
		expect(env.ledger.has(NOTES, `tools.call:${TASKS}`)).toBe(false);
	});

	it("lists the tool to Notes for a note — and only while Tasks is running", async () => {
		const listed = await env.listAsNotes();
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			id: TOOL_ID,
			title: "Create task",
			appLabel: "Tasks",
			approval: AppToolApprovalState.New,
		});

		env.callHost.detachApp(TASKS, 1);
		expect(await env.listAsNotes()).toEqual([]);
		env.attachTasks();
		expect(await env.listAsNotes()).toHaveLength(1);

		// Not offered for another type, and never back to its own provider.
		const forTask = await env.send(
			NOTES,
			"tools",
			"list",
			[{ appliesTo: TASK_TYPE, surface: AppToolSurface.Menu }],
			["tools.read"],
		);
		expect(forTask.ok && forTask.value).toEqual([]);
		const toSelf = await env.send(TASKS, "tools", "list", [{}], ["tools.read"]);
		expect(toSelf.ok).toBe(false);
	});

	it("END TO END: Notes calls → the shell asks → approved → the task lands in the vault", async () => {
		const reply = await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n1" } });
		if (!reply.ok) throw new Error(`refused: ${reply.error.kind} ${reply.error.message}`);
		expect(reply.value).toEqual({ value: { taskId: "task-made-1", name: "Plan the offsite" } });

		// The SHELL asked, once, about a first use — as a human's click, not an agent's.
		expect(env.prompts).toHaveLength(1);
		expect(env.prompts[0]).toMatchObject({
			callerAppId: NOTES,
			toolId: TOOL_ID,
			toolTitle: "Create task",
			providerAppId: TASKS,
			providerLabel: "Tasks",
			effect: AppToolEffect.WritesVault,
			reason: ToolApprovalReason.FirstUse,
			agentInitiated: false,
		});

		// The provider saw exactly the validated bag.
		expect(env.providerCalls).toHaveLength(1);
		expect(env.providerCalls[0]?.tool).toBe(CREATE_TASK_TOOL);
		expect(env.providerCalls[0]?.args).toEqual({ source: "n1" });

		// The write is real, is Tasks' own, and did not touch the note.
		expect(env.tasksInVault()).toEqual([
			expect.objectContaining({
				id: "task-made-1",
				createdBy: TASKS,
				name: "Plan the offsite",
				notes: "From “Plan the offsite”",
				completedAt: null,
			}),
		]);
		expect(env.entities.get("n1")?.properties).toEqual({ title: "Plan the offsite" });

		// The approval is recorded for THIS caller and THIS declaration only.
		const tool = env.toolsRepo.get(TOOL_ID) as AppToolRecord;
		expect(env.approvals.get(NOTES, TOOL_ID)).toBe(appToolFingerprint(tool));
		expect(env.approvals.get("io.brainstorm.database", TOOL_ID)).toBeNull();
		expect((await env.listAsNotes())[0]?.approval).toBe(AppToolApprovalState.Approved);
		expect(env.audit.at(-1)).toMatchObject({
			callerAppId: NOTES,
			providerAppId: TASKS,
			argKeys: ["source"],
			outcome: "ok",
		});

		// A second click does not ask again, and makes a second task.
		const again = await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n1" } });
		expect(again.ok).toBe(true);
		expect(env.prompts).toHaveLength(1);
		expect(
			env
				.tasksInVault()
				.map((t) => t.id)
				.sort(),
		).toEqual(["task-made-1", "task-made-2"]);
	});

	it("a DECLINED approval writes nothing, records nothing, and asks again next time", async () => {
		env.dashboard.answer = false;
		const reply = await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n1" } });
		expect(refusal(reply).kind).toBe("NeedsConfirm");
		expect(env.providerCalls).toEqual([]);
		expect(env.tasksInVault()).toEqual([]);
		expect(env.approvals.get(NOTES, TOOL_ID)).toBeNull();

		// A caller-asserted `confirmed: true` buys nothing — the shell asks again.
		const forged = await env.callTool(NOTES, {
			tool: TOOL_ID,
			args: { source: "n1" },
			confirmed: true,
		});
		expect(refusal(forged).kind).toBe("NeedsConfirm");
		expect(env.prompts).toHaveLength(2);
		expect(env.tasksInVault()).toEqual([]);
	});

	it("no dashboard to ask ⇒ refused, never assumed", async () => {
		env.approvalHost.setDashboard(null);
		const reply = await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n1" } });
		expect(refusal(reply).kind).toBe("NeedsConfirm");
		expect(env.providerCalls).toEqual([]);
		expect(env.tasksInVault()).toEqual([]);
	});

	it("a LOCKED note is refused before the provider sees it — approved or not", async () => {
		// Approve first, so the refusal below is the lock's and not a prompt's.
		expect((await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n1" } })).ok).toBe(true);
		const before = env.providerCalls.length;

		const reply = await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n-locked" } });
		expect(refusal(reply).kind).toBe("Denied");
		expect(env.providerCalls).toHaveLength(before);
		expect(env.tasksInVault()).toHaveLength(1);
		expect(env.audit.at(-1)).toMatchObject({ outcome: "refused", reason: "locked-object" });
		expect(env.entities.get("n-locked")?.properties).toEqual({
			title: "Frozen minutes",
			locked: true,
		});
	});

	it("the source's type is resolved from the store — and a wrong type reads like a missing one", async () => {
		const answers: string[] = [];
		for (const source of ["t-existing", "x-secret", "no-such-entity"]) {
			const reply = await env.callTool(NOTES, { tool: TOOL_ID, args: { source } });
			const { kind, message } = refusal(reply);
			expect(kind).toBe("Denied");
			answers.push(message);
		}
		// One message for all three: no existence or type oracle over the vault.
		expect(new Set(answers).size).toBe(1);
		expect(answers[0]).not.toContain("Payroll");
		expect(env.providerCalls).toEqual([]);
		expect(env.prompts).toEqual([]);
		expect(env.tasksInVault()).toEqual([]);
	});

	it("the argument that is CHECKED is the argument that is FORWARDED", async () => {
		// A bag that answers differently each time it is read: a note for the
		// validator, anything else afterwards. In-process callers (the agent
		// loop) can build one; a renderer cannot, but the gate must not care.
		let reads = 0;
		const shifting = {
			get source() {
				reads += 1;
				return reads === 1 ? "n1" : "x-secret";
			},
		};
		const reply = await env.callTool(NOTES, { tool: TOOL_ID, args: shifting });
		expect(reply.ok).toBe(true);
		// Read ONCE, at the snapshot: the validator, the type check, the lock
		// check and the dispatch all saw that one value.
		expect(reads).toBe(1);
		expect(env.providerCalls).toHaveLength(1);
		expect(env.providerCalls[0]?.args).toEqual({ source: "n1" });
		expect(env.tasksInVault().map((t) => (t as { name?: string }).name)).toEqual([
			"Plan the offsite",
		]);
	});

	it.each([
		["an undeclared key", { source: "n1", title: "Injected" }],
		["a missing source", {}],
		["a list where one id is declared", { source: ["n1", "n-locked"] }],
		["a non-string id", { source: 7 }],
		["a null id", { source: null }],
	])("refuses %s as Invalid without reaching the provider", async (_label, args) => {
		const reply = await env.callTool(NOTES, { tool: TOOL_ID, args });
		expect(refusal(reply).kind).toBe("Invalid");
		expect(env.providerCalls).toEqual([]);
		expect(env.tasksInVault()).toEqual([]);
	});

	it("an app without the grant is Denied — identically for a real and a made-up tool", async () => {
		const OTHER = "io.brainstorm.database";
		const real = refusal(await env.callTool(OTHER, { tool: TOOL_ID, args: { source: "n1" } }));
		const fake = refusal(
			await env.callTool(OTHER, { tool: `app.${TASKS}.no-such-tool`, args: { source: "n1" } }),
		);
		expect(real.kind).toBe("Denied");
		expect(fake.kind).toBe("Denied");
		// Notes' per-tool grant does not stretch to a sibling tool name either.
		const sibling = refusal(
			await env.callTool(NOTES, { tool: `app.${TASKS}.delete-task`, args: { source: "n1" } }),
		);
		expect(sibling.kind).toBe("Denied");
		expect(env.providerCalls).toEqual([]);
		expect(env.prompts).toEqual([]);
	});

	it("an agent principal cannot be handed the grant, nor ride the app wire", () => {
		const AGENT = "ed25519:0123456789abcdef0123456789abcdef";
		expect(() =>
			env.ledger.grant({
				appId: AGENT,
				capability: "tools.call",
				scope: `${TASKS}/${CREATE_TASK_TOOL}`,
				grantedVia: GrantedVia.Install,
			}),
		).toThrow(AgentCapabilityRefusedError);
		// An agent is not a renderer: the app wire refuses its principal outright,
		// so the only way in is the in-process agent path — whose friction
		// (`writes-vault` + agent ⇒ the shell asks EVERY time, and a caller's
		// `confirmed` is ignored) is pinned in `tools-call.test.ts`.
		expect(() => env.callTool(AGENT, { tool: TOOL_ID, args: { source: "n1" } })).toThrow(
			/app identifier/,
		);
		expect(env.prompts).toEqual([]);
		expect(env.tasksInVault()).toEqual([]);
	});

	it("revoking `tools.provide` stops Tasks answering and un-lists the tool", async () => {
		expect(env.ledger.revoke(TASKS, "tools.provide")).toBe(true);

		expect(await env.listAsNotes()).toEqual([]);
		const reply = await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n1" } });
		expect(refusal(reply).kind).toBe("Unavailable");
		expect(env.providerCalls).toEqual([]);
		expect(env.prompts).toEqual([]);
	});

	it("Tasks closed ⇒ a named Unavailable refusal, not a hang", async () => {
		expect((await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n1" } })).ok).toBe(true);
		env.callHost.detachApp(TASKS, 1);
		const reply = await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n1" } });
		expect(refusal(reply).kind).toBe("Unavailable");
		expect(env.tasksInVault()).toHaveLength(1);
	});

	it("a provider failure is a named ProviderError and is not recorded as an approval", async () => {
		env.provider.fail = "boom";
		const reply = await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n1" } });
		expect(refusal(reply).kind).toBe("ProviderError");
		expect(env.tasksInVault()).toEqual([]);
		// Approved by the human, but the call never worked — so nothing is
		// baselined and the next attempt asks again.
		expect(env.approvals.get(NOTES, TOOL_ID)).toBeNull();
	});

	it("Tasks losing its write grant un-lists the tool; a call then writes nothing", async () => {
		for (const grant of env.ledger.listActive(TASKS)) {
			if (grant.capability === "entities.write") {
				env.ledger.revoke(TASKS, grant.capability, grant.scope);
			}
		}
		expect(await env.listAsNotes()).toEqual([]);
		const reply = await env.callTool(NOTES, { tool: TOOL_ID, args: { source: "n1" } });
		expect(refusal(reply).kind).toBe("Unavailable");
		expect(env.tasksInVault()).toEqual([]);
	});

	it("Tasks cannot call its own tool through the broker", async () => {
		const reply = await env.callTool(TASKS, { tool: TOOL_ID, args: { source: "n1" } });
		expect(reply.ok).toBe(false);
		expect(env.providerCalls).toEqual([]);
	});
});
