/**
 * Notes as an app-tool CONSUMER (Tool-10, doc 78).
 *
 * The shared object menu lists another app's tools for a note only when the
 * host can REPORT what happened to a call — a refusal that vanishes is a row
 * that silently does nothing. This is that host: the two seams the menu asks
 * for, plus the chips and the argument prompt they drive.
 *
 * Which tools appear is not decided here. `tools.list` returns only what
 * Notes' own `tools.call:<app>/<tool>` grants cover, so the manifest is the
 * allowlist; today that is one tool, Tasks' "Create task".
 *
 * Nothing a provider says at call time is shown. A success chip carries the
 * tool's screened DECLARATION title; a refusal chip carries Notes' own
 * wording for the named kind. The provider's error text is dropped at this
 * boundary, before it can reach React state.
 */

import type {
	ObjectMenuToolArgumentPrompt,
	ObjectMenuToolReporter,
} from "@brainstorm-os/sdk/object-menu";
import { useToolArgumentPrompt } from "@brainstorm-os/sdk/tool-arg-prompt";
import { ToolOutcomeChips, useToolOutcomes } from "@brainstorm-os/sdk/tool-outcome";
import { type ReactElement, useMemo } from "react";
import { t } from "../i18n/t";

/** What a Notes object menu needs to offer app tools at all. */
export type NoteToolSeams = {
	onToolResult: ObjectMenuToolReporter;
	onToolArguments: ObjectMenuToolArgumentPrompt;
};

export function useNoteTools(): { seams: NoteToolSeams; element: ReactElement } {
	const { outcomes, report, dismiss } = useToolOutcomes();
	const { promptForToolArgs, prompt } = useToolArgumentPrompt(t);

	const seams = useMemo<NoteToolSeams>(
		() => ({
			onToolResult: (outcome) => {
				if (outcome.ok) report({ ok: true, title: outcome.tool.title });
				else report({ ok: false, title: outcome.tool.title, kind: outcome.kind, message: "" });
			},
			onToolArguments: (tool, target) =>
				promptForToolArgs(tool, {
					target: {
						entityId: target.entityId,
						...(target.entityType ? { entityType: target.entityType } : {}),
					},
				}),
		}),
		[report, promptForToolArgs],
	);

	const element = (
		<>
			{prompt}
			<ToolOutcomeChips outcomes={outcomes} onDismiss={dismiss} t={t} />
		</>
	);
	return { seams, element };
}
