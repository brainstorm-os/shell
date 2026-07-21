import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { WorkflowRunStatus } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, type Envelope } from "../../ipc/envelope";
import { AUTOMATIONS_RUN_CAP, makeAutomationsServiceHandler } from "./automations-service";
import type { AutomationsDeployment } from "./wiring";

function env(method: string, arg?: unknown): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m",
		app: "io.brainstorm.automations",
		service: "automations",
		method,
		args: [arg],
		caps: [AUTOMATIONS_RUN_CAP],
	};
}

function ledgerWith(grants: string[]): () => Promise<CapabilityLedger> {
	return async () =>
		({
			has: (_app: string, required: string) => grants.includes(required),
		}) as unknown as CapabilityLedger;
}

function fakeDeployment(): AutomationsDeployment {
	const status = { deviceId: "device-A", hostDeviceId: null, scheduling: true };
	return {
		start: vi.fn(async () => status),
		stop: vi.fn(),
		runNow: vi.fn(async () => ({ status: WorkflowRunStatus.Succeeded })),
		hostStatus: vi.fn(async () => status),
		claimHost: vi.fn(async () => ({ ...status, hostDeviceId: "device-A" })),
		host: {},
		scheduler: {},
	} as unknown as AutomationsDeployment;
}

describe("automations service handler", () => {
	it("runNow returns the terminal status and routes the workflow id", async () => {
		const deployment = fakeDeployment();
		const handler = makeAutomationsServiceHandler({
			getDeployment: () => deployment,
			getLedger: ledgerWith([AUTOMATIONS_RUN_CAP]),
		});
		const result = await handler(env("runNow", { workflowId: "wf1" }));
		expect(result).toEqual({ status: WorkflowRunStatus.Succeeded });
		expect(deployment.runNow).toHaveBeenCalledWith("wf1");
	});

	it("maps a refused/missing workflow to { status: null }", async () => {
		const deployment = fakeDeployment();
		(deployment.runNow as ReturnType<typeof vi.fn>).mockResolvedValue(null);
		const handler = makeAutomationsServiceHandler({
			getDeployment: () => deployment,
			getLedger: ledgerWith([AUTOMATIONS_RUN_CAP]),
		});
		expect(await handler(env("runNow", { workflowId: "gone" }))).toEqual({ status: null });
	});

	it("re-checks automations.run server-side, fail-closed", async () => {
		const deployment = fakeDeployment();
		const handler = makeAutomationsServiceHandler({
			getDeployment: () => deployment,
			getLedger: ledgerWith([]),
		});
		await expect(handler(env("runNow", { workflowId: "wf1" }))).rejects.toMatchObject({
			name: "Denied",
		});
		expect(deployment.runNow).not.toHaveBeenCalled();
	});

	it("is Unavailable with no active deployment / vault", async () => {
		const handler = makeAutomationsServiceHandler({
			getDeployment: () => null,
			getLedger: ledgerWith([AUTOMATIONS_RUN_CAP]),
		});
		await expect(handler(env("hostStatus"))).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("rejects a malformed runNow arg and unknown methods", async () => {
		const handler = makeAutomationsServiceHandler({
			getDeployment: () => fakeDeployment(),
			getLedger: ledgerWith([AUTOMATIONS_RUN_CAP]),
		});
		await expect(handler(env("runNow", {}))).rejects.toMatchObject({ name: "Invalid" });
		await expect(handler(env("runNow", { workflowId: 7 }))).rejects.toMatchObject({
			name: "Invalid",
		});
		await expect(handler(env("selfDestruct"))).rejects.toMatchObject({ name: "Invalid" });
	});

	it("hostStatus / claimHost pass through the deployment", async () => {
		const deployment = fakeDeployment();
		const handler = makeAutomationsServiceHandler({
			getDeployment: () => deployment,
			getLedger: ledgerWith([AUTOMATIONS_RUN_CAP]),
		});
		expect(await handler(env("hostStatus"))).toMatchObject({ deviceId: "device-A" });
		expect(await handler(env("claimHost"))).toMatchObject({ hostDeviceId: "device-A" });
	});
});
