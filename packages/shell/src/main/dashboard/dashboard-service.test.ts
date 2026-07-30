/**
 * `dashboard` broker service handler — pin/unpin/isPinned over a real
 * DashboardStore (in-memory YDocStore, tmp dir). The broker enforces
 * `dashboard.pin` from the envelope `caps`; these tests pin the handler
 * contract: idempotent pin, dashboard-state-only unpin, deterministic
 * icon id, no-session → false, Invalid on bad args.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { isUnplacedIcon, resolveIconPlacements } from "../../shared/dashboard-icon-grid";
import type { EntitiesRepository } from "../storage/entities-repo";
import { YDocStore } from "../storage/ydoc-store";
import { makeDashboardServiceHandler } from "./dashboard-service";
import { DashboardStore } from "./dashboard-store";

function env(method: string, args: unknown[]): Envelope {
	return { v: 1, msg: "m1", app: "io.test.app", service: "dashboard", method, args, caps: [] };
}

const fakeRepo = (rows: Record<string, { type: string; properties: Record<string, unknown> }>) =>
	({ get: (id: string) => rows[id] ?? null }) as unknown as EntitiesRepository;

let vaultDir: string;
let yStore: YDocStore;
let store: DashboardStore;

beforeEach(async () => {
	vaultDir = await mkdtemp(join(tmpdir(), "bs-dashsvc-"));
	yStore = new YDocStore(vaultDir);
	store = await DashboardStore.open(yStore);
});
afterEach(async () => {
	await store.close();
	await rm(vaultDir, { recursive: true, force: true });
});

function handler(
	repoRows: Record<string, { type: string; properties: Record<string, unknown> }> = {},
) {
	return makeDashboardServiceHandler({
		getStore: async () => store,
		getEntitiesRepo: async () => fakeRepo(repoRows),
	});
}

describe("dashboard service handler", () => {
	it("pin creates an entity icon storing only the id; idempotent", async () => {
		const h = handler({ "ent-1": { type: "io.acme/Doc/v1", properties: { title: "Spec" } } });

		expect(await h(env("pin", [{ entityId: "ent-1" }]))).toBe(true);
		const icons = store.snapshot().icons;
		const ids = Object.keys(icons);
		expect(ids).toHaveLength(1);
		const rec = icons[ids[0] as string];
		expect(rec?.kind).toBe("entity");
		expect(rec?.target).toBe("ent-1");
		// best-effort label seed (overridden live by the resolver on read).
		expect(rec?.label).toBe("Spec");

		// Re-pin is a no-op — same single icon, still resolves true.
		expect(await h(env("pin", [{ entityId: "ent-1" }]))).toBe(true);
		expect(Object.keys(store.snapshot().icons)).toHaveLength(1);
	});

	it("isPinned reflects state; unpin removes only the pin", async () => {
		const h = handler();
		expect(await h(env("isPinned", [{ entityId: "ent-1" }]))).toBe(false);
		await h(env("pin", [{ entityId: "ent-1" }]));
		expect(await h(env("isPinned", [{ entityId: "ent-1" }]))).toBe(true);

		expect(await h(env("unpin", [{ entityId: "ent-1" }]))).toBe(true);
		expect(await h(env("isPinned", [{ entityId: "ent-1" }]))).toBe(false);
		expect(Object.keys(store.snapshot().icons)).toHaveLength(0);
		// Unpinning what isn't pinned is a no-op false (never throws).
		expect(await h(env("unpin", [{ entityId: "ent-1" }]))).toBe(false);
	});

	// POLISH-LAY-9 — main pins WITHOUT a cell (it can't see the icon surface's
	// width, and its unbounded scan walked new icons off the right edge). The
	// renderer resolves the sentinels into distinct on-screen slots.
	it("pins with no position, and the renderer's resolver lays them into distinct free cells", async () => {
		const h = handler();
		await h(env("pin", [{ entityId: "a" }]));
		await h(env("pin", [{ entityId: "b" }]));
		const icons = store.snapshot().icons;
		expect(Object.values(icons).every(isUnplacedIcon)).toBe(true);

		const changes = resolveIconPlacements(icons, 1440);
		expect(changes).toHaveLength(2);
		const cells = changes.map((c) => `${c.col}:${c.row}`);
		expect(new Set(cells).size).toBe(2);
	});

	it("no active vault session → false, never throws", async () => {
		const h = makeDashboardServiceHandler({
			getStore: async () => null,
			getEntitiesRepo: async () => null,
		});
		expect(await h(env("pin", [{ entityId: "x" }]))).toBe(false);
		expect(await h(env("unpin", [{ entityId: "x" }]))).toBe(false);
		expect(await h(env("isPinned", [{ entityId: "x" }]))).toBe(false);
	});

	it("pin still succeeds when the entities repo is unavailable (empty label seed)", async () => {
		const h = makeDashboardServiceHandler({
			getStore: async () => store,
			getEntitiesRepo: async () => null,
		});
		expect(await h(env("pin", [{ entityId: "ent-1" }]))).toBe(true);
		const rec = Object.values(store.snapshot().icons)[0];
		expect(rec?.target).toBe("ent-1");
		expect(rec?.label).toBe("");
	});

	it("rejects malformed args and unknown methods as Invalid", async () => {
		const h = handler();
		await expect(h(env("pin", [{}]))).rejects.toMatchObject({ name: "Invalid" });
		await expect(h(env("pin", [{ entityId: "" }]))).rejects.toMatchObject({ name: "Invalid" });
		await expect(h(env("pin", ["not-an-object"]))).rejects.toMatchObject({ name: "Invalid" });
		await expect(h(env("frobnicate", []))).rejects.toMatchObject({ name: "Invalid" });
	});
});
