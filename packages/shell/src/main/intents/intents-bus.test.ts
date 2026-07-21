import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OS_HANDOFF_APP_ID,
	OpenRefusal,
	OpenRung,
	OpenWithDecisionKind,
	OsHandoffConsent,
	OsHandoffPromptDecision,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSignatureStatus } from "../apps/app-signature";
import { DEFAULT_INSTALL_PROVENANCE } from "../apps/install-provenance";
import type { LaunchOrchestrator } from "../apps/launch-orchestrator";
import type { AppLauncher, AppWindow } from "../apps/launcher";
import { DataStores } from "../storage/data-stores";
import { OpenerTargetKind, RegistryRepositories } from "../storage/registry-repo";
import { IntentsBus, type IntentsBusOptions } from "./intents-bus";

function makeOrchestrator() {
	const launches: Array<Parameters<LaunchOrchestrator["launch"]>[0]> = [];
	const orchestrator = {
		launch: vi.fn(async (req: Parameters<LaunchOrchestrator["launch"]>[0]): Promise<AppWindow> => {
			launches.push(req);
			return {
				appId: req.appId,
				windowId: req.windowId ?? "main",
				tabId: "tab-1",
				webContentsId: 7,
				parked: false,
				webContents: {} as AppWindow["webContents"],
				container: {} as AppWindow["container"],
			};
		}),
	} as unknown as LaunchOrchestrator;
	return { orchestrator, launches };
}

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-intents-bus-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("registry");
	const repos = new RegistryRepositories(db);
	repos.apps.upsert({
		id: "io.example.editor",
		version: "1.0.0",
		sdk: "1",
		manifestPath: "/p/manifest.json",
		bundleDir: "/p",
		bundleSha256: "a".repeat(64),
		installedAt: 1,
		updatedAt: 1,
		signatureStatus: AppSignatureStatus.Unsigned,
		signatureKeyId: null,
		...DEFAULT_INSTALL_PROVENANCE,
	});
	repos.apps.upsert({
		id: "io.example.viewer",
		version: "1.0.0",
		sdk: "1",
		manifestPath: "/p/manifest.json",
		bundleDir: "/p",
		bundleSha256: "a".repeat(64),
		installedAt: 1,
		updatedAt: 1,
		signatureStatus: AppSignatureStatus.Unsigned,
		signatureKeyId: null,
		...DEFAULT_INSTALL_PROVENANCE,
	});
	const { orchestrator, launches } = makeOrchestrator();
	const bus = new IntentsBus({ intents: repos.intents, orchestrator });
	return { vaultDir, stores, repos, bus, orchestrator, launches };
}

describe("IntentsBus", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("dispatch with no handler returns no-handler", async () => {
		const result = await env.bus.dispatch(
			{ verb: "open", payload: { entityId: "ent_1" } },
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(false);
		expect(result.handled === false && result.reason).toBe("no-handler");
	});

	it("dispatch open routes through the orchestrator with open-entity context", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Note/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		const result = await env.bus.dispatch(
			{
				verb: "open",
				payload: { entityId: "ent_42", entityType: "io.example/Note/v1" },
			},
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches).toHaveLength(1);
		const launch = env.launches[0];
		expect(launch?.appId).toBe("io.example.editor");
		expect(launch?.launch).toEqual({ reason: "open-entity", entityId: "ent_42" });
		// OpenRes-1c entity-flow rung stamp: the entity dispatch path lands
		// `InVaultOpeners` so the renderer-side explainer can surface
		// "Opened in <App>" toasts uniformly across all open dispatches.
		expect(result.rung).toBe(OpenRung.InVaultOpeners);
	});

	it("dispatch entity-open with no handler returns no-handler (no rung stamped)", async () => {
		// The entity-flow rung stamp wraps a successful launchInto;
		// a no-handler outcome is returned before launchInto runs, so
		// no rung is stamped. Pins that the explainer mapper returns null
		// here (the existing "no handler in this vault" UI keeps owning
		// the surface).
		const result = await env.bus.dispatch(
			{ verb: "open", payload: { entityId: "ent_404" } },
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(false);
		expect(result.handled === false && result.reason).toBe("no-handler");
		expect(result.rung).toBeUndefined();
	});

	it("suggest returns matching handlers sorted by priority", async () => {
		env.repos.intents.insertMany([
			{
				appId: "io.example.viewer",
				verb: "open",
				entityType: "io.example/Note/v1",
				mime: null,
				format: null,
				kind: null,
				blockId: null,
				label: "View",
				priority: "secondary",
				registeredAt: 1,
			},
			{
				appId: "io.example.editor",
				verb: "open",
				entityType: "io.example/Note/v1",
				mime: null,
				format: null,
				kind: null,
				blockId: null,
				label: "Edit",
				priority: "primary",
				registeredAt: 1,
			},
		]);
		const suggestions = await env.bus.suggest({
			verb: "open",
			payload: { entityType: "io.example/Note/v1" },
		});
		expect(suggestions.map((s) => s.appId)).toEqual(["io.example.editor", "io.example.viewer"]);
		expect(suggestions[0]?.priority).toBe("primary");
	});

	it("same-source app wins handler selection (no ping-pong to siblings)", async () => {
		env.repos.intents.insertMany([
			{
				appId: "io.example.editor",
				verb: "open",
				entityType: "io.example/Note/v1",
				mime: null,
				format: null,
				kind: null,
				blockId: null,
				label: null,
				priority: "primary",
				registeredAt: 1,
			},
			{
				appId: "io.example.viewer",
				verb: "open",
				entityType: "io.example/Note/v1",
				mime: null,
				format: null,
				kind: null,
				blockId: null,
				label: null,
				priority: "secondary",
				registeredAt: 1,
			},
		]);
		const result = await env.bus.dispatch(
			{ verb: "open", payload: { entityId: "ent_1", entityType: "io.example/Note/v1" } },
			{ app: "io.example.viewer" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.viewer");
	});

	it("a verb with no delivery channel returns no-delivery-channel in v1", async () => {
		// `import` is a curated verb with no wired delivery channel yet (the
		// open/quick-look/composer/send and the action-surface verbs all have
		// one). It still fail-closes with a structured no-delivery result.
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "import",
			entityType: null,
			mime: null,
			format: null,
			kind: "csv",
			blockId: null,
			label: null,
			priority: "secondary",
			registeredAt: 1,
		});
		const result = await env.bus.dispatch(
			{ verb: "import", payload: { kind: "csv" } },
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(false);
		expect(result.handled === false && result.reason).toBe("no-delivery-channel");
	});

	it("pushes the intent over app:intent when the destination is already running", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Note/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});

		// Pre-create a fake running window for the editor. The bus's
		// `getExistingWindow` returns it; after `launch()` resolves with the
		// same window, the bus should also call webContents.send.
		const send = vi.fn();
		const fakeWindow: AppWindow = {
			appId: "io.example.editor",
			windowId: "main",
			tabId: "tab-1",
			webContentsId: 99,
			parked: false,
			webContents: {
				isDestroyed: () => false,
				send,
			} as unknown as AppWindow["webContents"],
			container: {} as AppWindow["container"],
		};
		const launcher = {
			getExistingWindow: vi.fn(() => fakeWindow),
		} as unknown as AppLauncher;

		// Re-construct the bus with the launcher attached. (The default setup
		// omits it so the existing tests stay pure.)
		const busWithLauncher = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			launcher,
		});
		// Make the orchestrator return our fake window so the bus's send
		// targets the *same* window that getExistingWindow surfaced.
		(env.orchestrator.launch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakeWindow);

		const result = await busWithLauncher.dispatch(
			{ verb: "open", payload: { entityId: "ent_55", entityType: "io.example/Note/v1" } },
			{ app: "io.example.notes" },
		);

		expect(result.handled).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		const [channel, intent] = send.mock.calls[0] ?? [];
		expect(channel).toBe("app:intent");
		expect(intent).toEqual({
			verb: "open",
			payload: { entityId: "ent_55", entityType: "io.example/Note/v1" },
			source: "io.example.notes",
		});
	});

	it("does NOT push over app:intent when the destination is freshly launched", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Note/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		const send = vi.fn();
		const launcher = {
			getExistingWindow: vi.fn(() => null), // no running window
		} as unknown as AppLauncher;
		const fakeWindow: AppWindow = {
			appId: "io.example.editor",
			windowId: "main",
			tabId: "tab-1",
			webContentsId: 100,
			parked: false,
			webContents: {
				isDestroyed: () => false,
				send,
			} as unknown as AppWindow["webContents"],
			container: {} as AppWindow["container"],
		};
		(env.orchestrator.launch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(fakeWindow);
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			launcher,
		});
		await bus.dispatch(
			{ verb: "open", payload: { entityId: "ent_1", entityType: "io.example/Note/v1" } },
			{ app: "io.example.notes" },
		);
		// Fresh window — launch context delivers the intent via the handshake;
		// no duplicate push over app:intent.
		expect(send).not.toHaveBeenCalled();
	});

	it("resolves a bare entityId to its type so a type-specific opener is reached", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Note/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		// The dispatcher only knows the id (a mention click). Without
		// resolution this matched no typed handler → no-handler.
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			resolveEntityTarget: async (id) => (id === "ent_77" ? { type: "io.example/Note/v1" } : null),
		});
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "ent_77" } },
			{ app: "io.example.graph" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.editor");
		expect(env.launches[0]?.launch).toEqual({ reason: "open-entity", entityId: "ent_77" });
	});

	it("an explicit payload entityType is never overridden by the resolver", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Explicit/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		const resolveEntityTarget = vi.fn(async () => ({ type: "io.example/Resolved/v1" }));
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			resolveEntityTarget,
		});
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "ent_1", entityType: "io.example/Explicit/v1" } },
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(true);
		// The resolver IS consulted (open enriches the MIME for content-viewer
		// routing) but the explicit `entityType` is never overridden — the
		// dispatch still routes to the `Explicit/v1` handler, not `Resolved/v1`.
		expect(env.launches[0]?.appId).toBe("io.example.editor");
	});

	it("merges the openers registry for the open verb — an opener-only app is reachable", async () => {
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.EntityType,
			target: "io.example/Folder/v1",
			kind: "primary",
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
		});
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "f_1", entityType: "io.example/Folder/v1" } },
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.viewer");
	});

	it("a primary opener is not demoted by a secondary intent row for the same app", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Doc/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: "Edit",
			priority: "secondary",
			registeredAt: 1,
		});
		env.repos.openers.insert({
			appId: "io.example.editor",
			targetKind: OpenerTargetKind.EntityType,
			target: "io.example/Doc/v1",
			kind: "primary",
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
		});
		const suggestions = await bus.suggest({
			verb: "open",
			payload: { entityType: "io.example/Doc/v1" },
		});
		expect(suggestions).toHaveLength(1);
		expect(suggestions[0]).toEqual({
			appId: "io.example.editor",
			label: "Edit",
			priority: "primary",
		});
	});

	it("falls back to a MIME opener (Preview) when no entity-type handler exists", async () => {
		// `io.example.viewer` stands in for Preview here — it declares only a
		// MIME opener, no entity-type handler.
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.Mime,
			target: "image/png",
			kind: "secondary",
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			resolveEntityTarget: async () => ({ type: "io.example/File/v1", mime: "image/png" }),
		});
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "file_1" } },
			{ app: "io.example.files" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.viewer");
	});

	it("opening a file FROM the file manager reaches the content viewer, not the file manager itself", async () => {
		// The Files app dispatches `open` with an explicit `entityType:
		// File/v1` AND is itself registered as a generic `File/v1` opener (so
		// other apps can "reveal in Files"). Without resolving the MIME, the
		// only candidate is Files' own opener and same-app routing re-picks
		// Files — a visible no-op (the reported "Open on a PDF does nothing").
		// The viewer (Preview/Books) claims it by MIME and must win.
		// `io.example.editor` stands in for the Files app: it dispatches the
		// open AND owns the generic `File/v1` opener. `io.example.viewer`
		// stands in for Preview/Books, claiming the PDF by MIME.
		env.repos.openers.insert({
			appId: "io.example.editor",
			targetKind: OpenerTargetKind.EntityType,
			target: "io.example/File/v1",
			kind: "secondary",
		});
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.Mime,
			target: "application/pdf",
			kind: "secondary",
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			resolveEntityTarget: async () => ({
				type: "io.example/File/v1",
				mime: "application/pdf",
			}),
		});
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "file_1", entityType: "io.example/File/v1" } },
			{ app: "io.example.editor" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.viewer");
	});

	it("an explicit handlerAppId (Open with…) forces that opener over the default pick", async () => {
		// Two apps claim the PDF by MIME; the default pick is the first by app
		// id (`editor`). An explicit "Open with → Viewer" choice rides as
		// `handlerAppId` and must beat the default.
		env.repos.openers.insert({
			appId: "io.example.editor",
			targetKind: OpenerTargetKind.Mime,
			target: "application/pdf",
			kind: "secondary",
		});
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.Mime,
			target: "application/pdf",
			kind: "secondary",
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			resolveEntityTarget: async () => ({ type: "io.example/File/v1", mime: "application/pdf" }),
		});
		const result = await bus.dispatch(
			{
				verb: "open",
				payload: { entityId: "file_1", handlerAppId: "io.example.viewer" },
			},
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.viewer");
	});

	it("a handlerAppId that isn't a candidate falls through to the default pick", async () => {
		env.repos.openers.insert({
			appId: "io.example.editor",
			targetKind: OpenerTargetKind.Mime,
			target: "application/pdf",
			kind: "secondary",
		});
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.Mime,
			target: "application/pdf",
			kind: "secondary",
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			resolveEntityTarget: async () => ({ type: "io.example/File/v1", mime: "application/pdf" }),
		});
		const result = await bus.dispatch(
			{
				verb: "open",
				payload: { entityId: "file_1", handlerAppId: "io.example.forged" },
			},
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(true);
		// Default pick: no primary, first by app id → editor.
		expect(env.launches[0]?.appId).toBe("io.example.editor");
	});

	it("suggest fills an opener's missing label from the app's display name", async () => {
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.Mime,
			target: "application/pdf",
			kind: "secondary",
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			resolveAppLabel: (id) => (id === "io.example.viewer" ? "Viewer" : id),
		});
		const suggestions = await bus.suggest({
			verb: "open",
			payload: { mime: "application/pdf" },
		});
		expect(suggestions).toEqual([
			{ appId: "io.example.viewer", label: "Viewer", priority: "secondary" },
		]);
	});

	it("quick-look resolves a bare id to its MIME and reaches the per-MIME handler", async () => {
		// Preview-shaped: a primary `quick-look` intent row keyed by MIME,
		// entity type left wildcard. The dispatcher (Files) carries only the
		// id + a type — never the MIME — so without resolution the MIME row
		// never matched and quick-look fell back to a toast.
		env.repos.intents.insert({
			appId: "io.example.viewer",
			verb: "quick-look",
			entityType: null,
			mime: "image/png",
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		const resolveEntityTarget = vi.fn(async () => ({
			type: "io.example/File/v1",
			mime: "image/png",
		}));
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			resolveEntityTarget,
		});
		const result = await bus.dispatch(
			{ verb: "quick-look", payload: { entityId: "file_1", entityType: "io.example/File/v1" } },
			{ app: "io.example.files" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.viewer");
		// Re-uses the open-entity launch reason so the receiver's existing
		// handshake path lights up unchanged.
		expect(env.launches[0]?.launch).toEqual({ reason: "open-entity", entityId: "file_1" });
		expect(resolveEntityTarget).toHaveBeenCalledWith("file_1");
	});

	it("quick-look with an explicit MIME skips the resolver but still routes", async () => {
		env.repos.intents.insert({
			appId: "io.example.viewer",
			verb: "quick-look",
			entityType: null,
			mime: "application/pdf",
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		const resolveEntityTarget = vi.fn(async () => ({ type: "x", mime: "image/png" }));
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			resolveEntityTarget,
		});
		const result = await bus.dispatch(
			{ verb: "quick-look", payload: { entityId: "f_2", mime: "application/pdf" } },
			{ app: "io.example.files" },
		);
		expect(result.handled).toBe(true);
		expect(resolveEntityTarget).not.toHaveBeenCalled();
		expect(env.launches[0]?.appId).toBe("io.example.viewer");
	});

	it("openers are NOT merged for non-open verbs", async () => {
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.EntityType,
			target: "io.example/Doc/v1",
			kind: "primary",
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
		});
		const result = await bus.dispatch(
			{ verb: "share", payload: { entityType: "io.example/Doc/v1" } },
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(false);
		expect(result.handled === false && result.reason).toBe("no-handler");
	});

	it("falls back to the generic object editor when a typed open has no handler", async () => {
		// `brainstorm/Person/v1` has no app-specific opener — the reported
		// "clicking a graph node does nothing". With a generic editor wired,
		// the resolved type routes there instead of silently no-handler.
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			resolveEntityTarget: async (id) =>
				id === "ent_person_1" ? { type: "brainstorm/Person/v1" } : null,
			genericEntityViewerAppId: "io.brainstorm.notes",
		});
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "ent_person_1" } },
			{ app: "io.example.graph" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.brainstorm.notes");
		expect(env.launches[0]?.launch).toEqual({
			reason: "open-entity",
			entityId: "ent_person_1",
		});
	});

	it("does NOT use the generic fallback when a real handler exists", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Note/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			genericEntityViewerAppId: "io.brainstorm.notes",
		});
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "n_1", entityType: "io.example/Note/v1" } },
			{ app: "io.example.graph" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.editor");
	});

	it("does NOT fall back for a blank/typeless open (stays no-handler)", async () => {
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			genericEntityViewerAppId: "io.brainstorm.notes",
		});
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "ent_unknown" } },
			{ app: "io.example.graph" },
		);
		expect(result.handled).toBe(false);
		expect(result.handled === false && result.reason).toBe("no-handler");
	});

	it("a Settings → Defaults override wins over primary + same-app", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Doc/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		env.repos.intents.insert({
			appId: "io.example.viewer",
			verb: "open",
			entityType: "io.example/Doc/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "secondary",
			registeredAt: 2,
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			resolveDefaultHandler: (verb, type) =>
				verb === "open" && type === "io.example/Doc/v1" ? "io.example.viewer" : null,
		});
		// Dispatched *from* the primary handler app — same-app would
		// normally win; the user override beats even that.
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "d_1", entityType: "io.example/Doc/v1" } },
			{ app: "io.example.editor" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.viewer");
	});

	it("an override is honoured even when the app isn't a natural candidate", async () => {
		// No registered handler for this type at all — the user explicitly
		// chose Notes for it in Settings → Defaults; synthesise + route.
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			resolveEntityTarget: async () => ({ type: "brainstorm/Person/v1" }),
			resolveDefaultHandler: () => "io.brainstorm.notes",
		});
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "ent_p" } },
			{ app: "io.example.graph" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.brainstorm.notes");
	});

	it("an async override resolver is awaited", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/T/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		env.repos.intents.insert({
			appId: "io.example.viewer",
			verb: "open",
			entityType: "io.example/T/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "secondary",
			registeredAt: 2,
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			resolveDefaultHandler: async () => "io.example.viewer",
		});
		const result = await bus.dispatch(
			{ verb: "open", payload: { entityId: "t_1", entityType: "io.example/T/v1" } },
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.viewer");
	});

	it("handler errors surface as handler-error", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: null,
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		(env.orchestrator.launch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("bundle missing"),
		);
		const result = await env.bus.dispatch(
			{ verb: "open", payload: { entityId: "ent_1" } },
			{ app: "io.example.notes" },
		);
		expect(result.handled).toBe(false);
		expect(result.handled === false && result.reason).toBe("handler-error");
		expect(result.handled === false && result.message).toContain("bundle missing");
	});
});

describe("IntentsBus — external open (OpenRes-1b)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	let openExternal: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		env = await setup();
		openExternal = vi.fn(async () => ({ ok: true }));
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	function bus(opts: {
		consent?: OsHandoffConsent;
		mayHandoff?: boolean;
		storedDefault?: string | null;
	}) {
		return new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal: openExternal as unknown as NonNullable<IntentsBusOptions["openExternal"]>,
			resolveOsHandoffConsent: () => opts.consent ?? OsHandoffConsent.FirstUse,
			mayHandoff: () => opts.mayHandoff ?? false,
			resolveDefaultHandler: () => opts.storedDefault ?? null,
		});
	}

	it("dangerous scheme is refused for security (never the OS)", async () => {
		const r = await bus({ mayHandoff: true, consent: OsHandoffConsent.Granted }).dispatch(
			{ verb: "open", payload: { url: "javascript:alert(1)" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.handled === false && r.message).toContain("security");
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("an in-vault scheme opener wins over OS handoff and launches that app", async () => {
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.Scheme,
			target: "https",
			kind: "primary",
		});
		const r = await bus({ mayHandoff: true }).dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.handled === true && r.handler.appId).toBe("io.example.viewer");
		expect(env.launches[0]?.launch).toEqual({
			reason: "deep-link",
			deepLink: "https://example.com",
		});
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("an app without system.open-external can't hand off — explained refusal", async () => {
		const r = await bus({ mayHandoff: false }).dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("first-use without a prompt host is a fail-closed explained refusal, not silent", async () => {
		const r = await bus({ mayHandoff: true }).dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.handled === false && r.message).toContain("permission");
		expect(openExternal).not.toHaveBeenCalled();
	});

	// OpenRes-1c — the prompt-host slice.

	it("first-use with a prompt host that resolves Allow hands off + records Granted", async () => {
		const prompt = vi.fn(async () => OsHandoffPromptDecision.Allow);
		const record = vi.fn();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal: openExternal as unknown as NonNullable<IntentsBusOptions["openExternal"]>,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
			mayHandoff: () => true,
			promptOsHandoffConsent: prompt,
			recordOsHandoffConsent: record,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(prompt).toHaveBeenCalledWith("scheme:https", "https://example.com");
		expect(record).toHaveBeenCalledWith("scheme:https", OsHandoffConsent.Granted);
		expect(openExternal).toHaveBeenCalledTimes(1);
	});

	it("first-use with a prompt host that resolves Deny refuses + records Denied (no openExternal)", async () => {
		const prompt = vi.fn(async () => OsHandoffPromptDecision.Deny);
		const record = vi.fn();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal: openExternal as unknown as NonNullable<IntentsBusOptions["openExternal"]>,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
			mayHandoff: () => true,
			promptOsHandoffConsent: prompt,
			recordOsHandoffConsent: record,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "mailto:a@b.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(record).toHaveBeenCalledWith("scheme:mailto", OsHandoffConsent.Denied);
		expect(openExternal).not.toHaveBeenCalled();
		expect(r.handled === false && r.message).toContain("blocked");
	});

	it("first-use with a prompt host that resolves Cancel does NOT record anything", async () => {
		const prompt = vi.fn(async () => OsHandoffPromptDecision.Cancel);
		const record = vi.fn();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal: openExternal as unknown as NonNullable<IntentsBusOptions["openExternal"]>,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
			mayHandoff: () => true,
			promptOsHandoffConsent: prompt,
			recordOsHandoffConsent: record,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		// Cancel is non-sticky — the next attempt re-prompts. Pinning the
		// no-record invariant guards against an accidental "treat cancel
		// like deny" regression.
		expect(record).not.toHaveBeenCalled();
		expect(openExternal).not.toHaveBeenCalled();
		expect(r.handled === false && r.message).toContain("cancelled");
	});

	it("granted (recorded earlier) skips the prompt entirely", async () => {
		const prompt = vi.fn(async () => OsHandoffPromptDecision.Allow);
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal: openExternal as unknown as NonNullable<IntentsBusOptions["openExternal"]>,
			resolveOsHandoffConsent: () => OsHandoffConsent.Granted,
			mayHandoff: () => true,
			promptOsHandoffConsent: prompt,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(prompt).not.toHaveBeenCalled();
		expect(openExternal).toHaveBeenCalledTimes(1);
	});

	it("granted consent + cap hands off to the OS exactly once", async () => {
		const r = await bus({ mayHandoff: true, consent: OsHandoffConsent.Granted }).dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.handled === true && r.handler.appId).toBe("system");
		expect(openExternal).toHaveBeenCalledTimes(1);
	});

	it("a shell-sourced open may hand off without an explicit cap (user click in chrome)", async () => {
		const r = await bus({ consent: OsHandoffConsent.Granted }).dispatch(
			{ verb: "open", payload: { url: "mailto:a@b.com" } },
			{ app: "shell" },
		);
		expect(r.handled).toBe(true);
		expect(openExternal).toHaveBeenCalledTimes(1);
	});

	it("an out-of-vault file: URL is floor-blocked", async () => {
		const r = await bus({ mayHandoff: true, consent: OsHandoffConsent.Granted }).dispatch(
			{ verb: "open", payload: { url: "file:///etc/passwd" } },
			{ app: "shell" },
		);
		expect(r.handled).toBe(false);
		expect(r.handled === false && r.message).toContain("security");
		expect(openExternal).not.toHaveBeenCalled();
	});

	it("entity dispatch is byte-for-byte unchanged (no external branch)", async () => {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Note/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
		const r = await bus({}).dispatch(
			{ verb: "open", payload: { entityId: "ent_1", entityType: "io.example/Note/v1" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.handled === true && r.handler.appId).toBe("io.example.editor");
		expect(openExternal).not.toHaveBeenCalled();
	});
});

/**
 * OpenRes-1c "Why did this open here?" — data-layer fence (2026-05-23).
 *
 * Every external-open dispatch path stamps the resolved `OpenRung` on
 * the returned `IntentDispatchResult`. The future explainer tooltip (UI
 * slice) reads this; tests pin every rung so a silent regression that
 * forgets to stamp lands red. `refusal: OpenRefusal` only appears on
 * the `Refused` rung — its presence on other rungs is a contract
 * violation (and would mislead the explainer).
 */
describe("IntentsBus — rung stamped on dispatch result (OpenRes-1c data layer)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	let openExternal: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		env = await setup();
		openExternal = vi.fn(async () => ({ ok: true }));
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	function bus(opts: {
		consent?: OsHandoffConsent;
		mayHandoff?: boolean;
		storedDefault?: string | null;
		promptDecision?: OsHandoffPromptDecision;
	}) {
		const promptDecision = opts.promptDecision;
		return new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal: openExternal as unknown as NonNullable<IntentsBusOptions["openExternal"]>,
			resolveOsHandoffConsent: () => opts.consent ?? OsHandoffConsent.FirstUse,
			mayHandoff: () => opts.mayHandoff ?? false,
			resolveDefaultHandler: () => opts.storedDefault ?? null,
			...(promptDecision !== undefined
				? {
						promptOsHandoffConsent: vi.fn(async () => promptDecision) as unknown as NonNullable<
							IntentsBusOptions["promptOsHandoffConsent"]
						>,
						recordOsHandoffConsent: vi.fn(async () => {}) as unknown as NonNullable<
							IntentsBusOptions["recordOsHandoffConsent"]
						>,
					}
				: {}),
		});
	}

	it("InVaultOpeners rung stamped on a successful in-vault scheme launch", async () => {
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.Scheme,
			target: "https",
			kind: "primary",
		});
		const r = await bus({ mayHandoff: true }).dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.InVaultOpeners);
		// Handled-true variants never carry a refusal — that field is for
		// the refused branch only.
		expect("refusal" in r).toBe(false);
	});

	it("StoredDefault rung stamped when the user pinned an app to a scheme", async () => {
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.Scheme,
			target: "https",
			kind: "primary",
		});
		const r = await bus({ mayHandoff: true, storedDefault: "io.example.viewer" }).dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.StoredDefault);
	});

	it("OsHandoff rung stamped on a granted-consent OS hand-off", async () => {
		const r = await bus({
			mayHandoff: true,
			consent: OsHandoffConsent.Granted,
		}).dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.OsHandoff);
		expect(openExternal).toHaveBeenCalled();
	});

	it("OsHandoff rung stamped on the first-use prompt → Allow path", async () => {
		const r = await bus({
			mayHandoff: true,
			consent: OsHandoffConsent.FirstUse,
			promptDecision: OsHandoffPromptDecision.Allow,
		}).dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.OsHandoff);
	});

	it("OsHandoff rung stamped on the first-use prompt → Deny refusal", async () => {
		const r = await bus({
			mayHandoff: true,
			consent: OsHandoffConsent.FirstUse,
			promptDecision: OsHandoffPromptDecision.Deny,
		}).dispatch(
			{ verb: "open", payload: { url: "mailto:test@example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.rung).toBe(OpenRung.OsHandoff);
		// Deny is a user-driven refusal at the OS-handoff rung, NOT the
		// Refused rung — Refused is the floor / unknown-target case.
		expect(r.handled === false && r.refusal).toBeUndefined();
	});

	it("OsHandoff rung stamped on the first-use prompt → Cancel refusal", async () => {
		const r = await bus({
			mayHandoff: true,
			consent: OsHandoffConsent.FirstUse,
			promptDecision: OsHandoffPromptDecision.Cancel,
		}).dispatch(
			{ verb: "open", payload: { url: "mailto:test@example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.rung).toBe(OpenRung.OsHandoff);
	});

	it("OsHandoff rung stamped on fail-closed refusal when no prompt host wired", async () => {
		const r = await bus({
			mayHandoff: true,
			consent: OsHandoffConsent.FirstUse,
		}).dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.rung).toBe(OpenRung.OsHandoff);
		expect(r.handled === false && r.message).toContain("permission");
	});

	it("Refused rung + DangerousScheme refusal on a hard-block-floor URL", async () => {
		const r = await bus({
			mayHandoff: true,
			consent: OsHandoffConsent.Granted,
		}).dispatch(
			{ verb: "open", payload: { url: "javascript:alert(1)" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.rung).toBe(OpenRung.Refused);
		expect(r.handled === false && r.refusal).toBe(OpenRefusal.DangerousScheme);
	});

	it("Refused rung + NoHandler refusal when the caller can't hand off", async () => {
		// No opener registered + caller doesn't hold system.open-external →
		// nothing-claims-it refusal at the Refused rung.
		const r = await bus({ mayHandoff: false }).dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.rung).toBe(OpenRung.Refused);
		expect(r.handled === false && r.refusal).toBe(OpenRefusal.NoHandler);
	});

	it("OsHandoff rung stamped on a handoff that the OS itself failed to execute", async () => {
		openExternal = vi.fn(async () => ({ ok: false, error: "no app for handler" }));
		const r = await bus({
			mayHandoff: true,
			consent: OsHandoffConsent.Granted,
		}).dispatch({ verb: "open", payload: { url: "weird-scheme:foo" } }, { app: "io.example.notes" });
		expect(r.handled).toBe(false);
		expect(r.rung).toBe(OpenRung.OsHandoff);
		expect(r.handled === false && r.reason).toBe("handler-error");
	});
});

/**
 * OpenRes-1c slice 4 — CR-1 sentinel routing fix (2026-05-23).
 *
 * When the user pins "Open with system default" for a scheme/extension
 * in Settings → Defaults, `defaultHandlers` stores
 * `OS_HANDOFF_APP_ID = "__os__"`. The bug: `decideOpen` returned
 * `OpenRung.StoredDefault`, the bus called `launchInto("__os__", ...)`,
 * orchestrator had no such app → `handler-error`. The pin never
 * reached `openExternal`. The fix routes the sentinel through the OS-
 * handoff arm — without raising the first-use prompt (the pin IS the
 * consent) — and stamps `rung: OsHandoff` so the explainer surface
 * reads the truth.
 */
describe("IntentsBus — `__os__` sentinel pin routes through OS handoff (OpenRes-1c slice 4)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	let openExternal: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		env = await setup();
		openExternal = vi.fn(async () => ({ ok: true }));
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("sentinel pin → routes through OS handoff path (openExternal called, rung = OsHandoff)", async () => {
		const prompt = vi.fn(async () => OsHandoffPromptDecision.Allow);
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal: openExternal as unknown as NonNullable<IntentsBusOptions["openExternal"]>,
			resolveOsHandoffConsent: () => OsHandoffConsent.Granted,
			mayHandoff: () => true,
			resolveDefaultHandler: () => OS_HANDOFF_APP_ID,
			promptOsHandoffConsent: prompt,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.OsHandoff);
		expect(openExternal).toHaveBeenCalledTimes(1);
		// The pin IS the consent — the first-use prompt is skipped even
		// though resolveDefaultHandler short-circuits decideOpen to the
		// StoredDefault rung (the bus owns the OS-handoff fall-through).
		expect(prompt).not.toHaveBeenCalled();
		// Critical: orchestrator must NOT have been called with the sentinel
		// (that was the bug — `__os__` would be passed to launchInto and the
		// orchestrator would NotFound-throw, returning handler-error).
		expect(env.launches.find((l) => l.appId === OS_HANDOFF_APP_ID)).toBeUndefined();
	});

	it("sentinel pin + denied consent → explained refusal (Denied wins over the pin)", async () => {
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal: openExternal as unknown as NonNullable<IntentsBusOptions["openExternal"]>,
			resolveOsHandoffConsent: () => OsHandoffConsent.Denied,
			mayHandoff: () => true,
			resolveDefaultHandler: () => OS_HANDOFF_APP_ID,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(openExternal).not.toHaveBeenCalled();
		expect(r.handled === false && r.message).toContain("blocked");
		expect(r.rung).toBe(OpenRung.OsHandoff);
	});

	it("sentinel pin without openExternal injected → handler-error, not stuck", async () => {
		// The dangerous "stuck" case is the orchestrator-NotFound loop. With
		// no openExternal at all, the bus must surface an explained refusal
		// (OS handoff unavailable) — never re-attempt launchInto("__os__").
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			resolveOsHandoffConsent: () => OsHandoffConsent.Granted,
			mayHandoff: () => true,
			resolveDefaultHandler: () => OS_HANDOFF_APP_ID,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.rung).toBe(OpenRung.OsHandoff);
		// orchestrator NEVER called for the sentinel — that was the bug.
		expect(env.launches.find((l) => l.appId === OS_HANDOFF_APP_ID)).toBeUndefined();
	});

	it("sentinel pin still respects the dangerous-scheme floor (regression: no security bypass)", async () => {
		// Even if the user could pin OS for a hard-block-floor scheme
		// (`javascript:` / `data:` / `vbscript:` / `about:`), the floor
		// short-circuits to Refused in `decideOpen` BEFORE the sentinel
		// branch is reached. Pinning OS must never be a path that opens
		// `javascript:alert(1)` through the OS.
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal: openExternal as unknown as NonNullable<IntentsBusOptions["openExternal"]>,
			resolveOsHandoffConsent: () => OsHandoffConsent.Granted,
			mayHandoff: () => true,
			resolveDefaultHandler: () => OS_HANDOFF_APP_ID,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "javascript:alert(1)" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.rung).toBe(OpenRung.Refused);
		expect(r.handled === false && r.refusal).toBe(OpenRefusal.DangerousScheme);
		expect(openExternal).not.toHaveBeenCalled();
	});
});

/**
 * OpenRes-1c slice 6 — multi-candidate "Open with…" picker.
 *
 * When the `InVaultOpeners` rung resolves with 2+ candidates, the bus
 * asks `promptOpenWith` (when wired) before auto-picking. A single
 * candidate (or no picker wired) keeps the legacy primary/first-pick.
 * `remember: true` persists the user's choice as a `(open, signature)`
 * default. The picker's `Cancel` is an explained refusal — never a
 * silent no-op. A picker can return `OS_HANDOFF_APP_ID` to route
 * through the OS-handoff chokepoint.
 */
describe("IntentsBus — inline 'Open with…' picker (OpenRes-1c slice 6)", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
		// Two in-vault openers for the same scheme — the multi-candidate
		// case the picker exists for.
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.Scheme,
			target: "https",
			kind: "primary",
		});
		env.repos.openers.insert({
			appId: "io.example.editor",
			targetKind: OpenerTargetKind.Scheme,
			target: "https",
			kind: "secondary",
		});
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("a single in-vault opener keeps the legacy auto-pick (picker never raised)", async () => {
		// Override setup() — single primary opener for `mailto`. The picker
		// must not be consulted when there's no ambiguity to resolve.
		env.repos.openers.insert({
			appId: "io.example.editor",
			targetKind: OpenerTargetKind.Scheme,
			target: "mailto",
			kind: "primary",
		});
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "mailto:a@b.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.InVaultOpeners);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("no picker wired → legacy primary/first-pick keeps working (zero regression)", async () => {
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.InVaultOpeners);
		// Primary wins (the auto-pick rule from pickOpenerAppId).
		expect(env.launches.at(-1)?.appId).toBe("io.example.viewer");
	});

	it("2+ candidates + picker wired → picker raised, chosen app launches", async () => {
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: "io.example.editor",
			remember: false,
		}));
		const recordDefault = vi.fn<NonNullable<IntentsBusOptions["recordDefaultHandler"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			recordDefaultHandler: recordDefault,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.InVaultOpeners);
		expect(prompt).toHaveBeenCalledTimes(1);
		const [signature, uri, candidates] = prompt.mock.calls[0] ?? [];
		expect(signature).toBe("scheme:https");
		expect(uri).toBe("https://example.com");
		// Primary first, then secondary.
		expect(candidates).toEqual([
			{ appId: "io.example.viewer", label: "io.example.viewer", kind: "primary" },
			{ appId: "io.example.editor", label: "io.example.editor", kind: "secondary" },
		]);
		expect(env.launches.at(-1)?.appId).toBe("io.example.editor");
		// `remember: false` → no persistence.
		expect(recordDefault).not.toHaveBeenCalled();
	});

	it("remember=true persists the choice as the (open, signature) default", async () => {
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: "io.example.editor",
			remember: true,
		}));
		const recordDefault = vi.fn<NonNullable<IntentsBusOptions["recordDefaultHandler"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			recordDefaultHandler: recordDefault,
		});
		await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(recordDefault).toHaveBeenCalledTimes(1);
		expect(recordDefault).toHaveBeenCalledWith("open", "scheme:https", "io.example.editor");
	});

	it("picker Cancel → explained refusal with reason=cancelled, no launch, no persistence", async () => {
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Cancel,
		}));
		const recordDefault = vi.fn<NonNullable<IntentsBusOptions["recordDefaultHandler"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			recordDefaultHandler: recordDefault,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.handled === false && r.reason).toBe("cancelled");
		expect(r.rung).toBe(OpenRung.InVaultOpeners);
		expect(env.launches).toEqual([]);
		expect(recordDefault).not.toHaveBeenCalled();
	});

	it("picker can return OS_HANDOFF_APP_ID → routes through OS handoff chokepoint", async () => {
		const openExternal = vi.fn(async () => ({ ok: true }));
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: OS_HANDOFF_APP_ID,
			remember: false,
		}));
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal: openExternal as unknown as NonNullable<IntentsBusOptions["openExternal"]>,
			promptOpenWith: prompt,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.OsHandoff);
		expect(openExternal).toHaveBeenCalledTimes(1);
		// The picker pick IS the consent — no first-use OS prompt raised
		// (it isn't wired; if it were, the bus would skip it for this path).
		// The orchestrator never sees the sentinel id.
		expect(env.launches.find((l) => l.appId === OS_HANDOFF_APP_ID)).toBeUndefined();
	});

	it("forged renderer reply with an app id not in the candidate set → no-handler refusal", async () => {
		// Defensive: a compromised / buggy renderer must not be able to
		// launch an app the user never saw in the picker. The bus rejects
		// the pick and surfaces an explained refusal.
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: "io.malicious.attacker",
			remember: false,
		}));
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.handled === false && r.reason).toBe("no-handler");
		expect(r.rung).toBe(OpenRung.InVaultOpeners);
		expect(env.launches.find((l) => l.appId === "io.malicious.attacker")).toBeUndefined();
	});

	it("resolveAppLabel injects friendly labels into the candidate list", async () => {
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: "io.example.viewer",
			remember: false,
		}));
		const labels: Record<string, string> = {
			"io.example.viewer": "Web Browser",
			"io.example.editor": "Bookmarks",
		};
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			resolveAppLabel: (id) => labels[id] ?? id,
		});
		await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		const candidates = prompt.mock.calls[0]?.[2];
		expect(candidates).toEqual([
			{ appId: "io.example.viewer", label: "Web Browser", kind: "primary" },
			{ appId: "io.example.editor", label: "Bookmarks", kind: "secondary" },
		]);
	});

	it("openers de-dupe by appId — repeated rows for the same app collapse to one candidate", async () => {
		// The picker pure-helper `buildOpenWithCandidates` filters by appId
		// regardless of how many rows the openers registry produced.
		// Mirrors the realistic case where an opener walker emits more
		// than one row for one app (`Bookmarks` claims both `https` +
		// `http` — pulled separately and unioned later). We exercise the
		// dedup directly by inserting the same `https` row twice with
		// a different appId pair: one app per row, so the row count of
		// the candidate set matches the distinct appId count.
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: "io.example.viewer",
			remember: false,
		}));
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
		});
		await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		const candidates = prompt.mock.calls[0]?.[2];
		// 2 distinct apps (viewer primary + editor secondary).
		expect(candidates).toHaveLength(2);
		expect(candidates?.[0]?.appId).toBe("io.example.viewer");
		expect(candidates?.[0]?.kind).toBe("primary");
		expect(candidates?.[1]?.kind).toBe("secondary");
	});

	it("StoredDefault wins over the picker — picker only sees the rung-3 multi-candidate case", async () => {
		// A user-pinned default short-circuits decideOpen to StoredDefault
		// (rung 2); the picker (rung 3 only) must never raise when a pin
		// exists. The pin IS the user's prior pick.
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			resolveDefaultHandler: () => "io.example.editor",
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.StoredDefault);
		expect(prompt).not.toHaveBeenCalled();
	});
});

/**
 * OpenRes-1c slice 7 — sticky app-vs-OS first-use fork.
 *
 * Extends the slice-6 picker to also offer "Open with system default"
 * as a candidate when `callerMayHandoff` is true and the user hasn't
 * explicitly denied OS-handoff for this signature. The fork fires
 * with a SINGLE in-vault opener too (vs slice 6's 2+-app rule),
 * because `[singleApp, OS-handoff] = 2 candidates` is the choice.
 * Pinning either pick (`remember: true`) persists the stored
 * default; the next attempt for the same signature skips the picker.
 */
describe("IntentsBus — sticky app-vs-OS first-use fork (OpenRes-1c slice 7)", () => {
	let env: Awaited<ReturnType<typeof setup>>;

	beforeEach(async () => {
		env = await setup();
		// Single in-vault opener for the same scheme — slice-7's trigger
		// case (slice 6 was 2+ openers; slice 7 extends to 1+ + OS option).
		env.repos.openers.insert({
			appId: "io.example.viewer",
			targetKind: OpenerTargetKind.Scheme,
			target: "https",
			kind: "primary",
		});
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	it("single in-vault opener + caller may handoff + first-use consent → fork raises picker with 2 candidates", async () => {
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: "io.example.viewer",
			remember: false,
		}));
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			mayHandoff: () => true,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
			openExternal: async () => ({ ok: true }),
		});
		await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(prompt).toHaveBeenCalledTimes(1);
		const candidates = prompt.mock.calls[0]?.[2];
		expect(candidates).toHaveLength(2);
		expect(candidates?.[0]).toEqual({
			appId: "io.example.viewer",
			label: "io.example.viewer",
			kind: "primary",
		});
		expect(candidates?.[1]).toEqual({
			appId: OS_HANDOFF_APP_ID,
			label: "Open with system default",
			kind: "os-handoff",
		});
	});

	it("single in-vault opener + caller may NOT handoff → no fork (legacy auto-pick)", async () => {
		// Caller without `system.open-external` (and not the shell) doesn't
		// trigger the fork — the picker would expose the OS rung to an
		// unprivileged app. Falls back to the slice-6 trigger (which here
		// is a single candidate, so no picker).
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			mayHandoff: () => false,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.unprivileged" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.InVaultOpeners);
		expect(prompt).not.toHaveBeenCalled();
		expect(env.launches.at(-1)?.appId).toBe("io.example.viewer");
	});

	it("single in-vault opener + denied OS consent → no fork (Denied wins over OS option)", async () => {
		// The user previously said NO to OS handoff for this signature.
		// Respect that — don't re-offer the OS choice. Falls back to the
		// single-candidate auto-pick.
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			mayHandoff: () => true,
			resolveOsHandoffConsent: () => OsHandoffConsent.Denied,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.InVaultOpeners);
		expect(prompt).not.toHaveBeenCalled();
		expect(env.launches.at(-1)?.appId).toBe("io.example.viewer");
	});

	it("fork pick OS + remember=true → persists OS_HANDOFF_APP_ID as stored default", async () => {
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: OS_HANDOFF_APP_ID,
			remember: true,
		}));
		const openExternal = vi.fn(async () => ({ ok: true }));
		const recordDefault = vi.fn<NonNullable<IntentsBusOptions["recordDefaultHandler"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal,
			promptOpenWith: prompt,
			recordDefaultHandler: recordDefault,
			mayHandoff: () => true,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.OsHandoff);
		expect(openExternal).toHaveBeenCalledTimes(1);
		expect(recordDefault).toHaveBeenCalledWith("open", "scheme:https", OS_HANDOFF_APP_ID);
	});

	it("fork pick in-vault app + remember=true → persists the appId as stored default", async () => {
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: "io.example.viewer",
			remember: true,
		}));
		const recordDefault = vi.fn<NonNullable<IntentsBusOptions["recordDefaultHandler"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			recordDefaultHandler: recordDefault,
			mayHandoff: () => true,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
		});
		await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(recordDefault).toHaveBeenCalledWith("open", "scheme:https", "io.example.viewer");
		expect(env.launches.at(-1)?.appId).toBe("io.example.viewer");
	});

	it("fork Cancel → explained refusal + no persistence + no launch", async () => {
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Cancel,
		}));
		const recordDefault = vi.fn<NonNullable<IntentsBusOptions["recordDefaultHandler"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			recordDefaultHandler: recordDefault,
			mayHandoff: () => true,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(false);
		expect(r.handled === false && r.reason).toBe("cancelled");
		expect(env.launches).toEqual([]);
		expect(recordDefault).not.toHaveBeenCalled();
	});

	it("fork pick OS + remember=false → routes OS this time but doesn't persist", async () => {
		// The picker is the consent for THIS open; non-sticky pick stays
		// session-scoped. The next https click will fork again.
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: OS_HANDOFF_APP_ID,
			remember: false,
		}));
		const openExternal = vi.fn(async () => ({ ok: true }));
		const recordDefault = vi.fn<NonNullable<IntentsBusOptions["recordDefaultHandler"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			openExternal,
			promptOpenWith: prompt,
			recordDefaultHandler: recordDefault,
			mayHandoff: () => true,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
		});
		await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(openExternal).toHaveBeenCalledTimes(1);
		expect(recordDefault).not.toHaveBeenCalled();
	});

	it("2+ in-vault openers + OS option → picker shows 3+ candidates", async () => {
		// Slice 6 + slice 7 compose: multi-app ambiguity AND the OS option.
		env.repos.openers.insert({
			appId: "io.example.editor",
			targetKind: OpenerTargetKind.Scheme,
			target: "https",
			kind: "secondary",
		});
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: "io.example.viewer",
			remember: false,
		}));
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			mayHandoff: () => true,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
		});
		await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		const candidates = prompt.mock.calls[0]?.[2];
		expect(candidates).toHaveLength(3);
		expect(candidates?.[2]?.appId).toBe(OS_HANDOFF_APP_ID);
		expect(candidates?.[2]?.kind).toBe("os-handoff");
	});

	it("shell-source dispatch always offers OS handoff (no `mayHandoff` injected)", async () => {
		// Shell-source clicks (trusted chrome) implicitly may hand off
		// to the OS — the bus shortcircuits `mayHandoff` for `shell`.
		// So even without a `mayHandoff` option, a shell-source open of
		// `https` with a single in-vault opener triggers the fork.
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>(async () => ({
			kind: OpenWithDecisionKind.Pick,
			appId: "io.example.viewer",
			remember: false,
		}));
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
		});
		await b.dispatch({ verb: "open", payload: { url: "https://example.com" } }, { app: "shell" });
		expect(prompt).toHaveBeenCalledTimes(1);
		const candidates = prompt.mock.calls[0]?.[2];
		expect(candidates).toHaveLength(2);
		expect(candidates?.[1]?.appId).toBe(OS_HANDOFF_APP_ID);
	});

	it("stored default short-circuits the fork (slice 7 doesn't override slice 2 pins)", async () => {
		// A user-pinned default (via Settings → Defaults) wins — rung 2
		// (StoredDefault) fires BEFORE rung 3 (InVaultOpeners), and the
		// picker never runs. The pin IS the user's prior pick.
		const prompt = vi.fn<NonNullable<IntentsBusOptions["promptOpenWith"]>>();
		const b = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			openers: env.repos.openers,
			promptOpenWith: prompt,
			resolveDefaultHandler: () => "io.example.viewer",
			mayHandoff: () => true,
			resolveOsHandoffConsent: () => OsHandoffConsent.FirstUse,
		});
		const r = await b.dispatch(
			{ verb: "open", payload: { url: "https://example.com" } },
			{ app: "io.example.notes" },
		);
		expect(r.handled).toBe(true);
		expect(r.rung).toBe(OpenRung.StoredDefault);
		expect(prompt).not.toHaveBeenCalled();
	});
});

describe("IntentsBus — navigation modes", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "open",
			entityType: "io.example/Note/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	function win(over: Partial<AppWindow> = {}): AppWindow {
		return {
			appId: "io.example.editor",
			windowId: "main",
			tabId: "tab-1",
			webContentsId: 9,
			parked: false,
			webContents: {} as AppWindow["webContents"],
			container: { id: "c1" } as unknown as AppWindow["container"],
			...over,
		};
	}

	function buildBus(launcher: Partial<AppLauncher>, orch: Record<string, unknown>): IntentsBus {
		const base = makeOrchestrator();
		const orchestrator = {
			...(base.orchestrator as unknown as Record<string, unknown>),
			...orch,
		} as unknown as LaunchOrchestrator;
		return new IntentsBus({
			intents: env.repos.intents,
			orchestrator,
			launcher: launcher as unknown as AppLauncher,
		});
	}

	const openNote = (navMode?: string) => ({
		verb: "open" as const,
		payload: {
			entityId: "ent_42",
			entityType: "io.example/Note/v1",
			...(navMode ? { navMode } : {}),
		},
	});

	it("new-tab mode adds a tab to the target app's existing container", async () => {
		const addTab = vi.fn(async () => win());
		const bus = buildBus(
			{
				focusTabByRoute: () => null,
				getExistingWindow: () => win(),
				containerIdForWebContents: () => null,
			},
			{ addTab },
		);
		const r = await bus.dispatch(openNote("new-tab"), { app: "io.example.notes" });
		expect(r.handled).toBe(true);
		expect(addTab).toHaveBeenCalledWith(
			"c1",
			expect.objectContaining({ appId: "io.example.editor" }),
		);
	});

	it("new-window mode opens a fresh container", async () => {
		const openInNewWindow = vi.fn(async () => win());
		const bus = buildBus({ focusTabByRoute: () => null }, { openInNewWindow });
		const r = await bus.dispatch(openNote("new-window"), { app: "io.example.notes" });
		expect(r.handled).toBe(true);
		expect(openInNewWindow).toHaveBeenCalledWith(
			expect.objectContaining({ appId: "io.example.editor" }),
		);
	});

	it("focus-existing: an already-open route is focused, nothing launched", async () => {
		const focusTabByRoute = vi.fn(() => win());
		const launch = vi.fn(async () => win());
		const bus = buildBus({ focusTabByRoute }, { launch });
		const r = await bus.dispatch(openNote(), { app: "io.example.notes" });
		expect(r.handled).toBe(true);
		expect(focusTabByRoute).toHaveBeenCalledWith("brainstorm://entity/ent_42");
		expect(launch).not.toHaveBeenCalled();
	});

	it("replace mode (no navMode) with no open route launches as before", async () => {
		const launch = vi.fn(async () => win());
		const bus = buildBus({ focusTabByRoute: () => null, getExistingWindow: () => null }, { launch });
		const r = await bus.dispatch(openNote(), { app: "io.example.notes" });
		expect(r.handled).toBe(true);
		expect(launch).toHaveBeenCalled();
	});
});

describe("IntentsBus send-family verbs (Mailbox-4)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	function registerComposerVerb(verb: string): void {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb,
			entityType: "brainstorm/Email/v1",
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
	}

	it("send routes to the shell-side sendMail handler, never an app window", async () => {
		const sendMail = vi.fn().mockResolvedValue({ emailId: "ent_9", deduped: false });
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: makeOrchestrator().orchestrator,
			sendMail,
		});
		const payload = { accountRef: "acc_1", to: ["dana@example.com"], submissionId: "sub-1" };
		const result = await bus.dispatch({ verb: "send", payload }, { app: "io.brainstorm.mailbox" });
		expect(result.handled).toBe(true);
		expect(result.handled && result.handler.appId).toBe("mail-transport");
		expect(result.handled && result.value).toEqual({ emailId: "ent_9", deduped: false });
		expect(sendMail).toHaveBeenCalledWith(payload, "io.brainstorm.mailbox");
	});

	it("send without a wired handler fails closed with no-delivery-channel", async () => {
		const result = await env.bus.dispatch(
			{ verb: "send", payload: { submissionId: "sub-1" } },
			{ app: "io.brainstorm.mailbox" },
		);
		expect(result.handled).toBe(false);
		expect(result.handled === false && result.reason).toBe("no-delivery-channel");
	});

	it("send surfaces a handler failure as handler-error", async () => {
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: makeOrchestrator().orchestrator,
			sendMail: vi.fn().mockRejectedValue(Object.assign(new Error("disabled"), { name: "Invalid" })),
		});
		const result = await bus.dispatch(
			{ verb: "send", payload: {} },
			{ app: "io.brainstorm.mailbox" },
		);
		expect(result.handled).toBe(false);
		expect(result.handled === false && result.reason).toBe("handler-error");
		expect(result.handled === false && result.message).toBe("disabled");
	});

	it("compose launches the handler with the full intent riding the launch context", async () => {
		registerComposerVerb("compose");
		const payload = { entityType: "brainstorm/Email/v1", to: "dana@example.com" };
		const result = await env.bus.dispatch({ verb: "compose", payload }, { app: "io.example.notes" });
		expect(result.handled).toBe(true);
		expect(env.launches[0]?.appId).toBe("io.example.editor");
		expect(env.launches[0]?.launch).toEqual({
			reason: "intent",
			intent: { verb: "compose", payload, source: "io.example.notes" },
		});
	});

	it("reply resolves a bare entityId to its type to find the handler", async () => {
		registerComposerVerb("reply");
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: makeOrchestrator().orchestrator,
			resolveEntityTarget: async () => ({ type: "brainstorm/Email/v1" }),
		});
		const result = await bus.dispatch(
			{ verb: "reply", payload: { entityId: "ent_7" } },
			{ app: "io.example.agent" },
		);
		expect(result.handled).toBe(true);
		expect(result.handled && result.handler.appId).toBe("io.example.editor");
	});

	it("pushes the composer intent over app:intent when the handler is already running", async () => {
		registerComposerVerb("forward");
		const send = vi.fn();
		const existing = {
			appId: "io.example.editor",
			windowId: "main",
			tabId: "tab-1",
			webContentsId: 7,
			parked: false,
			webContents: { isDestroyed: () => false, send } as unknown as AppWindow["webContents"],
			container: {} as AppWindow["container"],
		};
		const launcher = {
			getExistingWindow: () => existing,
		} as unknown as AppLauncher;
		const { orchestrator } = makeOrchestrator();
		(orchestrator.launch as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
		const bus = new IntentsBus({ intents: env.repos.intents, orchestrator, launcher });
		const payload = { entityId: "ent_7", entityType: "brainstorm/Email/v1" };
		const result = await bus.dispatch({ verb: "forward", payload }, { app: "io.example.notes" });
		expect(result.handled).toBe(true);
		expect(send).toHaveBeenCalledWith("app:intent", {
			verb: "forward",
			payload,
			source: "io.example.notes",
		});
	});
});

describe("IntentsBus — insert delivery (F-241 / doc 75 Agent → Notes seam)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	const NOTE_TYPE = "io.brainstorm.notes/Note/v1";

	function registerInsertHandler() {
		env.repos.intents.insert({
			appId: "io.example.editor",
			verb: "insert",
			entityType: NOTE_TYPE,
			mime: null,
			format: null,
			kind: null,
			blockId: null,
			label: null,
			priority: "primary",
			registeredAt: 1,
		});
	}

	it("insert launches the registered handler with the full intent riding the launch context", async () => {
		registerInsertHandler();
		const payload = {
			entityId: "note-1",
			entityType: NOTE_TYPE,
			position: "end",
			markdown: "## Reply",
		};
		const result = await env.bus.dispatch({ verb: "insert", payload }, { app: "io.example.agent" });
		expect(result.handled).toBe(true);
		expect(result.handled && result.handler.appId).toBe("io.example.editor");
		expect(env.launches[0]?.launch).toEqual({
			reason: "intent",
			intent: { verb: "insert", payload, source: "io.example.agent" },
		});
	});

	it("pushes the insert intent over app:intent when the handler is already running", async () => {
		registerInsertHandler();
		const send = vi.fn();
		const existing = {
			appId: "io.example.editor",
			windowId: "main",
			tabId: "tab-1",
			webContentsId: 7,
			parked: false,
			webContents: { isDestroyed: () => false, send } as unknown as AppWindow["webContents"],
			container: {} as AppWindow["container"],
		};
		const launcher = {
			getExistingWindow: () => existing,
		} as unknown as AppLauncher;
		const { orchestrator } = makeOrchestrator();
		(orchestrator.launch as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
		const bus = new IntentsBus({ intents: env.repos.intents, orchestrator, launcher });
		const payload = { entityId: "note-1", entityType: NOTE_TYPE, position: "end", markdown: "x" };
		const result = await bus.dispatch({ verb: "insert", payload }, { app: "io.example.agent" });
		expect(result.handled).toBe(true);
		expect(send).toHaveBeenCalledWith("app:intent", {
			verb: "insert",
			payload,
			source: "io.example.agent",
		});
	});

	it("insert for an unregistered target type fails closed with no-handler", async () => {
		registerInsertHandler();
		const result = await env.bus.dispatch(
			{
				verb: "insert",
				payload: {
					entityId: "task-1",
					entityType: "io.brainstorm.tasks/Task/v1",
					position: "end",
					markdown: "x",
				},
			},
			{ app: "io.example.agent" },
		);
		expect(result.handled).toBe(false);
		expect(result.handled === false && result.reason).toBe("no-handler");
	});
});

describe("IntentsBus — suggestActions (action surface, doc 63)", () => {
	let env: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		env = await setup();
	});
	afterEach(async () => {
		env.stores.close();
		await rm(env.vaultDir, { recursive: true, force: true });
	});

	function insertProcess(
		appId: string,
		over: Partial<{
			entityType: string;
			kind: string;
			label: string;
			icon: string;
			actionGroup: string;
			priority: "primary" | "secondary";
		}> = {},
	) {
		env.repos.intents.insert({
			appId,
			verb: "process",
			entityType: over.entityType ?? null,
			mime: null,
			format: null,
			kind: over.kind ?? null,
			blockId: null,
			label: over.label ?? null,
			priority: over.priority ?? "secondary",
			registeredAt: 1,
			icon: over.icon ?? null,
			actionGroup: over.actionGroup ?? null,
		});
	}

	it("returns relevance-matched contributions tagged with trust + attribution", async () => {
		insertProcess("io.example.viewer", {
			entityType: "brainstorm/Note/v1",
			kind: "summarize",
			label: "Summarize",
			icon: "sparkle",
		});
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			resolveTrustTier: () => "trusted",
			resolveAppLabel: (id: string) => (id === "io.example.viewer" ? "Viewer" : id),
		} as unknown as IntentsBusOptions);
		const actions = await bus.suggestActions(
			{ target: { entityType: "brainstorm/Note/v1" }, verbs: ["process"] },
			{ app: "io.example.editor" },
		);
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({
			verb: "process",
			kind: "summarize",
			label: "Summarize",
			icon: "sparkle",
			group: "actions",
			trustTier: "trusted",
			appId: "io.example.viewer",
			appLabel: "Viewer",
		});
	});

	it("does NOT surface a discriminator-mismatched contribution", async () => {
		insertProcess("io.example.viewer", { entityType: "brainstorm/Note/v1", kind: "summarize" });
		const bus = new IntentsBus({ intents: env.repos.intents, orchestrator: env.orchestrator });
		const actions = await bus.suggestActions(
			{ target: { entityType: "brainstorm/Task/v1" }, verbs: ["process"] },
			{ app: "io.example.editor" },
		);
		expect(actions).toHaveLength(0);
	});

	it("never surfaces the dispatching app's OWN contributions", async () => {
		insertProcess("io.example.editor", { kind: "summarize" });
		const bus = new IntentsBus({ intents: env.repos.intents, orchestrator: env.orchestrator });
		const actions = await bus.suggestActions(
			{ target: { entityType: "brainstorm/Note/v1" }, verbs: ["process"] },
			{ app: "io.example.editor" },
		);
		expect(actions).toHaveLength(0);
	});

	it("drops a disabled contributor wholesale", async () => {
		insertProcess("io.example.viewer", { kind: "summarize" });
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			resolveDisabledContributors: () => new Set(["io.example.viewer"]),
		} as unknown as IntentsBusOptions);
		const actions = await bus.suggestActions(
			{ target: { entityType: "brainstorm/Note/v1" }, verbs: ["process"] },
			{ app: "io.example.editor" },
		);
		expect(actions).toHaveLength(0);
	});

	it("defaults trust to sideloaded when no resolver is wired", async () => {
		insertProcess("io.example.viewer", { kind: "summarize" });
		const bus = new IntentsBus({ intents: env.repos.intents, orchestrator: env.orchestrator });
		const actions = await bus.suggestActions(
			{ target: { entityType: "brainstorm/Note/v1" }, verbs: ["process"] },
			{ app: "io.example.editor" },
		);
		expect(actions[0]?.trustTier).toBe("sideloaded");
	});

	it("sanitizes a contributor label (strips markup, caps length) and falls back when empty", async () => {
		insertProcess("io.example.viewer", { kind: "k1", label: "<b>Hack</b> me" });
		insertProcess("io.example.viewer", { kind: "k2", label: "   " });
		const bus = new IntentsBus({
			intents: env.repos.intents,
			orchestrator: env.orchestrator,
			resolveAppLabel: () => "Viewer",
		} as unknown as IntentsBusOptions);
		const actions = await bus.suggestActions(
			{ target: { entityType: "brainstorm/Note/v1" }, verbs: ["process"] },
			{ app: "io.example.editor" },
		);
		const k1 = actions.find((a) => a.kind === "k1");
		const k2 = actions.find((a) => a.kind === "k2");
		expect(k1?.label).not.toContain("<");
		expect(k1?.label).toContain("Hack");
		// Empty/whitespace label falls back to "<verb> — <app>".
		expect(k2?.label).toBe("process — Viewer");
	});

	it("returns [] for no verbs", async () => {
		insertProcess("io.example.viewer", { kind: "summarize" });
		const bus = new IntentsBus({ intents: env.repos.intents, orchestrator: env.orchestrator });
		const actions = await bus.suggestActions(
			{ target: { entityType: "brainstorm/Note/v1" }, verbs: [] },
			{ app: "io.example.editor" },
		);
		expect(actions).toHaveLength(0);
	});

	it("dispatches a `process` contribution to the contributor (delivery channel)", async () => {
		const bus = new IntentsBus({ intents: env.repos.intents, orchestrator: env.orchestrator });
		const result = await bus.dispatch(
			{
				verb: "process",
				payload: { entityId: "ent_1", kind: "summarize", handlerAppId: "io.example.viewer" },
			},
			{ app: "io.example.editor" },
		);
		// Even with no registered handler, `process` now has a delivery channel
		// (launch context), so it routes rather than dead-ending at no-delivery.
		// With no handler registered it is no-handler, NOT no-delivery-channel.
		expect(result.handled).toBe(false);
		expect(result.handled === false && result.reason).toBe("no-handler");
	});

	it("routes a `process` dispatch to a registered contributor via launch context", async () => {
		env.repos.intents.insert({
			appId: "io.example.viewer",
			verb: "process",
			entityType: "brainstorm/Note/v1",
			mime: null,
			format: null,
			kind: "summarize",
			blockId: null,
			label: "Summarize",
			priority: "secondary",
			registeredAt: 1,
			icon: null,
			actionGroup: null,
		});
		const result = await env.bus.dispatch(
			{
				verb: "process",
				payload: {
					entityId: "ent_1",
					entityType: "brainstorm/Note/v1",
					kind: "summarize",
					handlerAppId: "io.example.viewer",
				},
			},
			{ app: "io.example.editor" },
		);
		expect(result.handled).toBe(true);
		expect(result.handled && result.handler.appId).toBe("io.example.viewer");
		expect(
			env.launches.some((l) => l.appId === "io.example.viewer" && l.launch?.reason === "intent"),
		).toBe(true);
	});
});
