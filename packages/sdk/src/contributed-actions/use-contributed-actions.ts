/**
 * `useContributedActions` — the React host hook of the action surface (doc 63
 * §Host side). Given a `target` + the eligible `verbs`, it asks the shell's
 * `intents.suggestActions` (relevance-gated + trust-tagged + cap-checked there)
 * and returns the result already grouped + capped via the shared
 * `groupContributedActions` policy, ready to render.
 *
 * Reactive to the target: re-fetches whenever `target`/`verbs` change. A
 * `refresh()` is exposed so a host can re-pull after an install/uninstall (the
 * contribution index reflects only installed apps — doc 63 §Security). The
 * fetch is fail-soft: any throw / missing surface resolves to an empty surface,
 * never an error into the UI.
 */

import {
	AppToolSurface,
	type ContributedAction,
	type ContributedActionGroup,
	appToolToContributedAction,
	groupContributedActions,
} from "@brainstorm-os/sdk-types";

const APP_TOOL_MENU_SURFACE: string = AppToolSurface.Menu;
import { useCallback, useEffect, useRef, useState } from "react";
import type { UseContributedActionsInput } from "./types";

export type UseContributedActionsResult = {
	/** The flat, ranked, deduped contributions (pre-grouping) — for a host that
	 *  wants its own layout. */
	actions: ContributedAction[];
	/** The same contributions grouped + inline-capped + trust-quarantined (the
	 *  shared §Anti-rot policy) — the common render path. */
	groups: ContributedActionGroup[];
	/** Re-pull (e.g. after an app install/uninstall). */
	refresh: () => void;
};

export function useContributedActions(
	input: UseContributedActionsInput,
): UseContributedActionsResult {
	const { runtime, target, verbs } = input;
	const [actions, setActions] = useState<ContributedAction[]>([]);
	const [nonce, setNonce] = useState(0);
	const refresh = useCallback(() => setNonce((n) => n + 1), []);

	// Stable primitive deps so the effect re-runs only when the *values* change,
	// not on a fresh object identity each render (the caller usually passes a
	// literal `target`/`verbs`). The objects themselves are read through refs so
	// the effect's dependency list is exactly its trigger keys.
	const verbsKey = verbs.join(",");
	const targetKey = `${target.entityId ?? ""}|${target.entityType ?? ""}|${target.mime ?? ""}|${target.format ?? ""}`;
	const inputRef = useRef({ runtime, target, verbs });
	inputRef.current = { runtime, target, verbs };

	// biome-ignore lint/correctness/useExhaustiveDependencies: targetKey/verbsKey/nonce are the trigger signals; the live runtime/target/verbs are read through `inputRef` (the linter can't see them), so the keys must drive the re-fetch.
	useEffect(() => {
		const current = inputRef.current;
		const suggestActions = current.runtime?.services?.intents?.suggestActions;
		const listTools = current.runtime?.services?.appTools?.list;
		if (!suggestActions && !listTools) {
			setActions([]);
			return;
		}
		let cancelled = false;
		// Two sources, ONE ranked list. They are fetched together and merged
		// before grouping so the AS-4 inline cap counts intents and tools
		// against the same budget — two independently-capped blocks would be
		// twice the menu, which is the rot the policy exists to stop.
		const intents =
			suggestActions && current.verbs.length > 0
				? suggestActions({ target: current.target, verbs: current.verbs }).catch(
						() => [] as readonly ContributedAction[],
					)
				: Promise.resolve<readonly ContributedAction[]>([]);
		const tools = listTools
			? listTools({
					surface: APP_TOOL_MENU_SURFACE,
					...(current.target.entityType ? { appliesTo: current.target.entityType } : {}),
				})
					.then((rows) => rows.map(appToolToContributedAction))
					.catch(() => [] as ContributedAction[])
			: Promise.resolve<ContributedAction[]>([]);
		void Promise.all([intents, tools]).then(([a, b]) => {
			if (!cancelled) setActions([...a, ...b]);
		});
		return () => {
			cancelled = true;
		};
	}, [targetKey, verbsKey, nonce]);

	return { actions, groups: groupContributedActions(actions), refresh };
}
