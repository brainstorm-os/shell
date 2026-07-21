/**
 * WidgetHostController (Stage 7.3, OQ-6 → (a)). Bridges the synchronous
 * `WidgetHost` lifecycle core to the async world it lives in:
 *
 *   - The dashboard store snapshot drives placements (`widgets` map). On every
 *     snapshot the controller derives `WidgetPlacement[]` and `reconcile()`s.
 *   - A surface needs an async-resolved `WidgetSpec` (manifest entry +
 *     capability grants + first-paint theme/locale) BEFORE `WidgetHost`'s
 *     synchronous factory can build it. The controller resolves specs ahead of
 *     `host.reconcile`, caching them so the factory reads them synchronously.
 *   - Snapshots fire on ANY dashboard mutation (theme, icon move, …). The
 *     controller re-resolves a placement's spec only when its target
 *     (app / widget / bind) actually changed, so a theme tweak doesn't churn
 *     the registry. Reconciles are coalesced — overlapping bursts converge to
 *     the latest desired state.
 *
 * `WidgetHost` stays the pure, unit-tested lifecycle core; this is the glue.
 */

import type { FormatContext } from "@brainstorm-os/sdk-types";
import type { ThemeName } from "@brainstorm-os/tokens";
import type { CapabilityLedger } from "../capabilities/ledger";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import type { SqliteDatabase } from "../storage/sqlite";
import { WidgetHost, type WidgetLayout, type WidgetPlacement } from "./widget-host";
import {
	type WidgetSpec,
	type WidgetSpecContext,
	type WidgetSurfaceDeps,
	createWidgetSurface,
	resolveWidgetSpec,
} from "./widget-surface-factory";

/** The slice of `VaultSession` the controller reads — structural so tests pass
 *  a fake without standing up a real session. */
export interface WidgetSession {
	readonly dataStores: { open(name: "registry"): Promise<SqliteDatabase> };
	capabilityLedger(): Promise<CapabilityLedger>;
}

/** First-paint context for newly-created surfaces. Live theme/locale changes
 *  ride the app broadcast channels (same as app windows), so these only set the
 *  initial frame. */
export type WidgetRenderContext = {
	theme?: ThemeName | null;
	locale?: string | null;
	format?: FormatContext | null;
};

export type WidgetHostControllerDeps = {
	surfaceDeps: WidgetSurfaceDeps;
	preloadPath: string;
	/** The active vault session, or null when none is open (→ tear everything
	 *  down). Read on every reconcile. */
	getActiveSession: () => WidgetSession | null;
	/** Override the spec resolver (tests). Defaults to `resolveWidgetSpec`. */
	resolve?: (placement: WidgetPlacement, ctx: WidgetSpecContext) => Promise<WidgetSpec | null>;
};

/** Derive placements from a dashboard snapshot's `widgets` map. `kind` is the
 *  manifest widget id; v1 stores no `bind` (parameterised widgets are future). */
export function placementsFromWidgets(
	widgets: Record<string, { appId: string; kind: string }>,
): WidgetPlacement[] {
	return Object.entries(widgets).map(([id, w]) => ({ id, appId: w.appId, widgetId: w.kind }));
}

export class WidgetHostController {
	private readonly host: WidgetHost;
	private readonly specs = new Map<string, WidgetSpec>();
	private readonly lastTargets = new Map<string, WidgetPlacement>();
	private readonly entryCache = new Map<string, string>();
	private running = false;
	private queued: { placements: WidgetPlacement[]; render: WidgetRenderContext } | null = null;

	constructor(private readonly deps: WidgetHostControllerDeps) {
		this.host = new WidgetHost((placement) => {
			const spec = this.specs.get(placement.id);
			return spec ? createWidgetSurface(spec, this.deps.surfaceDeps) : null;
		});
	}

	/** Reconcile to the given placements. Coalesces overlapping calls — the last
	 *  one wins, so a burst of snapshots converges without interleaving. */
	async reconcile(placements: WidgetPlacement[], render: WidgetRenderContext = {}): Promise<void> {
		this.queued = { placements, render };
		if (this.running) return;
		this.running = true;
		try {
			while (this.queued) {
				const job = this.queued;
				this.queued = null;
				await this.runReconcile(job.placements, job.render);
			}
		} finally {
			this.running = false;
		}
	}

	private async runReconcile(
		placements: WidgetPlacement[],
		render: WidgetRenderContext,
	): Promise<void> {
		const session = this.deps.getActiveSession();
		if (!session) {
			this.destroyAll();
			return;
		}
		const wanted = new Set(placements.map((p) => p.id));
		for (const id of [...this.specs.keys()]) {
			if (!wanted.has(id)) {
				this.specs.delete(id);
				this.lastTargets.delete(id);
			}
		}
		const resolve = this.deps.resolve ?? resolveWidgetSpec;
		for (const placement of placements) {
			if (!this.targetChanged(placement) && this.specs.has(placement.id)) continue;
			const ctx: WidgetSpecContext = {
				openRegistry: async () => {
					const db = await session.dataStores.open("registry");
					return { makeAppsRepo: () => new AppsRepository(db) };
				},
				getLedger: () => session.capabilityLedger(),
				preloadPath: this.deps.preloadPath,
				theme: render.theme ?? null,
				locale: render.locale ?? null,
				format: render.format ?? null,
				entryCache: this.entryCache,
			};
			const spec = await resolve(placement, ctx);
			if (spec) {
				this.specs.set(placement.id, spec);
				this.lastTargets.set(placement.id, placement);
			} else {
				this.specs.delete(placement.id);
				this.lastTargets.delete(placement.id);
			}
		}
		this.host.reconcile(placements);
	}

	private targetChanged(placement: WidgetPlacement): boolean {
		const prev = this.lastTargets.get(placement.id);
		return (
			!prev ||
			prev.appId !== placement.appId ||
			prev.widgetId !== placement.widgetId ||
			prev.bind !== placement.bind
		);
	}

	/** Apply renderer-reported geometry + visibility. */
	layout(layouts: readonly WidgetLayout[]): void {
		this.host.layout(layouts);
	}

	/** Tear down every surface (vault lock / close / switch). */
	destroyAll(): void {
		this.host.destroyAll();
		this.specs.clear();
		this.lastTargets.clear();
	}

	/** Tear down surfaces owned by `appId` (uninstall / update). The next
	 *  snapshot reconcile recreates still-placed widgets against the new bundle. */
	destroyForApp(appId: string): void {
		this.host.destroyForApp(appId);
		for (const [id, target] of [...this.lastTargets]) {
			if (target.appId !== appId) continue;
			this.specs.delete(id);
			this.lastTargets.delete(id);
		}
	}

	get size(): number {
		return this.host.size;
	}
}
