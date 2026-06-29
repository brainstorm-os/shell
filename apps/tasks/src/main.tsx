/**
 * Tasks entry — mounts the React app into `#root`. Stands up the shared
 * fancy-menus runtime + the spellcheck suggestion menu, pre-applies the
 * persisted sidebar width before first paint, wires the shared editor (entity
 * index for the body `@`-mention / transclusion typeaheads, open-entity
 * navigation, media upload), and ensures the Task→Person assignee catalog def.
 *
 * The app surface itself — header chrome, sidebar, the compiled surface /
 * board / timeline / search content, the detail route + properties overlay —
 * lives in `<TasksApp>` (React). The imperative DOM view-builders it reuses
 * (`renderSurfaceView` / `renderSidebar` / `renderTaskDetailView` / …) mount
 * behind ref boundaries inside it; only the live entity list flows through the
 * ONE shared reactivity stack (`@brainstorm/react-yjs`'s `useLiveEntities`).
 */

import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/sdk/empty-state.css";
import "@brainstorm/editor/editor.css";
import "@brainstorm/sdk/recurrence-editor.css";
import "@brainstorm/editor/editor-theme.css";
import "./types"; // keep the type surface in the build graph

import {
	entitiesSnapshotList,
	entityTitleOf,
	entityTitlesSnapshot,
	getEntityTitle,
	setEditorHost,
	setEntityIndexSource,
	subscribeEntityTitles,
} from "@brainstorm/editor";
import { openEntity } from "@brainstorm/sdk";
import type { Intent } from "@brainstorm/sdk-types";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import type { EntityTitleSource } from "@brainstorm/sdk/property-ui";
import { applyPersistedPanelWidth } from "@brainstorm/sdk/resizable";
import { mountSpellcheckMenuFromWindow } from "@brainstorm/sdk/spellcheck-menu";
import { getWidgetLaunch } from "@brainstorm/sdk/widget";
import { createRoot } from "react-dom/client";
import { TasksApp } from "./app";
import { ASSIGNEE_CATALOG_DEF } from "./properties/task-properties";
import { ensureTaskVocab } from "./properties/task-vocab";
import { getBrainstorm } from "./storage/runtime";
import { mountTasksWidget } from "./widget-mount";
import "./styles.css";

// Widget-mode (Stage 7.3a): the dashboard launched this bundle as a widget.
// Mount the compact widget surface (open-tasks glance list) instead of the full
// Tasks app, and skip the full-app bootstrap below.
const widgetLaunch = getWidgetLaunch();
if (widgetLaunch) {
	mountTasksWidget(widgetLaunch);
} else {
	bootstrapTasksApp();
}

function bootstrapTasksApp(): void {
	// Set the persisted sidebar width before any DOM work, to avoid a flash where
	// the first paint uses the CSS-default width and then `.tasks-main`'s
	// grid-template-columns transition animates to the persisted value.
	applyPersistedPanelWidth({
		storageKey: "tasks:sidebar-width",
		cssVar: "--tasks-sidebar-width",
		defaultWidth: 248,
	});

	// Stand up the fancy-menus runtime so object / context menus open through the
	// shared bridge (Stage 8.8), plus the spellcheck suggestion menu for the task
	// body editor + text cells (B11.16c).
	mountMenuHost();
	mountSpellcheckMenuFromWindow();

	const runtime = getBrainstorm();

	// Wire the shared editor so the task-body `@`-mention / transclusion typeaheads
	// can enumerate the vault + navigate. The entity index reads the vault
	// snapshot; the host bridge owns open-entity navigation. Both degrade to no-ops
	// on preview / older shells that lack the services.
	const vaultEntitiesSvc = runtime?.services.vaultEntities;
	if (vaultEntitiesSvc) {
		// Invoke `onChange` via `.call` so a `this`-bound impl keeps its receiver
		// (and so the reactivity ratchet's grep stays satisfied — the LIVE task
		// list flows through `useLiveEntities` in `app.tsx`, not here; this is the
		// editor's entity-title index).
		const { onChange } = vaultEntitiesSvc;
		setEntityIndexSource({
			list: () => vaultEntitiesSvc.list(),
			onChange: (listener) => onChange.call(vaultEntitiesSvc, listener),
		});
	}

	// The Assignee picker's live title lookup (F-152) — backed by the same shared
	// editor entity index the mention typeahead reads (one vault scan for all
	// consumers). Mirrors Notes' `notesEntityTitleSource`.
	const entityTitleSource: EntityTitleSource = {
		subscribe: (listener) => subscribeEntityTitles(listener),
		snapshotTick: () => entityTitlesSnapshot(),
		list: () => entitiesSnapshotList(),
		titleOf: (entityId) => getEntityTitle(entityId),
		displayTitle: (entity) => entityTitleOf(entity),
	};

	const intentsSvc = runtime?.services.intents;
	const storageSvc = runtime?.services.storage;
	setEditorHost({
		...(intentsSvc
			? {
					openEntity: (target) => {
						const openCapable = {
							services: {
								intents: {
									dispatch: (intent: { verb: string; payload: Record<string, unknown> }) =>
										intentsSvc.dispatch(intent as Omit<Intent, "source">),
								},
							},
						};
						void openEntity(openCapable, target);
					},
				}
			: {}),
		...(storageSvc
			? { uploadFile: (filename, bytes, mime) => storageSvc.uploadFile(filename, bytes, mime) }
			: {}),
	});

	// Ensure the vault catalog carries the Task→Person assignee EntityRef def
	// (F-152). The dev seeder registers it only under AUTO_SEED, so a production /
	// dogfood vault never gets it — and without the def the shell's catalog-driven
	// ref derivation can't project the "Assignee" edge into the Graph. Idempotent:
	// only written when absent.
	const propertiesSvc = runtime?.services.properties ?? null;
	if (propertiesSvc) {
		void propertiesSvc
			.getProperty(ASSIGNEE_CATALOG_DEF.key)
			.then((existing) => (existing ? undefined : propertiesSvc.setProperty(ASSIGNEE_CATALOG_DEF)))
			.catch((error) => {
				console.warn(`[tasks] assignee catalog def ensure failed: ${(error as Error).message}`);
			});

		// Seed the priority / status / tags vocabularies so the property cells
		// have options to pick from (idempotent — only writes absent dictionaries).
		void ensureTaskVocab(propertiesSvc).catch((error) => {
			console.warn(`[tasks] vocabulary seed failed: ${(error as Error).message}`);
		});
	}

	const root = document.getElementById("root");
	if (!root) throw new Error("tasks: #root missing");

	createRoot(root).render(
		<AppErrorBoundary appName="tasks">
			<TasksApp entityTitleSource={entityTitleSource} />
		</AppErrorBoundary>,
	);
}
