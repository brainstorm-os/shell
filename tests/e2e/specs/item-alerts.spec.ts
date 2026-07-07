/**
 * 9.14.9b — shell-side item alerts fire with the app closed.
 *
 * Boot 1 provisions a `Task/v1` with a timed `dueAt` ~45s out and shuts
 * down WITHOUT ever opening the Tasks app. Boot 2 reopens the vault and
 * only waits: the automations deployment must hydrate the task's alert
 * from the entity row and the scheduler drain must post it through the
 * shared notify host — the record lands in the dashboard's notification
 * history attributed to `io.brainstorm.tasks`. The relaunch also proves
 * the alert derives from *persisted* state, not an in-memory residue of
 * the write (and that no Tasks window is required at any point).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchShell } from "../../perf/lib/launch-shell";

type NotificationRecord = { appId: string; title: string; body?: string };

type Brainstorm = {
	vaults: {
		list: () => Promise<Array<{ id: string }>>;
		create: (o: { name: string; path: string }) => Promise<unknown>;
		activate: (id: string) => Promise<unknown>;
	};
	dashboard: {
		snapshot: () => Promise<{ notificationHistory: NotificationRecord[] } | null>;
	};
	dev: {
		seedPrebuiltApps: () => Promise<unknown>;
		collab: {
			provisionEntity: (
				entityId: string,
				type: string,
				properties: Record<string, unknown>,
			) => Promise<unknown>;
		};
	};
};

const TASK_ID = "e2e-item-alert-task";
const TASK_TITLE = "Item alert e2e probe";

test("item alerts — a due task notifies with the Tasks app closed, across a restart", async () => {
	test.setTimeout(240_000);
	const userDataDir = mkdtempSync(join(tmpdir(), "bs-e2e-item-alerts-"));
	try {
		// ── Boot 1: create the vault + the due task; never open Tasks. ────
		// COLLAB_DEBUG only registers the dev provision-entity IPC used to
		// write the task without opening the Tasks app (whose day picker
		// can't set a timed dueAt).
		const extraEnv = { BRAINSTORM_COLLAB_DEBUG: "1" };
		let dueAt = 0;
		{
			const { app } = await launchShell({ userDataDir, extraEnv });
			try {
				const dashboard = await app.firstWindow({ timeout: 60_000 });
				dueAt = await dashboard.evaluate(
					async ({ userDataDir, TASK_ID, TASK_TITLE }) => {
						const bs = (window as unknown as { brainstorm: Brainstorm }).brainstorm;
						const list = await bs.vaults.list();
						if (list.length === 0) {
							await bs.vaults.create({ name: "e2e-alerts", path: `${userDataDir}/vault` });
						} else if (list[0]) {
							await bs.vaults.activate(list[0].id);
						}
						await bs.dev.seedPrebuiltApps();
						// A timed instant (not local midnight) fires verbatim. Far
						// enough out to survive the restart, near enough to keep the
						// test fast.
						const at = Date.now() + 45_000;
						await bs.dev.collab.provisionEntity(TASK_ID, "brainstorm/Task/v1", {
							id: TASK_ID,
							name: TASK_TITLE,
							completedAt: null,
							dueAt: at,
							scheduledAt: null,
							createdAt: Date.now(),
							updatedAt: Date.now(),
						});
						return at;
					},
					{ userDataDir, TASK_ID, TASK_TITLE },
				);
			} finally {
				await app.close();
			}
		}
		expect(dueAt).toBeGreaterThan(Date.now());

		// ── Boot 2: reopen the vault and just wait for the alert. ─────────
		const { app } = await launchShell({ userDataDir });
		try {
			const dashboard = await app.firstWindow({ timeout: 60_000 });
			await dashboard.evaluate(async () => {
				const bs = (window as unknown as { brainstorm: Brainstorm }).brainstorm;
				const list = await bs.vaults.list();
				if (list[0]) await bs.vaults.activate(list[0].id);
			});

			// The alert fires within one scheduler drain tick (5s) of `dueAt`.
			const deadline = dueAt + 60_000;
			let hit: NotificationRecord | undefined;
			while (Date.now() < deadline && !hit) {
				const history = await dashboard.evaluate(async () => {
					const bs = (window as unknown as { brainstorm: Brainstorm }).brainstorm;
					const snap = await bs.dashboard.snapshot();
					return snap?.notificationHistory ?? [];
				});
				hit = history.find((n) => n.title === TASK_TITLE);
				if (!hit) await new Promise((r) => setTimeout(r, 2_000));
			}

			expect(hit, "the due-task alert should land in the notification history").toBeDefined();
			expect(hit?.appId).toBe("io.brainstorm.tasks");
			expect(hit?.body).toBe("Due now");
		} finally {
			await app.close();
		}
	} finally {
		rmSync(userDataDir, { recursive: true, force: true });
	}
});
