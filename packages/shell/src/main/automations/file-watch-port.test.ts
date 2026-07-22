import { describe, expect, it, vi } from "vitest";
import { FileHandleMode } from "../files/file-handle-registry";
import type { FileWatchHit } from "./automations-host";
import { createFileWatchPort } from "./file-watch-port";

/** A grant table + a controllable watch fake. */
function harness() {
	const grants = new Map<string, string>([
		["w1", "/tmp/a.txt"],
		["w2", "/tmp/b.txt"],
	]);
	const handleByPath = new Map<string, string>();
	let nextHandle = 0;
	let nextSub = 0;
	const watched = new Set<string>();
	const unwatched: string[] = [];
	const port = createFileWatchPort({
		resolveGrant: (watchId) => {
			const path = grants.get(watchId);
			return path ? { path, mode: FileHandleMode.Read } : null;
		},
		mintHandle: (path) => {
			const h = handleByPath.get(path) ?? `h${nextHandle++}`;
			handleByPath.set(path, h);
			return h;
		},
		watch: async (handleId) => {
			watched.add(handleId);
			return `sub${nextSub++}`;
		},
		unwatch: async (subscriptionId) => {
			unwatched.push(subscriptionId);
		},
	});
	return { port, handleByPath, watched, unwatched };
}

describe("file-watch port (11b.10)", () => {
	it("resolves grants, mints handles, and watches on register", async () => {
		const h = harness();
		h.port.register([{ workflowId: "wf1", watchId: "w1" }]);
		await vi.waitFor(() => expect(h.watched.size).toBe(1));
		expect(h.handleByPath.get("/tmp/a.txt")).toBeDefined();
	});

	it("emits a hit for the workflow bound to the changed file", async () => {
		const h = harness();
		const hits: FileWatchHit[] = [];
		h.port.subscribe((hit) => hits.push(hit));
		h.port.register([{ workflowId: "wf1", watchId: "w1" }]);
		await vi.waitFor(() => expect(h.watched.size).toBe(1));
		const handleId = h.handleByPath.get("/tmp/a.txt") as string;

		h.port.onFileChange({ handleId, kind: "changed" });
		expect(hits).toEqual([{ workflowId: "wf1", watchId: "w1", kind: "changed" }]);
	});

	it("skips an unresolvable (revoked) watchId — fail-closed, no watch", async () => {
		const h = harness();
		h.port.register([{ workflowId: "wf1", watchId: "gone" }]);
		await new Promise((r) => setTimeout(r, 0));
		expect(h.watched.size).toBe(0);
	});

	it("unwatches entries dropped on re-register", async () => {
		const h = harness();
		h.port.register([{ workflowId: "wf1", watchId: "w1" }]);
		await vi.waitFor(() => expect(h.watched.size).toBe(1));
		h.port.register([{ workflowId: "wf2", watchId: "w2" }]);
		await vi.waitFor(() => expect(h.unwatched.length).toBe(1));
	});

	it("close unwatches everything", async () => {
		const h = harness();
		h.port.register([{ workflowId: "wf1", watchId: "w1" }]);
		await vi.waitFor(() => expect(h.watched.size).toBe(1));
		await h.port.close();
		expect(h.unwatched.length).toBe(1);
	});
});
