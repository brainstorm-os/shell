// @vitest-environment jsdom
/**
 * 9.8.2c — in-place navigation publishes the tab's route through
 * `ui.windows.setRoute`.
 *
 * A tab's route is seeded ONCE from the launch context, so without this the
 * shell's focus-existing keeps matching the tab on the object Files was opened
 * with long after the user browsed elsewhere. The mount pass must NOT publish
 * (the seeded route is still correct, and may name the entity a launch asked
 * Files to reveal — more precise than its folder).
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLDER_TYPE, ROOT_FOLDER_ID } from "../types/entity";
import type { BrainstormRuntime, VaultEntityShape } from "../types/runtime";
import { useFilesStore } from "./use-files-store";

const CHILD_ID = "folder-child";

function folder(id: string, name: string, members: string[]): VaultEntityShape {
	return {
		id,
		type: FOLDER_TYPE,
		properties: { id, name, members, createdAt: 1, updatedAt: 1 },
		createdAt: 1,
		updatedAt: 1,
		deletedAt: null,
	};
}

type Probe = { store: ReturnType<typeof useFilesStore> | null };

function installRuntime(): { routes: Array<{ entityId: string } | null> } {
	const routes: Array<{ entityId: string } | null> = [];
	const runtime: BrainstormRuntime = {
		services: {
			vaultEntities: {
				list: async () => ({
					entities: [folder(ROOT_FOLDER_ID, "Vault", [CHILD_ID]), folder(CHILD_ID, "Docs", [])],
					links: [],
				}),
				onChange: () => ({ unsubscribe: () => undefined }),
			},
			ui: {
				windows: {
					setRoute: async (target) => {
						routes.push(target);
					},
				},
			},
		},
	};
	window.brainstorm = runtime;
	return { routes };
}

async function mount(probe: Probe): Promise<Root> {
	const el = document.createElement("div");
	document.body.appendChild(el);
	const root = createRoot(el);
	function Harness() {
		probe.store = useFilesStore();
		return null;
	}
	await act(async () => {
		root.render(<Harness />);
	});
	// Let the query store's first load resolve + apply.
	await act(async () => {
		await Promise.resolve();
	});
	return root;
}

let probe: Probe;

beforeEach(() => {
	localStorage.clear();
	probe = { store: null };
});

afterEach(() => {
	document.body.innerHTML = "";
	localStorage.clear();
	window.brainstorm = {};
});

describe("useFilesStore route publishing (9.8.2c)", () => {
	it("publishes the folder it navigated to, and nothing on mount", async () => {
		const { routes } = installRuntime();
		await mount(probe);

		expect(routes).toEqual([]);

		await act(async () => {
			probe.store?.navigateToFolder(CHILD_ID);
		});

		expect(routes).toEqual([{ entityId: CHILD_ID }]);
	});

	it("publishes again when back returns to the previous folder", async () => {
		const { routes } = installRuntime();
		await mount(probe);

		await act(async () => {
			probe.store?.navigateToFolder(CHILD_ID);
		});
		await act(async () => {
			probe.store?.navigateBackOnce();
		});

		expect(routes).toEqual([{ entityId: CHILD_ID }, { entityId: ROOT_FOLDER_ID }]);
	});

	it("navigates normally on a shell with no route surface", async () => {
		installRuntime();
		const services = window.brainstorm?.services;
		if (services) services.ui = {};
		await mount(probe);

		await act(async () => {
			probe.store?.navigateToFolder(CHILD_ID);
		});

		expect(probe.store?.nav.current).toBe(CHILD_ID);
	});
});
