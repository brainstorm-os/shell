import { describe, expect, it, vi } from "vitest";
import { editorEntitiesHost } from "./editor-host";

describe("editorEntitiesHost (B11.24)", () => {
	it("forwards create / update to the app's entities service, keeping its this", async () => {
		const service = {
			calls: [] as unknown[],
			create(type: string, properties: Record<string, unknown>, id?: string) {
				this.calls.push(["create", type, properties, id]);
				return Promise.resolve({ id });
			},
			update(id: string, patch: Record<string, unknown>) {
				this.calls.push(["update", id, patch]);
				return Promise.resolve({ id });
			},
		};
		const host = editorEntitiesHost(service);
		await host?.create("brainstorm/Task/v1", { name: "x" }, "t1");
		await host?.update("t1", { statusKey: "done" });
		expect(service.calls).toEqual([
			["create", "brainstorm/Task/v1", { name: "x" }, "t1"],
			["update", "t1", { statusKey: "done" }],
		]);
	});

	it("is undefined without a service or either verb, so /task stays hidden", () => {
		expect(editorEntitiesHost(undefined)).toBeUndefined();
		expect(editorEntitiesHost(null)).toBeUndefined();
		expect(editorEntitiesHost({ create: vi.fn() })).toBeUndefined();
		expect(editorEntitiesHost({ update: vi.fn() })).toBeUndefined();
	});
});
