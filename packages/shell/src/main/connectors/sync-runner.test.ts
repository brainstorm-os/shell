import { ConflictPolicy, SyncDirection, SyncRunStatus } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	CONNECTOR_EXTERNAL_ID_PROP,
	CONNECTOR_SOURCE_PROP,
	type ResolvedMapping,
	SyncRunner,
	type SyncRunnerPorts,
	externalKey,
	isMappingSyncable,
} from "./sync-runner";

type Entity = { id: string; type: string; properties: Record<string, unknown>; updatedAt: number };

const T0 = 1_700_000_000_000;

function fakePorts(pages: unknown[]): {
	ports: SyncRunnerPorts;
	store: Map<string, Entity>;
	requests: Array<{ method: string; path: string; body?: unknown }>;
	/** Simulate a vault edit: patch properties + bump updatedAt. */
	editLocally(id: string, patch: Record<string, unknown>, at?: number): void;
	clock: { now: number };
} {
	const store = new Map<string, Entity>();
	const requests: Array<{ method: string; path: string; body?: unknown }> = [];
	const clock = { now: T0 };
	let call = 0;
	let nextId = 1;
	const ports: SyncRunnerPorts = {
		request: (input) => {
			requests.push(input);
			if (input.method !== "GET") return Promise.resolve({ ok: true });
			const page = pages[Math.min(call, pages.length - 1)];
			call += 1;
			return Promise.resolve(page);
		},
		findByExternalId: (entityType, key) => {
			for (const e of store.values()) {
				if (e.type === entityType && e.properties[CONNECTOR_EXTERNAL_ID_PROP] === key) {
					return Promise.resolve(e.id);
				}
			}
			return Promise.resolve(null);
		},
		createEntity: (type, properties) => {
			const id = `ent-${nextId++}`;
			store.set(id, { id, type, properties, updatedAt: clock.now });
			return Promise.resolve({ id });
		},
		updateEntity: (id, patch) => {
			const e = store.get(id);
			if (e) {
				e.properties = { ...e.properties, ...patch };
				e.updatedAt = clock.now;
			}
			return Promise.resolve();
		},
		getEntity: (id) => {
			const e = store.get(id);
			return Promise.resolve(
				e ? { id: e.id, properties: e.properties, updatedAt: e.updatedAt } : null,
			);
		},
		listByExternalIdPrefix: (entityType, prefix) => {
			const out = [...store.values()]
				.filter((e) => {
					const key = e.properties[CONNECTOR_EXTERNAL_ID_PROP];
					return e.type === entityType && typeof key === "string" && key.startsWith(prefix);
				})
				.map((e) => ({ id: e.id, properties: e.properties, updatedAt: e.updatedAt }));
			return Promise.resolve(out);
		},
		now: () => clock.now,
	};
	const editLocally = (id: string, patch: Record<string, unknown>, at?: number): void => {
		const e = store.get(id);
		if (!e) throw new Error(`no entity ${id}`);
		e.properties = { ...e.properties, ...patch };
		e.updatedAt = at ?? clock.now;
	};
	return { ports, store, requests, editLocally, clock };
}

const mapping: ResolvedMapping = {
	mappingId: "mapping-1",
	accountRef: "account-1",
	externalKind: "github:issue",
	entityType: "brainstorm/Task/v1",
	fieldMap: { title: "title", status: "state" },
	direction: SyncDirection.Pull,
	conflictPolicy: ConflictPolicy.ExternalWins,
	egressOrigins: ["https://api.github.com"],
	pull: {
		path: "/repos/o/r/issues",
		externalIdField: "id",
		cursorParam: "since",
		cursorField: "updated_at",
	},
};

const page = [
	{ id: 1, title: "First", state: "open", updated_at: "2026-06-01T00:00:00Z" },
	{ id: 2, title: "Second", state: "closed", updated_at: "2026-06-02T00:00:00Z" },
];

describe("SyncRunner.run — pull projection", () => {
	it("projects external resources into canonical entities with provenance", async () => {
		const { ports, store } = fakePorts([page]);
		const result = await new SyncRunner(ports).run(mapping);
		expect(result.status).toBe(SyncRunStatus.Succeeded);
		expect(result.pulled).toBe(2);
		expect(store.size).toBe(2);
		const first = [...store.values()].find(
			(e) => e.properties[CONNECTOR_EXTERNAL_ID_PROP] === externalKey("github:issue", 1),
		);
		expect(first?.properties.title).toBe("First");
		expect(first?.properties.status).toBe("open");
		expect(first?.properties[CONNECTOR_SOURCE_PROP]).toMatchObject({
			externalId: "1",
			externalKind: "github:issue",
			accountRef: "account-1",
		});
	});

	it("is idempotent: a second identical run creates NO duplicates", async () => {
		const { ports, store } = fakePorts([page, page]);
		const runner = new SyncRunner(ports);
		await runner.run(mapping);
		expect(store.size).toBe(2);
		const second = await runner.run(mapping);
		expect(second.pulled).toBe(2);
		expect(store.size).toBe(2); // upserted, not duplicated
	});

	it("advances the cursor to the max cursorField value", async () => {
		const { ports } = fakePorts([page]);
		const result = await new SyncRunner(ports).run(mapping);
		expect(result.nextCursor).toEqual({ since: "2026-06-02T00:00:00Z" });
	});

	it("sends the cursor as a query param on the next pull", async () => {
		const { ports, requests } = fakePorts([page]);
		await new SyncRunner(ports).run({ ...mapping, cursor: { since: "2026-05-01T00:00:00Z" } });
		expect(requests[0]?.path).toContain("since=2026-05-01");
	});

	it("applies static pull query params alongside the cursor", async () => {
		const { ports, requests } = fakePorts([page]);
		const ordered: ResolvedMapping = {
			...mapping,
			cursor: { since: "2026-05-01T00:00:00Z" },
			pull: { ...mapping.pull, query: { sort: "updated", direction: "asc" } },
		};
		await new SyncRunner(ports).run(ordered);
		expect(requests[0]?.path).toContain("sort=updated");
		expect(requests[0]?.path).toContain("direction=asc");
		expect(requests[0]?.path).toContain("since=2026-05-01");
	});

	it("external-wins overwrites a vault-edited synced entity on re-pull", async () => {
		const { ports, store } = fakePorts([page, page]);
		const runner = new SyncRunner(ports);
		await runner.run(mapping);
		const target = [...store.values()][0];
		if (target) target.properties.title = "Locally edited";
		await runner.run(mapping);
		const after = store.get(target?.id ?? "");
		expect(after?.properties.title).not.toBe("Locally edited");
	});

	it("vault-wins leaves an existing entity untouched", async () => {
		const { ports, store } = fakePorts([page, page]);
		const runner = new SyncRunner(ports);
		await runner.run(mapping);
		const target = [...store.values()][0];
		if (target) target.properties.title = "Locally edited";
		await runner.run({ ...mapping, conflictPolicy: ConflictPolicy.VaultWins });
		expect(store.get(target?.id ?? "")?.properties.title).toBe("Locally edited");
	});
});

const pushSpec = {
	path: "/repos/o/r/issues/{externalId}",
	fieldMap: { title: "title", state: "status" },
};
const twoWay: ResolvedMapping = { ...mapping, direction: SyncDirection.TwoWay, push: pushSpec };

function sourceOf(e: Entity | undefined): Record<string, unknown> {
	return (e?.properties[CONNECTOR_SOURCE_PROP] ?? {}) as Record<string, unknown>;
}

function byExternalId(store: Map<string, Entity>, id: number): Entity | undefined {
	return [...store.values()].find(
		(e) => e.properties[CONNECTOR_EXTERNAL_ID_PROP] === externalKey("github:issue", id),
	);
}

describe("SyncRunner.run — push / two-way (Connector-5)", () => {
	it("fails closed when push/two-way has no push spec", async () => {
		const { ports, store, requests } = fakePorts([page]);
		const result = await new SyncRunner(ports).run({ ...mapping, direction: SyncDirection.Push });
		expect(result.status).toBe(SyncRunStatus.Failed);
		expect(result.error).toMatch(/push-spec-missing:push/);
		expect(store.size).toBe(0);
		expect(requests).toHaveLength(0);
	});

	it("fails closed when the runner lacks the push ports", async () => {
		const { ports } = fakePorts([page]);
		const { listByExternalIdPrefix: _omitted, ...pullOnlyPorts } = ports;
		const result = await new SyncRunner(pullOnlyPorts).run({
			...twoWay,
			direction: SyncDirection.Push,
		});
		expect(result.status).toBe(SyncRunStatus.Failed);
		expect(result.error).toMatch(/push-ports-missing/);
	});

	it("a two-way pull seeds mirrors with a pushedState baseline and pushes nothing back", async () => {
		const { ports, store, requests } = fakePorts([page]);
		const result = await new SyncRunner(ports).run(twoWay);
		expect(result.status).toBe(SyncRunStatus.Succeeded);
		expect(result.pulled).toBe(2);
		expect(result.pushed).toBe(0);
		expect(result.conflicts).toBe(0);
		expect(typeof sourceOf(byExternalId(store, 1)).pushedState).toBe("string");
		expect(requests.every((r) => r.method === "GET")).toBe(true);
	});

	it("flipping a pull mapping to two-way baselines first, then pushes a local edit", async () => {
		const { ports, store, requests, editLocally, clock } = fakePorts([page, page, page, page]);
		const runner = new SyncRunner(ports);
		await runner.run(mapping); // Connector-4 pull: mirrors WITHOUT pushedState
		expect(sourceOf(byExternalId(store, 1)).pushedState).toBeUndefined();

		const baseline = await runner.run(twoWay);
		expect(baseline.pushed).toBe(0); // baseline run never writes to the provider
		expect(requests.every((r) => r.method === "GET")).toBe(true);
		expect(typeof sourceOf(byExternalId(store, 1)).pushedState).toBe("string");

		clock.now = T0 + 60_000;
		const target = byExternalId(store, 1);
		editLocally(target?.id ?? "", { title: "Edited in vault" });
		const pushRun = await runner.run(twoWay);
		expect(pushRun.pushed).toBe(1);
		const patch = requests.find((r) => r.method === "PATCH");
		expect(patch?.path).toBe("/repos/o/r/issues/1");
		expect(patch?.body).toEqual({ title: "Edited in vault", state: "open" });

		// Echo-free: the bookkeeping write and an unchanged re-run push nothing.
		const idle = await runner.run(twoWay);
		expect(idle.pushed).toBe(0);
		expect(requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
	});

	it("pure push never pulls and only writes back changed mirrors", async () => {
		const { ports, store, requests, editLocally, clock } = fakePorts([page, page]);
		const runner = new SyncRunner(ports);
		await runner.run(twoWay); // seed mirrors (with baseline)
		requests.length = 0;

		clock.now = T0 + 60_000;
		editLocally(byExternalId(store, 2)?.id ?? "", { status: "open" });
		const result = await runner.run({ ...twoWay, direction: SyncDirection.Push });
		expect(result.pulled).toBe(0);
		expect(result.pushed).toBe(1);
		expect(requests.every((r) => r.method === "PATCH")).toBe(true);
		expect(requests[0]?.path).toBe("/repos/o/r/issues/2");
	});

	it("skips mirrors of another account and entities without an external id", async () => {
		const { ports, store } = fakePorts([page]);
		const runner = new SyncRunner(ports);
		store.set("foreign", {
			id: "foreign",
			type: mapping.entityType,
			properties: {
				title: "Foreign",
				[CONNECTOR_EXTERNAL_ID_PROP]: externalKey("github:issue", 99),
				[CONNECTOR_SOURCE_PROP]: { externalId: "99", accountRef: "other-account" },
			},
			updatedAt: T0,
		});
		store.set("vault-born", {
			id: "vault-born",
			type: mapping.entityType,
			properties: { title: "No external id" },
			updatedAt: T0,
		});
		const result = await runner.run({ ...twoWay, direction: SyncDirection.Push });
		expect(result.pushed).toBe(0);
	});
});

describe("SyncRunner.run — two-way conflicts (OQ-CN-3 v1)", () => {
	const remotePage = (title: string, updatedAt: string) => [
		{ id: 1, title, state: "open", updated_at: updatedAt },
		page[1],
	];

	async function seedAndEdit(
		pages: unknown[],
		localEditAt: number,
	): Promise<ReturnType<typeof fakePorts> & { runner: SyncRunner; targetId: string }> {
		const f = fakePorts(pages);
		const runner = new SyncRunner(f.ports);
		await runner.run(twoWay);
		const targetId = byExternalId(f.store, 1)?.id ?? "";
		f.editLocally(targetId, { title: "Edited in vault" }, localEditAt);
		return { ...f, runner, targetId };
	}

	it("external-wins prefers the remote value on a both-sides change", async () => {
		const pages = [page, remotePage("Edited remotely", "2026-06-05T00:00:00Z")];
		const { runner, store, targetId, requests } = await seedAndEdit(pages, T0 + 1);
		const result = await runner.run(twoWay); // default ExternalWins
		expect(result.conflicts).toBe(1);
		expect(store.get(targetId)?.properties.title).toBe("Edited remotely");
		// The remote apply re-baselines, so nothing bounces back.
		expect(result.pushed).toBe(0);
		expect(requests.every((r) => r.method === "GET")).toBe(true);
	});

	it("vault-wins keeps the local value and pushes it back", async () => {
		const pages = [page, remotePage("Edited remotely", "2026-06-05T00:00:00Z")];
		const { runner, store, targetId, requests } = await seedAndEdit(pages, T0 + 1);
		const result = await runner.run({ ...twoWay, conflictPolicy: ConflictPolicy.VaultWins });
		expect(result.conflicts).toBe(1);
		expect(store.get(targetId)?.properties.title).toBe("Edited in vault");
		expect(result.pushed).toBe(1);
		const patch = requests.find((r) => r.method === "PATCH");
		expect((patch?.body as Record<string, unknown>).title).toBe("Edited in vault");
	});

	it("two-way-merge resolves last-writer-wins: newer remote wins", async () => {
		const pages = [page, remotePage("Edited remotely", "2026-06-05T00:00:00Z")];
		// Local edit long before the remote 2026 timestamp.
		const { runner, store, targetId } = await seedAndEdit(pages, T0 + 1);
		const result = await runner.run({ ...twoWay, conflictPolicy: ConflictPolicy.TwoWayMerge });
		expect(result.conflicts).toBe(1);
		expect(store.get(targetId)?.properties.title).toBe("Edited remotely");
	});

	it("two-way-merge resolves last-writer-wins: newer local wins and pushes", async () => {
		const pages = [page, remotePage("Edited remotely", "2026-06-05T00:00:00Z")];
		const localEditAt = Date.parse("2026-06-08T00:00:00Z");
		const { runner, store, targetId } = await seedAndEdit(pages, localEditAt);
		const result = await runner.run({ ...twoWay, conflictPolicy: ConflictPolicy.TwoWayMerge });
		expect(result.conflicts).toBe(1);
		expect(store.get(targetId)?.properties.title).toBe("Edited in vault");
		expect(result.pushed).toBe(1);
	});

	it("a remote-only change applies without counting a conflict", async () => {
		const pages = [page, remotePage("Edited remotely", "2026-06-05T00:00:00Z")];
		const f = fakePorts(pages);
		const runner = new SyncRunner(f.ports);
		await runner.run(twoWay);
		const result = await runner.run(twoWay);
		expect(result.conflicts).toBe(0);
		expect(byExternalId(f.store, 1)?.properties.title).toBe("Edited remotely");
	});
});

describe("isMappingSyncable", () => {
	it("accepts an in-scope pull path", () => {
		expect(isMappingSyncable(mapping, "https://api.github.com")).toBe(true);
	});

	it("rejects a wildcard origin or an out-of-scope absolute pull path", () => {
		expect(isMappingSyncable({ ...mapping, egressOrigins: ["*"] }, "https://api.github.com")).toBe(
			false,
		);
		expect(
			isMappingSyncable(
				{ ...mapping, pull: { ...mapping.pull, path: "https://evil.example.com/x" } },
				"https://api.github.com",
			),
		).toBe(false);
	});

	it("validates the push path against the frozen origins too", () => {
		expect(isMappingSyncable(twoWay, "https://api.github.com")).toBe(true);
		expect(
			isMappingSyncable(
				{ ...twoWay, push: { ...pushSpec, path: "https://evil.example.com/{externalId}" } },
				"https://api.github.com",
			),
		).toBe(false);
	});
});
