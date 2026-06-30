import { describe, expect, it, vi } from "vitest";
import { type EntityBodyDocTransport, copyEntityBody } from "./entity-body-copy";

function fakeTransport(snapshotB64 = "AAEC", truncatedTail = false): EntityBodyDocTransport {
	return {
		loadDoc: vi.fn(async () => ({ snapshotB64, truncatedTail })),
		applyDoc: vi.fn(async () => undefined),
		closeDoc: vi.fn(async () => undefined),
	};
}

describe("copyEntityBody", () => {
	it("loads the source body and applies it to the destination", async () => {
		const t = fakeTransport("SNAP64");
		await copyEntityBody(t, "src-1", "dst-2");
		expect(t.loadDoc).toHaveBeenCalledWith("src-1");
		expect(t.applyDoc).toHaveBeenCalledWith("dst-2", "SNAP64");
	});

	it("loads before it applies (order matters — the dst gets the src snapshot)", async () => {
		const order: string[] = [];
		const t: EntityBodyDocTransport = {
			loadDoc: vi.fn(async () => {
				order.push("load");
				return { snapshotB64: "X", truncatedTail: false };
			}),
			applyDoc: vi.fn(async () => {
				order.push("apply");
			}),
			closeDoc: vi.fn(async () => {
				order.push("close");
			}),
		};
		await copyEntityBody(t, "a", "b");
		expect(order).toEqual(["load", "apply", "close"]);
	});

	it("releases the source doc handle after copying", async () => {
		const t = fakeTransport();
		await copyEntityBody(t, "src", "dst");
		expect(t.closeDoc).toHaveBeenCalledWith("src");
	});

	it("still releases the source handle when applyDoc rejects", async () => {
		const t = fakeTransport();
		t.applyDoc = vi.fn(async () => {
			throw new Error("write denied");
		});
		await expect(copyEntityBody(t, "src", "dst")).rejects.toThrow("write denied");
		expect(t.closeDoc).toHaveBeenCalledWith("src");
	});

	it("never throws on closeDoc failure (best-effort release)", async () => {
		const t = fakeTransport();
		t.closeDoc = vi.fn(async () => {
			throw new Error("already closed");
		});
		await expect(copyEntityBody(t, "src", "dst")).resolves.toBeUndefined();
	});
});
