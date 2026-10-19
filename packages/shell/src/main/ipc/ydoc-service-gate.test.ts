import { describe, expect, it, vi } from "vitest";
import { Broker } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { SHELL_MAIN_APP_ID } from "../apps/manifest";
import { gateYDocService } from "./ydoc-service-gate";

const VAULT = "/vaults/active";

function envelope(app: string, args: unknown[], method = "load"): Envelope {
	return { v: 1, msg: "m1", app, service: "ydoc", method, args, caps: [] };
}

describe("gateYDocService (SH-ydoc-gate)", () => {
	it("refuses every app, whatever it declares", async () => {
		const inner = vi.fn(async () => "body");
		const gated = gateYDocService(inner, () => VAULT);
		await expect(
			gated(envelope("io.brainstorm.notes", [{ vaultPath: VAULT, entityId: "ent_1" }])),
		).rejects.toMatchObject({ name: "Denied" });
		expect(inner).not.toHaveBeenCalled();
	});

	it("a zero-grant app through the real broker never reaches the worker", async () => {
		const inner = vi.fn(async () => "SECRET victim note");
		const broker = new Broker({
			services: new Map(),
			verifyAppIdentity: (claimed, source) => claimed === "io.evil" && source === 7,
			checkCapability: (_app, _s, _m, caps) => caps.length === 0,
		});
		broker.registerService(
			"ydoc",
			gateYDocService(inner, () => VAULT),
		);
		const reply = await broker.dispatch(envelope("io.evil", [{ entityId: "ent_victim" }]), 7);
		expect(reply.ok).toBe(false);
		expect(inner).not.toHaveBeenCalled();
	});

	it("the shell's own calls pass, bound to the ACTIVE vault", async () => {
		const inner = vi.fn(async (e: Envelope) => e.args[0]);
		const gated = gateYDocService(inner, () => VAULT);
		expect(await gated(envelope(SHELL_MAIN_APP_ID, [{ entityId: "ent_1" }]))).toEqual({
			entityId: "ent_1",
			vaultPath: VAULT,
		});
		expect(await gated(envelope(SHELL_MAIN_APP_ID, [{ vaultPath: VAULT, entityId: "e" }]))).toEqual({
			vaultPath: VAULT,
			entityId: "e",
		});
	});

	it("a vaultPath other than the active vault is refused, never followed", async () => {
		const inner = vi.fn(async () => null);
		const gated = gateYDocService(inner, () => VAULT);
		await expect(
			gated(envelope(SHELL_MAIN_APP_ID, [{ vaultPath: "/tmp/elsewhere", entityId: "e" }])),
		).rejects.toMatchObject({ name: "Denied" });
		expect(inner).not.toHaveBeenCalled();
	});

	it("no active vault fails closed", async () => {
		const inner = vi.fn(async () => null);
		const gated = gateYDocService(inner, () => null);
		await expect(gated(envelope(SHELL_MAIN_APP_ID, [{ entityId: "e" }]))).rejects.toMatchObject({
			name: "Unavailable",
		});
		expect(inner).not.toHaveBeenCalled();
	});
});
