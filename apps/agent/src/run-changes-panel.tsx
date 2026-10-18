/**
 * Agent-15 — "what the agent changed in this chat", per run, with "Undo this
 * run". Reads the conversation's OWN runs over the app-facing `agent-trace`
 * service (the shell scopes both calls to this app and to types it can read;
 * no new capability) and renders each run that wrote something through the
 * shared SDK `<RunChanges>`, the same list Settings → AI → Agent activity shows.
 *
 * Refetches when `refreshKey` changes (the host bumps it as approvals land)
 * and after an undo. A shell without the Agent-15 methods renders nothing.
 */

import type { AgentRunChanges, AgentTraceService } from "@brainstorm-os/sdk-types";
import { AgentUndoRefusal, AgentWriteKind } from "@brainstorm-os/sdk-types";
import {
	RUN_UNDO_REFUSAL_KEYS,
	RunChanges,
	type RunChangesLabels,
} from "@brainstorm-os/sdk/run-changes";
import { type ReactElement, useEffect, useState } from "react";
import { type AgentI18nKey, plural, t } from "./i18n";

const RUN_PAGE = 20;

function labels(): RunChangesLabels {
	return {
		heading: t("runChanges.heading"),
		empty: t("runChanges.empty"),
		untitled: t("runChanges.untitled"),
		oversize: t("runChanges.oversize"),
		kind: {
			[AgentWriteKind.Created]: t("runChanges.kindCreated"),
			[AgentWriteKind.Updated]: t("runChanges.kindUpdated"),
			[AgentWriteKind.Trashed]: t("runChanges.kindTrashed"),
		},
		field: (key, before, after) =>
			after === null
				? t("runChanges.fieldCleared", { key })
				: before === null
					? t("runChanges.fieldSet", { key, after })
					: t("runChanges.fieldChanged", { key, before, after }),
		lines: (added, removed) =>
			t("runChanges.lines", { added: String(added), removed: String(removed) }),
		more: (count) =>
			plural(count, "runChanges.more.one", "runChanges.more.other", { count: String(count) }),
		undo: t("runChanges.undo"),
		undoing: t("runChanges.undoing"),
		undone: t("runChanges.undone"),
		failed: t("runChanges.failed"),
		refusal: (reason, field) =>
			reason === AgentUndoRefusal.EditedSince && field
				? t("runChanges.refusal.editedSinceField", { field })
				: t(`runChanges.refusal.${RUN_UNDO_REFUSAL_KEYS[reason]}` as AgentI18nKey),
	};
}

export function RunChangesPanel({
	trace,
	conversationId,
	refreshKey,
	onOpenEntity,
}: {
	trace: AgentTraceService | null;
	conversationId: string | null;
	refreshKey: string;
	onOpenEntity: (entityId: string) => void;
}): ReactElement | null {
	const [runs, setRuns] = useState<readonly AgentRunChanges[]>([]);
	const [epoch, setEpoch] = useState(0);
	const text = labels();

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey / epoch are the intended refetch triggers.
	useEffect(() => {
		const listChanges = trace?.listChanges;
		if (!trace || !listChanges || !conversationId) {
			setRuns([]);
			return undefined;
		}
		let live = true;
		void (async () => {
			try {
				const { runs: page } = await trace.listRuns({ conversationId, limit: RUN_PAGE });
				const all = await Promise.all(page.map((run) => listChanges({ runId: run.id })));
				if (live) {
					setRuns(all.filter((c): c is AgentRunChanges => c !== null && c.changes.length > 0));
				}
			} catch {
				if (live) setRuns([]);
			}
		})();
		return () => {
			live = false;
		};
	}, [trace, conversationId, refreshKey, epoch]);

	const undoRun = trace?.undoRun;
	if (runs.length === 0) return null;
	return (
		<section className="agent__run-changes" data-testid="agent-run-changes">
			{runs.map((run) => (
				<RunChanges
					key={run.runId}
					changes={run}
					labels={text}
					onOpenEntity={onOpenEntity}
					{...(undoRun ? { onUndo: () => undoRun({ runId: run.runId }) } : {})}
					onUndone={() => setEpoch((n) => n + 1)}
					testId={`agent-run-changes-${run.runId}`}
				/>
			))}
		</section>
	);
}
