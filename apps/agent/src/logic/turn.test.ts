/**
 * Agent-11b — the propose-not-persist security invariant, at the turn seam.
 * A `propose-*` tool call must STAGE a draft and NEVER reach `intents.dispatch`
 * (and therefore never `entities.create`). This is the prompt-injection
 * mitigation: model output can only ever queue a draft for the user's approval.
 */

import {
	type AgentToolCall,
	GENERIC_OBJECT_TYPE,
	type IntentsService,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { ProposedArtifact } from "./propose-artifacts";
import { PROPOSE_DATABASE_VERB } from "./propose-database";
import { PROPOSE_ROW_VERB } from "./propose-row";
import { makeDispatchTool } from "./turn";

const openTool = { verb: "open", label: "Open" };
const proposeNote = { verb: "propose-note", label: "Propose a note" };

function fakeIntents(): IntentsService & { dispatch: ReturnType<typeof vi.fn> } {
	return { dispatch: vi.fn(async () => ({ handled: true, value: { ok: true } })) } as never;
}

describe("makeDispatchTool — propose is staged, never dispatched", () => {
	it("stages a propose-note draft and NEVER calls intents.dispatch", async () => {
		const intents = fakeIntents();
		const staged: ProposedArtifact[] = [];
		const dispatch = makeDispatchTool(intents, [openTool, proposeNote], (a) => staged.push(a));

		const ack = (await dispatch({
			tool: "propose-note",
			args: { title: "Weekly review", body: "notes" },
		})) as Record<string, unknown>;

		expect(intents.dispatch).not.toHaveBeenCalled();
		expect(staged).toHaveLength(1);
		expect(staged[0]?.entityType).toBe("io.brainstorm.notes/Note/v1");
		expect(staged[0]?.fields).toEqual({ title: "Weekly review", body: "notes" });
		expect(staged[0]?.id).toMatch(/^proposal-/);
		expect(ack.staged).toBe(true);
		expect(ack.status).toBe("pending-approval");
	});

	it("a propose call that fails validation stages nothing but still acks honestly", async () => {
		const intents = fakeIntents();
		const staged: ProposedArtifact[] = [];
		const dispatch = makeDispatchTool(intents, [proposeNote], (a) => staged.push(a));

		// Missing the required primary (`title`) → rejected, nothing staged.
		const ack = (await dispatch({ tool: "propose-note", args: { body: "orphan" } })) as Record<
			string,
			unknown
		>;

		expect(intents.dispatch).not.toHaveBeenCalled();
		expect(staged).toHaveLength(0);
		expect(ack.staged).toBe(false);
	});

	it("a real (non-propose) tool still dispatches through the intents bus", async () => {
		const intents = fakeIntents();
		const dispatch = makeDispatchTool(intents, [openTool]);

		await dispatch({ tool: "open", args: { entityId: "ent_1" } } satisfies AgentToolCall);

		expect(intents.dispatch).toHaveBeenCalledTimes(1);
		expect(intents.dispatch).toHaveBeenCalledWith({ verb: "open", payload: { entityId: "ent_1" } });
	});

	it("fails closed on a tool name outside the offered set", async () => {
		const dispatch = makeDispatchTool(fakeIntents(), [proposeNote]);
		await expect(dispatch({ tool: "propose-secret", args: {} })).rejects.toThrow(/unknown tool/);
	});
});

describe("makeDispatchTool — database rows (Agent-11d)", () => {
	const proposeRow = { verb: PROPOSE_ROW_VERB, label: "Propose a row" };
	const schema = {
		id: "list_crm",
		name: "Pipeline",
		entityType: GENERIC_OBJECT_TYPE,
		addToMembers: true,
		columns: [
			{ key: "name", label: "Name", valueType: ValueType.Text },
			{ key: "amount", label: "Amount", valueType: ValueType.Number },
		],
	};

	it("stages a row against the named database and NEVER calls intents.dispatch", async () => {
		const intents = fakeIntents();
		const staged: ProposedArtifact[] = [];
		const dispatch = makeDispatchTool(intents, [proposeRow], (a) => staged.push(a), [schema]);

		const ack = (await dispatch({
			tool: PROPOSE_ROW_VERB,
			args: { database: "Pipeline", values: { name: "Globex", amount: "5400" } },
		})) as Record<string, unknown>;

		expect(intents.dispatch).not.toHaveBeenCalled();
		expect(staged).toHaveLength(1);
		expect(staged[0]?.row?.databaseId).toBe("list_crm");
		expect(ack.staged).toBe(true);
		expect(ack.status).toBe("pending-approval");
	});

	it("refuses a row into a database the host did not offer (stages nothing)", async () => {
		const intents = fakeIntents();
		const staged: ProposedArtifact[] = [];
		const dispatch = makeDispatchTool(intents, [proposeRow], (a) => staged.push(a), [schema]);

		const ack = (await dispatch({
			tool: PROPOSE_ROW_VERB,
			args: { database: "Payroll", values: { name: "Globex" } },
		})) as Record<string, unknown>;

		expect(staged).toHaveLength(0);
		expect(intents.dispatch).not.toHaveBeenCalled();
		expect(ack.staged).toBe(false);
		expect(ack.reason).toBe("unknown-database");
	});

	it("refuses every row when the host passed no schemas (fail-closed default)", async () => {
		const dispatch = makeDispatchTool(fakeIntents(), [proposeRow]);
		const ack = (await dispatch({
			tool: PROPOSE_ROW_VERB,
			args: { database: "Pipeline", values: { name: "x" } },
		})) as Record<string, unknown>;
		expect(ack.staged).toBe(false);
	});
});

describe("makeDispatchTool — a proposed new database (Agent-11e)", () => {
	const proposeDatabase = { verb: PROPOSE_DATABASE_VERB, label: "Propose a database" };

	it("stages the schema + seed rows and NEVER calls intents.dispatch", async () => {
		const intents = fakeIntents();
		const staged: ProposedArtifact[] = [];
		const dispatch = makeDispatchTool(intents, [proposeDatabase], (a) => staged.push(a), [], []);

		const ack = (await dispatch({
			tool: PROPOSE_DATABASE_VERB,
			args: {
				name: "Reading list",
				columns: [{ name: "Pages", type: "number" }],
				rows: [{ Name: "Dune", Pages: "412" }],
			},
		})) as Record<string, unknown>;

		expect(intents.dispatch).not.toHaveBeenCalled();
		expect(staged).toHaveLength(1);
		expect(staged[0]?.database?.rowCount).toBe(1);
		expect(ack.staged).toBe(true);
		expect(ack.status).toBe("pending-approval");
		expect(ack.rows).toBe(1);
	});

	it("uniquifies the staged name against the vault's existing collections", async () => {
		const staged: ProposedArtifact[] = [];
		const dispatch = makeDispatchTool(
			fakeIntents(),
			[proposeDatabase],
			(a) => staged.push(a),
			[],
			[{ name: "Pipeline" }],
		);
		await dispatch({ tool: PROPOSE_DATABASE_VERB, args: { name: "Pipeline" } });
		expect(staged[0]?.summary).toBe("Pipeline 2");
	});

	it("refuses an unnamed database (stages nothing)", async () => {
		const staged: ProposedArtifact[] = [];
		const dispatch = makeDispatchTool(fakeIntents(), [proposeDatabase], (a) => staged.push(a));
		const ack = (await dispatch({
			tool: PROPOSE_DATABASE_VERB,
			args: { columns: ["Name"] },
		})) as Record<string, unknown>;
		expect(staged).toHaveLength(0);
		expect(ack.staged).toBe(false);
		expect(ack.reason).toBe("missing-name");
	});
});
