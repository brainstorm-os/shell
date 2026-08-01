/**
 * `tools.list` (Tool-2) — the three composing filters, all fail-closed, over
 * a real `registry.db` table + repo.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import {
	AppToolEffect,
	type AppToolRecord,
	AppToolSurface,
	appToolId,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Envelope } from "../../ipc/envelope";
import { ENVELOPE_PROTOCOL_VERSION } from "../../ipc/envelope";
import { DataStores } from "../storage/data-stores";
import { AppToolsRepository } from "../storage/registry-repo/app-tools-repo";
import { TOOLS_READ_CAPABILITY, makeToolsServiceHandler } from "./tools-service";

const CALLER = "io.brainstorm.notes";

function envelope(method: string, args: unknown[]): Envelope {
	return {
		v: ENVELOPE_PROTOCOL_VERSION,
		msg: "m1",
		app: CALLER,
		service: "tools",
		method,
		args,
		caps: [TOOLS_READ_CAPABILITY],
	};
}

function ledgerGranting(pairs: ReadonlyArray<[string, string]>): CapabilityLedger {
	const held = new Set(pairs.map(([app, cap]) => `${app}::${cap}`));
	// Mirrors the real ledger's two read shapes: exact `has` (capability[:scope])
	// and `listActive` (every live grant for a principal), which is how the
	// effect filter matches a SCOPED grant against a capability name.
	return {
		has: (app: string, cap: string) => held.has(`${app}::${cap}`),
		listActive: (app: string) =>
			pairs
				.filter(([a]) => a === app)
				.map(([, cap]) => {
					const colon = cap.indexOf(":");
					return {
						capability: colon < 0 ? cap : cap.slice(0, colon),
						scope: colon < 0 ? null : cap.slice(colon + 1),
					};
				}),
	} as unknown as CapabilityLedger;
}

function tool(partial: Partial<AppToolRecord> & { appId: string; name: string }): AppToolRecord {
	return {
		id: appToolId(partial.appId, partial.name),
		appId: partial.appId,
		name: partial.name,
		title: partial.title ?? "Tool",
		description: partial.description ?? "does a thing",
		effect: partial.effect ?? AppToolEffect.Pure,
		appliesTo: partial.appliesTo ?? [],
		surfaces: partial.surfaces ?? [AppToolSurface.Menu, AppToolSurface.Agent],
		registeredAt: 1000,
	};
}

describe("tools.list (Tool-2)", () => {
	let dir: string;
	let stores: DataStores;
	let repo: AppToolsRepository;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "brainstorm-tools-"));
		stores = new DataStores(dir);
		repo = new AppToolsRepository(await stores.open("registry"));
	});
	afterEach(async () => {
		stores.close();
		await rm(dir, { recursive: true, force: true });
	});

	const handler = (opts: Partial<Parameters<typeof makeToolsServiceHandler>[0]> = {}) =>
		makeToolsServiceHandler({
			getRepo: () => repo,
			getLedger: async () => ledgerGranting([[CALLER, TOOLS_READ_CAPABILITY]]),
			...opts,
		});

	it("round-trips a declared tool through the registry", async () => {
		repo.insertMany([tool({ appId: "io.example.rewrite", name: "rewrite", title: "Rewrite" })]);
		const rows = (await handler()(envelope("list", [{}]))) as AppToolRecord[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "app.io.example.rewrite.rewrite",
			appId: "io.example.rewrite",
			name: "rewrite",
			title: "Rewrite",
			effect: AppToolEffect.Pure,
		});
	});

	it("filters by declared applicability — never by content", async () => {
		repo.insertMany([
			tool({ appId: "io.example.a", name: "notes-only", appliesTo: ["brainstorm/Note/v1"] }),
			tool({ appId: "io.example.b", name: "anything" }), // empty appliesTo = any
		]);
		const forTasks = (await handler()(
			envelope("list", [{ appliesTo: "brainstorm/Task/v1" }]),
		)) as AppToolRecord[];
		expect(forTasks.map((t) => t.name)).toEqual(["anything"]);
		const forNotes = (await handler()(
			envelope("list", [{ appliesTo: "brainstorm/Note/v1" }]),
		)) as AppToolRecord[];
		expect(forNotes.map((t) => t.name).sort()).toEqual(["anything", "notes-only"]);
	});

	it("filters by surface", async () => {
		repo.insertMany([
			tool({ appId: "io.example.a", name: "agent-only", surfaces: [AppToolSurface.Agent] }),
			tool({ appId: "io.example.b", name: "menu-only", surfaces: [AppToolSurface.Menu] }),
		]);
		const menu = (await handler()(
			envelope("list", [{ surface: AppToolSurface.Menu }]),
		)) as AppToolRecord[];
		expect(menu.map((t) => t.name)).toEqual(["menu-only"]);
	});

	it("drops a tool whose PROVIDER no longer holds what its effect implies", async () => {
		repo.insertMany([
			tool({ appId: "io.example.reader", name: "summarize", effect: AppToolEffect.ReadsVault }),
			tool({ appId: "io.example.pure", name: "slugify", effect: AppToolEffect.Pure }),
		]);
		// Caller may read the catalogue; the reads-vault provider holds nothing.
		const rows = (await handler()(envelope("list", [{}]))) as AppToolRecord[];
		expect(rows.map((t) => t.name)).toEqual(["slugify"]);

		// Grant the provider its capability — now it is offered.
		const withGrant = makeToolsServiceHandler({
			getRepo: () => repo,
			getLedger: async () =>
				ledgerGranting([
					[CALLER, TOOLS_READ_CAPABILITY],
					["io.example.reader", "entities.read:brainstorm/Note/v1"],
				]),
		});
		const rows2 = (await withGrant(envelope("list", [{}]))) as AppToolRecord[];
		expect(rows2.map((t) => t.name).sort()).toEqual(["slugify", "summarize"]);
	});

	it("hides a disabled provider entirely (AS-4)", async () => {
		repo.insertMany([tool({ appId: "io.example.a", name: "rewrite" })]);
		const rows = (await handler({
			resolveDisabledContributors: async () => new Set(["io.example.a"]),
		})(envelope("list", [{}]))) as AppToolRecord[];
		expect(rows).toEqual([]);
	});

	it("never offers an app its own tools back", async () => {
		repo.insertMany([tool({ appId: CALLER, name: "mine" })]);
		const rows = (await handler()(envelope("list", [{}]))) as AppToolRecord[];
		expect(rows).toEqual([]);
	});

	it("fails closed (Denied) without tools.read", async () => {
		repo.insertMany([tool({ appId: "io.example.a", name: "rewrite" })]);
		const denied = makeToolsServiceHandler({
			getRepo: () => repo,
			getLedger: async () => ledgerGranting([]),
		});
		await expect(denied(envelope("list", [{}]))).rejects.toMatchObject({ name: "Denied" });
	});

	it("fails closed (Unavailable) with no vault session", async () => {
		const noVault = makeToolsServiceHandler({
			getRepo: () => null,
			getLedger: async () => ledgerGranting([[CALLER, TOOLS_READ_CAPABILITY]]),
		});
		await expect(noVault(envelope("list", [{}]))).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("fails CLOSED when the disable set cannot be read", async () => {
		repo.insertMany([tool({ appId: "io.example.a", name: "rewrite" })]);
		await expect(
			handler({
				resolveDisabledContributors: async () => {
					throw new Error("dashboard store down");
				},
			})(envelope("list", [{}])),
		).rejects.toMatchObject({ name: "Unavailable" });
	});

	it("rejects an unknown surface instead of silently dropping the filter", async () => {
		await expect(handler()(envelope("list", [{ surface: "everywhere" }]))).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("never presents a tool that declares no surfaces, even unfiltered", async () => {
		repo.insertMany([tool({ appId: "io.example.a", name: "hidden", surfaces: [] })]);
		const rows = (await handler()(envelope("list", [{}]))) as AppToolRecord[];
		expect(rows).toEqual([]);
	});

	it("a corrupt effect is never offered (the fallback must not be fail-open)", async () => {
		const db = await stores.open("registry");
		db
			.prepare(
				"INSERT INTO app_tools (id, app_id, name, title, description, effect, applies_to, surfaces, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run("app.io.example.x.bad", "io.example.x", "bad", "Bad", "d", "nonsense", "[]", '["menu"]', 1);
		const rows = (await handler()(envelope("list", [{}]))) as AppToolRecord[];
		expect(rows).toEqual([]);
	});

	it("an Object.prototype key as effect is never offered (no inherited-key bypass)", async () => {
		const db = await stores.open("registry");
		for (const [i, evil] of ["toString", "valueOf", "constructor"].entries()) {
			db
				.prepare(
					"INSERT INTO app_tools (id, app_id, name, title, description, effect, applies_to, surfaces, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(`app.io.example.p.t${i}`, "io.example.p", `t${i}`, "T", "d", evil, "[]", '["menu"]', 1);
		}
		const rows = (await handler()(envelope("list", [{}]))) as AppToolRecord[];
		expect(rows).toEqual([]);
	});

	it("rejects an unknown method", async () => {
		await expect(handler()(envelope("call", [{}]))).rejects.toMatchObject({ name: "Invalid" });
	});

	it("degrades a corrupt row to the most restrictive effect, never the most permissive", async () => {
		const db = await stores.open("registry");
		db
			.prepare(
				"INSERT INTO app_tools (id, app_id, name, title, description, effect, applies_to, surfaces, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run("app.io.example.x.bad", "io.example.x", "bad", "Bad", "d", "nonsense", "[", "[", 1);
		const row = repo.get("app.io.example.x.bad");
		expect(row?.effect).toBe("nonsense");
		expect(row?.appliesTo).toEqual([]);
		expect(row?.surfaces).toEqual([]);
	});
});
