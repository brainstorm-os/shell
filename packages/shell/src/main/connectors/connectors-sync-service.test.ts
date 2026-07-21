import { ConflictPolicy, SyncDirection, SyncRunStatus } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import {
	type ConnectorsSyncDeps,
	type SyncContext,
	checkSyncMappingCap,
	makeConnectorsSync,
} from "./connectors-sync-service";
import { CONNECTOR_EXTERNAL_ID_PROP } from "./sync-runner";

const ctx: SyncContext = {
	connectorAppId: "io.brainstorm.github-issues",
	apiBaseUrl: "https://api.github.com",
	mapping: {
		mappingId: "mapping-1",
		accountRef: "account-1",
		externalKind: "github:issue",
		entityType: "brainstorm/Task/v1",
		fieldMap: { title: "title" },
		direction: SyncDirection.Pull,
		conflictPolicy: ConflictPolicy.ExternalWins,
		egressOrigins: ["https://api.github.com"],
		pull: { path: "/issues", externalIdField: "id", cursorParam: "since", cursorField: "updated_at" },
	},
};

function makeDeps(overrides: Partial<ConnectorsSyncDeps> = {}): {
	deps: ConnectorsSyncDeps;
	created: Array<{ type: string; props: Record<string, unknown> }>;
	runs: unknown[];
	cursors: Record<string, unknown>[];
} {
	const created: Array<{ type: string; props: Record<string, unknown> }> = [];
	const runs: unknown[] = [];
	const cursors: Record<string, unknown>[] = [];
	const deps: ConnectorsSyncDeps = {
		resolveMapping: () => Promise.resolve(ctx),
		request: () => Promise.resolve([{ id: 7, title: "Issue 7", updated_at: "2026-06-03T00:00:00Z" }]),
		findByExternalId: () => Promise.resolve(null),
		getEntity: () => Promise.resolve(null),
		listByExternalIdPrefix: () => Promise.resolve([]),
		createEntity: (_app, type, props) => {
			created.push({ type, props });
			return Promise.resolve({ id: `ent-${created.length}` });
		},
		updateEntity: () => Promise.resolve(),
		persistSyncRun: (_app, def) => {
			runs.push(def);
			return Promise.resolve();
		},
		advanceCursor: (_id, cursor) => {
			cursors.push(cursor);
			return Promise.resolve();
		},
		now: () => 1_700_000_000_000,
		...overrides,
	};
	return { deps, created, runs, cursors };
}

describe("connectors.sync service", () => {
	it("resolves, runs, projects the entity, persists a SyncRun and advances the cursor", async () => {
		const { deps, created, runs, cursors } = makeDeps();
		const result = await makeConnectorsSync(deps).runSync("mapping-1");
		expect(result?.status).toBe(SyncRunStatus.Succeeded);
		expect(created).toHaveLength(1);
		expect(created[0]?.type).toBe("brainstorm/Task/v1");
		expect(created[0]?.props[CONNECTOR_EXTERNAL_ID_PROP]).toBe("github:issue:7");
		expect(runs).toHaveLength(1);
		expect(cursors[0]).toEqual({ since: "2026-06-03T00:00:00Z" });
	});

	it("returns null for an unknown mapping", async () => {
		const { deps } = makeDeps({ resolveMapping: () => Promise.resolve(null) });
		expect(await makeConnectorsSync(deps).runSync("nope")).toBeNull();
	});

	it("refuses + records a failed run when the pull escapes egress scope", async () => {
		const escaped: SyncContext = {
			...ctx,
			mapping: { ...ctx.mapping, pull: { ...ctx.mapping.pull, path: "https://evil.example.com/x" } },
		};
		const { deps, created, runs } = makeDeps({ resolveMapping: () => Promise.resolve(escaped) });
		const result = await makeConnectorsSync(deps).runSync("mapping-1");
		expect(result?.status).toBe(SyncRunStatus.Failed);
		expect(result?.error).toBe("pull-path-out-of-egress-scope");
		expect(created).toHaveLength(0);
		expect(runs).toHaveLength(1); // a failed run is still recorded
	});
});

describe("checkSyncMappingCap", () => {
	it("ok below the hard cap, warns at the soft cap, rejects at the hard cap", () => {
		expect(checkSyncMappingCap(10)).toEqual({ ok: true, warn: false, count: 10 });
		expect(checkSyncMappingCap(200)).toEqual({ ok: true, warn: true, count: 200 });
		expect(checkSyncMappingCap(2000)).toEqual({ ok: false, warn: true, count: 2000 });
	});
});
