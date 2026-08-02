/**
 * App tools as editor block commands (Tool-7b, doc 78).
 *
 * `Tool-7` put menu-surfaced tools in the object ⋯ menu. The three EDITOR
 * surfaces — block-gutter menu, slash menu, inline toolbar — could not carry
 * them, because they are all driven by `BlockCommand`, whose `run` was
 * synchronous and void-returning: an app tool crosses the broker, may wait on
 * a shell-owned approval, and refuses with a NAMED error, and none of that fit
 * through a `void`.
 *
 * With `run` widened, a contributed command is just a `BlockCommand` an app
 * merges into the array it already passes to its editor plugins. The editor
 * itself learns nothing about tools — which is the point: `packages/editor` is
 * a library, and threading a vault runtime into it would invert that.
 *
 * The same rules `Tool-7` established apply unchanged, because they are
 * enforced where they belong rather than re-implemented here:
 *   - `tools.list` already drops tools this caller cannot CALL, tools whose
 *     provider is disabled or not running, and tools whose declaration failed
 *     to re-validate — so no row here is a dead one;
 *   - a tool with a REQUIRED input is still excluded, since a menu activation
 *     carries no arguments (the argument prompt is `Tool-8b`);
 *   - approval is the SHELL's question, asked on activation.
 */

import type { AppToolRecord } from "@brainstorm-os/sdk-types";
import { AppToolSurface } from "@brainstorm-os/sdk-types";
import type { ReactNode } from "react";

/** The `BlockCommand` shape, restated structurally so the SDK does not depend
 *  on `packages/editor` (the dependency runs the other way — apps compose
 *  both). Kept minimal on purpose: anything more would drift. */
export type AppToolCommand = {
	id: string;
	category: string;
	label: string;
	description?: string;
	icon: ReactNode;
	keywords: readonly string[];
	run: () => unknown;
};

export type AppToolCommandOutcome =
	| { tool: AppToolRecord; ok: true; value: unknown }
	| { tool: AppToolRecord; ok: false; kind: string; message: string };

export type AppToolCommandsInput = {
	tools: readonly AppToolRecord[];
	/** The category contributed commands land in. The host passes its own
	 *  `CommandCategory.Action` — the editor's enum is not reachable here. */
	category: string;
	/** Rendered glyph. One shared icon for every contributed command, so a
	 *  provider cannot pick its own prominence in someone else's editor. */
	icon: ReactNode;
	call: (input: { tool: string }) => Promise<{ value: unknown }>;
	/** Where the outcome goes. REQUIRED, not optional: `tools.call` refuses
	 *  with named errors, and a swallowed refusal is a menu row that silently
	 *  does nothing. */
	report: (outcome: AppToolCommandOutcome) => void;
};

/** Can a menu activation alone invoke this tool? Mirrors `Tool-7`'s rule. */
function invocableFromMenu(tool: AppToolRecord): boolean {
	if (tool.declarationInvalid) return false;
	if (!tool.surfaces.includes(AppToolSurface.Menu)) return false;
	return !tool.input.some((input) => input.required);
}

/**
 * Project tools into commands the editor surfaces already know how to render.
 *
 * The label carries the provider (`<title> — <provider>`) for the same reason
 * the object menu does: two apps may offer a same-titled tool, and without
 * attribution the rows are indistinguishable — including telling a trusted
 * provider from a sideloaded one.
 */
export function appToolCommands(input: AppToolCommandsInput): AppToolCommand[] {
	return input.tools.filter(invocableFromMenu).map((tool) => ({
		id: tool.id,
		category: input.category,
		label: `${tool.title} — ${tool.appLabel ?? tool.appId}`,
		description: tool.description,
		icon: input.icon,
		// Searchable in the slash menu by the tool's own words and its provider.
		keywords: [tool.title, tool.name, tool.appLabel ?? tool.appId].map((k) => k.toLowerCase()),
		run: () =>
			input
				.call({ tool: tool.id })
				.then((result) => input.report({ tool, ok: true, value: result.value }))
				.catch((error: unknown) => {
					const kind = error instanceof Error && error.name ? error.name : "Error";
					// Provider-authored text — reported as DATA, never interpreted.
					const message = error instanceof Error ? error.message : String(error);
					input.report({ tool, ok: false, kind, message });
				}),
	}));
}
