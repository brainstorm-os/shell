import { describe, expect, it, vi } from "vitest";
import {
	AutomationsHost,
	type FileWatchHit,
	type FileWatchPort,
	type FileWatchTrigger,
	type ScheduleRegistration,
} from "./automations-host";

function fakePort() {
	let watches: readonly FileWatchTrigger[] = [];
	const listeners = new Set<(hit: FileWatchHit) => void>();
	const port: FileWatchPort = {
		register: (next) => {
			watches = next;
		},
		subscribe: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
	};
	return {
		port,
		watches: () => watches,
		push: (hit: FileWatchHit) => {
			for (const l of listeners) l(hit);
		},
	};
}

function registration(fileWatches: FileWatchTrigger[]): ScheduleRegistration {
	return { workflows: [], reminders: [], entityEvents: [], fileWatches };
}

function makeHost(port: FileWatchPort, runWorkflow: ReturnType<typeof vi.fn>) {
	const host = new AutomationsHost({
		scheduler: { tick: vi.fn(async () => []) } as never,
		reminderRunner: { fire: vi.fn() } as never,
		loadWorkflow: vi.fn(),
		makeInterpreterPorts: vi.fn(),
		persistRun: vi.fn(),
		appCapabilities: [],
		clock: () => 0,
		fileWatch: port,
		intervals: { set: () => 0 as never, clear: () => {} },
	});
	(host as unknown as { runWorkflow: unknown }).runWorkflow = runWorkflow;
	return host;
}

const watch: FileWatchTrigger = { workflowId: "wf1", watchId: "w1" };

describe("AutomationsHost file-watch dispatch (11b.10)", () => {
	it("registers watches on hydrate and runs the bound workflow on a change", async () => {
		const p = fakePort();
		const runWorkflow = vi.fn(async () => null);
		const host = makeHost(p.port, runWorkflow);
		await host.hydrate(registration([watch]), 0);
		expect(p.watches()).toEqual([watch]);
		host.start();

		p.push({ workflowId: "wf1", watchId: "w1", kind: "changed" });
		await vi.waitFor(() => expect(runWorkflow).toHaveBeenCalledTimes(1));
		expect(runWorkflow).toHaveBeenCalledWith("wf1", "file-watch:w1", {
			watchId: "w1",
			kind: "changed",
		});
		host.stop();
	});

	it("drops a change for a watch no longer registered", async () => {
		const p = fakePort();
		const runWorkflow = vi.fn(async () => null);
		const host = makeHost(p.port, runWorkflow);
		await host.hydrate(registration([watch]), 0);
		host.start();
		p.push({ workflowId: "wfX", watchId: "gone", kind: "changed" });
		await new Promise((r) => setTimeout(r, 0));
		expect(runWorkflow).not.toHaveBeenCalled();
		host.stop();
	});

	it("stop() unsubscribes so a later change does not fire", async () => {
		const p = fakePort();
		const runWorkflow = vi.fn(async () => null);
		const host = makeHost(p.port, runWorkflow);
		await host.hydrate(registration([watch]), 0);
		host.start();
		host.stop();
		p.push({ workflowId: "wf1", watchId: "w1", kind: "changed" });
		await new Promise((r) => setTimeout(r, 0));
		expect(runWorkflow).not.toHaveBeenCalled();
	});
});
