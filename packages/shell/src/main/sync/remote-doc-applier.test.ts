import { describe, expect, it, vi } from "vitest";
import { makeRemoteDocApplier } from "./remote-doc-applier";

const UPDATE = new Uint8Array([1, 2, 3]);

describe("makeRemoteDocApplier", () => {
	it("a remote update that landed tells the shell an entity changed", async () => {
		const order: string[] = [];
		const apply = vi.fn(async () => {
			order.push("apply");
		});
		const onApplied = vi.fn(() => {
			order.push("signal");
		});
		const noteSender = vi.fn();
		const applier = makeRemoteDocApplier({ apply: () => apply, onApplied, noteSender });

		await applier("ent_msg", "brainstorm/Message/v1", UPDATE, "sender-key");

		expect(apply).toHaveBeenCalledWith("ent_msg", Buffer.from(UPDATE).toString("base64"));
		expect(onApplied).toHaveBeenCalledWith("ent_msg");
		expect(noteSender).toHaveBeenCalledWith("ent_msg", "sender-key");
		// The signal follows the write: a list refreshed before it would re-read
		// the row it was told had changed and find it unchanged.
		expect(order).toEqual(["apply", "signal"]);
	});

	it("an update that failed to apply signals nothing and surfaces the failure", async () => {
		const onApplied = vi.fn();
		const applier = makeRemoteDocApplier({
			apply: () => async () => {
				throw new Error("worker gone");
			},
			onApplied,
		});

		await expect(applier("ent_msg", "t", UPDATE)).rejects.toThrow("worker gone");
		expect(onApplied).not.toHaveBeenCalled();
	});

	it("is a no-op before the entities service has bound its apply closure", async () => {
		const onApplied = vi.fn();
		const applier = makeRemoteDocApplier({ apply: () => null, onApplied });
		await applier("ent_msg", "t", UPDATE);
		expect(onApplied).not.toHaveBeenCalled();
	});

	it("a failing listener never fails the apply", async () => {
		const applier = makeRemoteDocApplier({
			apply: () => async () => undefined,
			onApplied: () => {
				throw new Error("window destroyed");
			},
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(applier("ent_msg", "t", UPDATE)).resolves.toBeUndefined();
		warn.mockRestore();
	});
});
