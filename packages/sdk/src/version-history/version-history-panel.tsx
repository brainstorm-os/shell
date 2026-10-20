/**
 * `<VersionHistoryPanel>` (10.16) — the shared History section for an object's
 * inspector. Versions grouped by day, each row showing time, who changed it and
 * why; selecting one opens a read-only preview with the property diff and a
 * "Restore this version" action.
 *
 * Always live (doc `version-history.md` §UI): with no versions it shows its own
 * empty state rather than disappearing. On a shared object where the user is a
 * Viewer (OQ-VH-2) the shell answers `ListOnly` and rows are not openable — the
 * panel never asks for earlier content it is not allowed to show.
 *
 * Leaf component: already-translated `labels` in, the `history` service in.
 * Mount it in the inspector's `children` slot (or its own right-panel tab).
 */

import {
	HistoryAccess,
	type HistoryPrincipal,
	HistoryPrincipalKind,
	type VersionCause,
	type VersionHistoryList,
	type VersionHistoryService,
	type VersionPreview,
	type VersionPropertyChange,
	VersionPropertyChangeKind,
	type VersionSummary,
} from "@brainstorm-os/sdk-types";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { type FormatContext, formatGroupDate, formatTime } from "../date-formatters";
import { EmptyState, EmptyStateTone } from "../empty-state";
import { IconName } from "../icon";

export type VersionHistoryLabels = {
	title: string;
	empty: string;
	emptyHint: string;
	loadFailed: string;
	today: string;
	tomorrow: string;
	yesterday: string;
	you: string;
	causes: Readonly<Record<VersionCause, string>>;
	/** Shown to a Viewer of a shared object instead of a preview. */
	listOnlyNotice: string;
	/** Shown when the caller may preview but not write. */
	previewOnlyNotice: string;
	back: string;
	changesHeading: string;
	noChanges: string;
	bodyHeading: string;
	emptyBody: string;
	changeKinds: Readonly<Record<VersionPropertyChangeKind, string>>;
	restore: string;
	restoring: string;
	restoreFailed: string;
	restored: string;
	previewFailed: string;
};

export type VersionHistoryPanelProps = {
	entityId: string;
	service: Pick<VersionHistoryService, "list" | "preview" | "restore">;
	labels: VersionHistoryLabels;
	format?: FormatContext;
	/** Bump to reload (e.g. after the host saved a change). */
	refreshKey?: number;
	onRestored?: (versionId: string) => void;
	/** Renders a property value in the diff; defaults to compact JSON. */
	formatValue?: (key: string, value: unknown) => string;
	now?: () => number;
};

function defaultFormatValue(_key: string, value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function principalText(principals: readonly HistoryPrincipal[], you: string): string {
	return principals
		.map((p) => (p.isSelf && p.kind === HistoryPrincipalKind.Member ? you : p.label))
		.join(", ");
}

type DayGroup = { key: string; label: string; versions: VersionSummary[] };

export function groupVersionsByDay(
	versions: readonly VersionSummary[],
	now: number,
	labels: Pick<VersionHistoryLabels, "today" | "tomorrow" | "yesterday">,
	format?: FormatContext,
): DayGroup[] {
	const groups: DayGroup[] = [];
	const byKey = new Map<string, DayGroup>();
	for (const v of versions) {
		const d = new Date(v.at);
		const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
		let group = byKey.get(key);
		if (!group) {
			group = { key, label: formatGroupDate(v.at, now, labels, format), versions: [] };
			byKey.set(key, group);
			groups.push(group);
		}
		group.versions.push(v);
	}
	return groups;
}

export function VersionHistoryPanel(props: VersionHistoryPanelProps): ReactElement {
	const { entityId, service, labels, format, refreshKey, onRestored } = props;
	const formatValue = props.formatValue ?? defaultFormatValue;
	const now = props.now ?? Date.now;
	const [list, setList] = useState<VersionHistoryList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [preview, setPreview] = useState<VersionPreview | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			setList(await service.list(entityId));
			setError(null);
		} catch {
			setError(labels.loadFailed);
		}
	}, [service, entityId, labels.loadFailed]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` is the host's deliberate reload trigger.
	useEffect(() => {
		setSelected(null);
		setPreview(null);
		setNotice(null);
		void reload();
	}, [reload, refreshKey]);

	useEffect(() => {
		if (!selected || !list || list.access === HistoryAccess.ListOnly) return;
		let live = true;
		setPreview(null);
		service.preview({ entityId, versionId: selected }).then(
			(p) => {
				if (live) setPreview(p);
			},
			() => {
				if (live) setNotice(labels.previewFailed);
			},
		);
		return () => {
			live = false;
		};
	}, [selected, list, service, entityId, labels.previewFailed]);

	const groups = useMemo(
		() => (list ? groupVersionsByDay(list.versions, now(), labels, format) : []),
		[list, now, labels, format],
	);

	const restore = async (): Promise<void> => {
		if (!selected) return;
		setBusy(true);
		setNotice(null);
		try {
			await service.restore({ entityId, versionId: selected });
			setNotice(labels.restored);
			onRestored?.(selected);
			setSelected(null);
			setPreview(null);
			await reload();
		} catch {
			setNotice(labels.restoreFailed);
		} finally {
			setBusy(false);
		}
	};

	const openable = list !== null && list.access !== HistoryAccess.ListOnly;
	const selectedSummary = list?.versions.find((v) => v.versionId === selected) ?? null;

	return (
		<section className="bs-history" aria-label={labels.title} data-testid="version-history">
			<h3 className="bs-history__title">{labels.title}</h3>
			{error ? (
				<p className="bs-history__notice" role="alert">
					{error}
				</p>
			) : null}
			{notice ? (
				<p className="bs-history__notice" role="status">
					{notice}
				</p>
			) : null}
			{list && list.access === HistoryAccess.ListOnly ? (
				<p className="bs-history__hint">{labels.listOnlyNotice}</p>
			) : null}
			{list && list.versions.length === 0 ? (
				<EmptyState
					icon={IconName.History}
					title={labels.empty}
					hint={labels.emptyHint}
					tone={EmptyStateTone.Compact}
				/>
			) : null}
			{selectedSummary && openable ? (
				<VersionDetail
					summary={selectedSummary}
					preview={preview}
					labels={labels}
					format={format}
					canRestore={list?.access === HistoryAccess.Restore}
					busy={busy}
					formatValue={formatValue}
					onBack={() => setSelected(null)}
					onRestore={() => void restore()}
				/>
			) : (
				groups.map((group) => (
					<div key={group.key} className="bs-history__day">
						<h4 className="bs-history__day-label">{group.label}</h4>
						<ul className="bs-history__list">
							{group.versions.map((v) => {
								const body = (
									<>
										<span className="bs-history__time">{formatTime(v.at, format)}</span>
										<span className="bs-history__who">{principalText(v.principals, labels.you)}</span>
										<span className="bs-history__cause">{labels.causes[v.cause]}</span>
									</>
								);
								return (
									<li key={v.versionId} className="bs-history__item">
										{openable ? (
											<button
												type="button"
												className="bs-history__row"
												onClick={() => setSelected(v.versionId)}
											>
												{body}
											</button>
										) : (
											<div className="bs-history__row">{body}</div>
										)}
									</li>
								);
							})}
						</ul>
					</div>
				))
			)}
		</section>
	);
}

function VersionDetail(props: {
	summary: VersionSummary;
	preview: VersionPreview | null;
	labels: VersionHistoryLabels;
	format: FormatContext | undefined;
	canRestore: boolean;
	busy: boolean;
	formatValue: (key: string, value: unknown) => string;
	onBack: () => void;
	onRestore: () => void;
}): ReactElement {
	const { summary, preview, labels, format, canRestore, busy, formatValue } = props;
	return (
		<div className="bs-history__detail">
			<div className="bs-history__detail-head">
				<button type="button" className="bs-btn bs-btn--ghost" onClick={props.onBack}>
					{labels.back}
				</button>
				<span className="bs-history__time">
					{formatTime(summary.at, format)} · {labels.causes[summary.cause]}
				</span>
			</div>
			<h4 className="bs-history__day-label">{labels.changesHeading}</h4>
			{preview === null ? null : preview.changes.length === 0 ? (
				<p className="bs-history__hint">{labels.noChanges}</p>
			) : (
				<dl className="bs-history__diff">
					{preview.changes.map((c: VersionPropertyChange) => (
						<div key={c.key} className="bs-history__diff-row" data-kind={c.kind}>
							<dt>
								{c.key} <span className="bs-history__cause">{labels.changeKinds[c.kind]}</span>
							</dt>
							<dd>
								<span className="bs-history__then">{formatValue(c.key, c.versionValue)}</span>
								{c.kind === VersionPropertyChangeKind.Changed ? (
									<span className="bs-history__now">{formatValue(c.key, c.currentValue)}</span>
								) : null}
							</dd>
						</div>
					))}
				</dl>
			)}
			<h4 className="bs-history__day-label">{labels.bodyHeading}</h4>
			{preview ? <pre className="bs-history__body">{preview.bodyText || labels.emptyBody}</pre> : null}
			{canRestore ? (
				<button
					type="button"
					className="bs-btn bs-btn--primary bs-filled bs-history__restore"
					disabled={busy || preview === null}
					onClick={props.onRestore}
				>
					{busy ? labels.restoring : labels.restore}
				</button>
			) : (
				<p className="bs-history__hint">{labels.previewOnlyNotice}</p>
			)}
		</div>
	);
}
