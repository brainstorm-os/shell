/**
 * Database "Chart" dashboard widget (9.12.30). When the Database bundle is
 * launched as the `chart-view` widget, `app.ts` mounts this instead of the
 * full app. It renders one Chart view — the launch `bind` when the host
 * supplies one, else the user's pick from the in-widget selector (kept in the
 * app's kv) — live over the shell's vault index via `useVaultEntities`.
 * Clicking the chart opens that view in the full Database app.
 */

import { useVaultEntities } from "@brainstorm-os/react-yjs";
import { LIST_VIEW_ENTITY_TYPE, openEntity } from "@brainstorm-os/sdk";
import type { OpenCapableRuntime } from "@brainstorm-os/sdk";
import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import "@brainstorm-os/sdk/select-menu.css";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm-os/sdk/widget";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import {
	chartWidgetCatalog,
	chartWidgetModel,
	chartWidgetViewLabel,
} from "../logic/chart-widget-data";
import type { VaultSnapshotInput } from "../logic/vault-lists";
import type { ChartLayoutOptions } from "../types/list-view";
import { humanize } from "../ui/humanize";
import { ChartView } from "./chart-view";

export const CHART_WIDGET_ID = "chart-view";
const PICK_KEY = "database:chart-widget:view";

type KvStore = {
	get<T>(key: string): Promise<T | null | undefined>;
	put(key: string, value: unknown): Promise<void>;
};

type PropertiesLister = {
	list(): Promise<{ properties?: ReadonlyArray<{ key: string; name?: string }> }>;
};

export type ChartWidgetRuntime = OpenCapableRuntime & {
	services?: {
		vaultEntities?: Parameters<typeof useVaultEntities>[0];
		settings?: KvStore;
		storage?: KvStore;
		properties?: PropertiesLister;
		intents?: { dispatch?: (intent: { verb: string; payload: Record<string, unknown> }) => unknown };
	} | null;
};

/** Property display names for the chart title (the catalog, when the widget
 *  surface exposes it; else the humanized key). */
function usePropertyNames(runtime: ChartWidgetRuntime | null): (key: string) => string {
	const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
	const lister = runtime?.services?.properties;
	useEffect(() => {
		if (!lister) return;
		let live = true;
		lister
			.list()
			.then((snap) => {
				if (!live) return;
				setNames(
					new Map(
						(snap.properties ?? [])
							.filter((d) => d.name?.trim())
							.map((d) => [d.key, d.name as string] as const),
					),
				);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [lister]);
	return (key) => names.get(key) ?? humanize(key);
}

function ChartWidgetBody({
	runtime,
	bind,
}: {
	runtime: ChartWidgetRuntime | null;
	bind: string | undefined;
}): ReactElement {
	useWidgetVisible();
	const nameOf = usePropertyNames(runtime);
	const snapshot = useVaultEntities(runtime?.services?.vaultEntities ?? null);
	const catalog = useMemo(
		() => chartWidgetCatalog(snapshot as unknown as VaultSnapshotInput),
		[snapshot],
	);
	const kv = runtime?.services?.settings ?? runtime?.services?.storage ?? null;
	const [picked, setPicked] = useState<string | null>(bind ?? null);
	useEffect(() => {
		if (bind || !kv) return;
		let live = true;
		kv
			.get<string>(PICK_KEY)
			.then((id) => {
				if (live && typeof id === "string") setPicked(id);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [bind, kv]);

	const view = catalog.views.find((v) => v.id === picked) ?? catalog.views[0] ?? null;
	const model = useMemo(
		() =>
			view
				? chartWidgetModel(catalog, view, {
						empty: t("brainstorm.database.chart.noValue"),
						other: t("brainstorm.database.chart.other"),
						all: t("brainstorm.database.board.allLane"),
					})
				: null,
		[catalog, view],
	);

	if (!view || !model) {
		return (
			<WidgetEmpty
				message={t("brainstorm.database.widget.chart.empty")}
				actionLabel={t("brainstorm.database.widget.chart.open")}
				onAction={() => {
					void runtime?.services?.intents?.dispatch?.({
						verb: "open",
						payload: { entityType: LIST_VIEW_ENTITY_TYPE },
					});
				}}
			/>
		);
	}

	const layout = view.layoutOptions as ChartLayoutOptions;
	return (
		<div className="dbv-chart-widget">
			{bind ? null : (
				<div className="dbv-chart-widget__toolbar">
					<SelectMenu<string>
						value={view.id}
						ariaLabel={t("brainstorm.database.widget.chart.pick")}
						options={catalog.views.map((v) => ({ value: v.id, label: chartWidgetViewLabel(catalog, v) }))}
						onChange={(id) => {
							setPicked(id);
							void kv?.put(PICK_KEY, id).catch(() => {});
						}}
					/>
				</div>
			)}
			<button
				type="button"
				className="dbv-chart-widget__open"
				aria-label={chartWidgetViewLabel(catalog, view)}
				onClick={() =>
					void openEntity(runtime, { entityId: view.id, entityType: LIST_VIEW_ENTITY_TYPE })
				}
			>
				<ChartView
					model={model}
					chartType={layout.chartType}
					valueName={layout.valueProperty ? nameOf(layout.valueProperty) : null}
					groupName={view.groupBy ? nameOf(view.groupBy.propertyId) : null}
					showTable={false}
					compact
				/>
			</button>
		</div>
	);
}

export function ChartWidget({
	launch,
	runtime,
}: {
	launch: WidgetLaunch;
	runtime: ChartWidgetRuntime | null;
}): ReactElement {
	return (
		<WidgetRoot
			launch={launch}
			widgets={[
				{
					id: CHART_WIDGET_ID,
					render: () => <ChartWidgetBody runtime={runtime} bind={launch.bind} />,
				},
			]}
		/>
	);
}
