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
 *   - a tool with a REQUIRED input is a command only when the host supplies
 *     `promptForArgs` (Tool-8b — `useToolArgumentPrompt` is the drop-in);
 *     without the seam it stays excluded, since a menu activation alone
 *     carries no arguments;
 *   - approval is the SHELL's question, asked on activation.
 */

import type { AppToolRecord } from "@brainstorm-os/sdk-types";
import { ActionTrustTier, AppToolSurface, sanitizeAppLabel } from "@brainstorm-os/sdk-types";
import type { ReactNode } from "react";
import { canPromptForTool } from "./tool-arg-prompt/arg-prompt-logic";

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
	/** The lister-stamped tier (never the provider's claim; absent reads as
	 *  sideloaded). Carried so a host whose row chrome CAN render a trust badge
	 *  or a quarantine group does — the flat `label` cannot (see
	 *  `appToolCommands` on the residual). */
	trustTier: ActionTrustTier;
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
	call: (input: {
		tool: string;
		args?: Readonly<Record<string, unknown>>;
	}) => Promise<{ value: unknown }>;
	/** Where the outcome goes. REQUIRED, not optional: `tools.call` refuses
	 *  with named errors, and a swallowed refusal is a menu row that silently
	 *  does nothing. */
	report: (outcome: AppToolCommandOutcome) => void;
	/** Collect a tool's declared arguments (Tool-8b). Present ⇒ tools with
	 *  required inputs become commands that prompt on activation; absent ⇒
	 *  they are not offered. Resolve `null` for a cancel — no call, no
	 *  report. */
	promptForArgs?: (tool: AppToolRecord) => Promise<Readonly<Record<string, unknown>> | null>;
};

/** Can a menu activation (plus the host's argument prompt, when it has one)
 *  invoke this tool? Mirrors the object menu's rule. */
function invocableFromMenu(tool: AppToolRecord, canPrompt: boolean): boolean {
	if (tool.declarationInvalid) return false;
	if (!tool.surfaces.includes(AppToolSurface.Menu)) return false;
	if (!tool.input.some((input) => input.required)) return true;
	return canPrompt && canPromptForTool(tool.input);
}

/**
 * Project tools into commands the editor surfaces already know how to render.
 *
 * The label carries the provider (`<title> — <provider>`) for the same reason
 * the object menu does: two apps may offer a same-titled tool, and without
 * attribution the rows are indistinguishable — including telling a trusted
 * provider from a sideloaded one. The attribution half is `sanitizeAppLabel`ed
 * (a manifest `name` is otherwise validated only as "a non-empty string"),
 * falling back to the registry-minted app id.
 *
 * KNOWN RESIDUAL (same one the object menu documents): `label` is one flat
 * string because `BlockCommand` has no second element per row, so a title may
 * itself contain " — " and READ like another provider's attribution. The
 * separator cannot be refused (the repo's own example title is
 * "Rewrite — tone"); the real fix is a command row that renders attribution
 * as a separate muted element. Until then this is a visible-text spoof
 * against a length-capped, invisible-text-screened string — and `trustTier`
 * is carried on the command so a host can badge or group sideloaded tools
 * the way the object menu's quarantine does. Sideloaded tools also sort
 * AFTER first-party/verified ones here, so they never outrank them in a
 * surface without groups.
 */
export function appToolCommands(input: AppToolCommandsInput): AppToolCommand[] {
	const canPrompt = input.promptForArgs !== undefined;
	const tier = (tool: AppToolRecord) => tool.trustTier ?? ActionTrustTier.Sideloaded;
	const rank = (tool: AppToolRecord) => (tier(tool) === ActionTrustTier.Sideloaded ? 1 : 0);
	return [...input.tools]
		.sort((a, b) => rank(a) - rank(b))
		.filter((tool) => invocableFromMenu(tool, canPrompt))
		.map((tool) => {
			const provider = sanitizeAppLabel(tool.appLabel) ?? tool.appId;
			return {
				id: tool.id,
				category: input.category,
				label: `${tool.title} — ${provider}`,
				description: tool.description,
				icon: input.icon,
				trustTier: tier(tool),
				// Searchable in the slash menu by the tool's own words and its provider.
				keywords: [tool.title, tool.name, provider].map((k) => k.toLowerCase()),
				run: () =>
					(async () => {
						// Tool-8b — a required input collects its value first. A cancelled
						// prompt is a user backing out of the menu: no call, no report.
						let args: Readonly<Record<string, unknown>> | undefined;
						if (tool.input.some((i) => i.required)) {
							const collected = await input.promptForArgs?.(tool);
							if (collected === null || collected === undefined) return;
							args = collected;
						}
						const result = await input.call({
							tool: tool.id,
							...(args !== undefined ? { args } : {}),
						});
						input.report({ tool, ok: true, value: result.value });
					})().catch((error: unknown) => {
						const kind = error instanceof Error && error.name ? error.name : "Error";
						// Provider-authored text — reported as DATA, never interpreted.
						const message = error instanceof Error ? error.message : String(error);
						input.report({ tool, ok: false, kind, message });
					}),
			};
		});
}
