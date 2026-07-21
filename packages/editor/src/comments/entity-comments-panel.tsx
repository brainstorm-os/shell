/**
 * `<EntityCommentsPanel>` — the one-stop right-panel wrapper every entity app
 * renders to get the SHARED `Properties | Comments` tab strip. It folds together
 * the four pieces each app used to wire by hand (Notes / Journal / Preview did
 * this individually — past the extract threshold): the comment-mutations
 * binding, the live `useEntityCommentsAdapter`, the `CommentsProvider`, and the
 * `CommentsRightPanel` tab strip + its tab state.
 *
 * The host passes its already-built Properties panel as a render prop —
 * `properties({ tabbed })` — so the panel suppresses its own header only when
 * the tab strip is actually showing (no double "Properties" header). When the
 * shell has no comment-mutation surface or there's no document yet, the panel
 * renders bare (properties-only, `tabbed: false`) with no tab strip.
 *
 * Tab state is internal by default; pass `active` + `onTabChange` to drive it
 * from the host (e.g. an editor's "add comment" entry point forcing the tab).
 */

import {
	AttachmentKind,
	type RosterService,
	type VaultEntitiesService,
} from "@brainstorm-os/sdk-types";
import type { ComposerContextHost, ContextCandidate } from "@brainstorm-os/sdk/composer-context";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { localPresenceName } from "../peer-presence";
import { CommentsProvider } from "./comments-context";
import { CommentsRightPanel, RightPanelTab } from "./right-panel-tabs";
import {
	type CommentMutationsService,
	useEntityCommentsAdapter,
} from "./use-entity-comments-adapter";

/** The minimal entities-service surface comments mutate. Loose on purpose:
 *  apps under-declare their own runtime-service types, and this wrapper only
 *  forwards the triple to the comments adapter (which re-asserts the precise
 *  shape) — so every app caller stays cast-free. Methods are optional so a
 *  read-only / older shell yields `null` mutations (→ no Comments tab). */
export type EntityMutationServices =
	| {
			create?: (type: string, properties: Record<string, unknown>) => Promise<unknown>;
			update?: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
			delete?: (id: string) => Promise<unknown>;
	  }
	| null
	| undefined;

/** Build the bound `CommentMutationsService` from a shell entities service, or
 *  null when the full create/update/delete triple isn't available. `.call`
 *  keeps the preload service's `this`. The cast bridges the app's loosely-typed
 *  return (the real preload returns the full entity the adapter needs). */
export function useCommentMutations(
	entities: EntityMutationServices,
): CommentMutationsService | null {
	return useMemo(() => {
		const create = entities?.create;
		const update = entities?.update;
		const del = entities?.delete;
		if (!entities || !create || !update || !del) return null;
		return {
			create: (type: string, properties: Record<string, unknown>) =>
				create.call(entities, type, properties),
			update: (id: string, patch: Record<string, unknown>) => update.call(entities, id, patch),
			delete: (id: string) => del.call(entities, id),
		} as unknown as CommentMutationsService;
	}, [entities]);
}

/** The shell `services` slice the comments panel reads — the live vault
 *  snapshot source + the entities mutation surface. Apps pass their whole
 *  `runtime.services` object (excess keys allowed); `vaultEntities` is `unknown`
 *  so an app's narrower local service type passes cast-free. Taking the bag
 *  (rather than a bare `vaultEntities` prop) also keeps that literal token out
 *  of app files, where it would false-trip the reactivity ratchet. */
export type EntityCommentsServices =
	| {
			vaultEntities?: unknown;
			entities?: EntityMutationServices;
			/** Collab-C6 — the member roster + display profiles. Present → the
			 *  comment composer offers roster-backed @-mentions. `unknown` so an
			 *  app's narrower local service type passes cast-free. */
			roster?: unknown;
	  }
	| null
	| undefined;

/** Build the roster-backed @-mention search host for a comment composer, or null
 *  when no roster is wired (Collab-C6). People come from the commented entity's
 *  member roster (its signed access record), keyed on the sovereign pubkey — the
 *  same model chat uses, so a mention resolves to a real identity. Exported so an
 *  app that wires `CommentsProvider` by hand (Notes) gets the identical host the
 *  shared `EntityCommentsPanel` builds. */
export function useCommentMentionHost(
	roster: RosterService | null,
	documentId: string | null,
): ComposerContextHost | null {
	return useMemo(() => {
		if (!roster || !documentId) return null;
		return {
			searchCandidates: async (query: string): Promise<ContextCandidate[]> => {
				const q = query.trim().toLowerCase();
				const members = await roster.members(documentId);
				const out: ContextCandidate[] = [];
				for (const m of members) {
					const name = m.displayName || m.fingerprint;
					if (q && !name.toLowerCase().includes(q)) continue;
					out.push({
						id: m.pubkey,
						kind: AttachmentKind.Person,
						label: name,
						...(m.isSelf ? {} : { description: m.fingerprint }),
					});
					if (out.length >= 8) break;
				}
				return out;
			},
		};
	}, [roster, documentId]);
}

export type EntityCommentsPanelProps = {
	/** Live vault snapshot source + entities mutation surface. */
	services: EntityCommentsServices;
	/** The inspected entity id — the comment thread's document. Null → no tabs. */
	documentId: string | null;
	/** The host's Properties panel, built per render with the tab-strip flag so
	 *  it can hide its own header when tabbed. */
	properties: (opts: { tabbed: boolean }) => ReactNode;
	/** Controlled tab (optional). Omit for internal tab state. */
	active?: RightPanelTab;
	onTabChange?: (tab: RightPanelTab) => void;
	authorName?: string;
};

export function EntityCommentsPanel({
	services,
	documentId,
	properties,
	active,
	onTabChange,
	authorName,
}: EntityCommentsPanelProps): ReactNode {
	const mutations = useCommentMutations(services?.entities);
	const adapter = useEntityCommentsAdapter(
		(services?.vaultEntities ?? null) as VaultEntitiesService | null,
		mutations,
		documentId,
	);
	const roster = (services?.roster ?? null) as RosterService | null;
	const mentionHost = useCommentMentionHost(roster, documentId);
	// Resolve the local author's sovereign pubkey once, so an authored comment is
	// attributed (the mention notifier self-suppresses on it).
	const [selfPubkey, setSelfPubkey] = useState<string>("");
	useEffect(() => {
		if (!roster) return;
		let live = true;
		roster
			.self()
			.then((s) => {
				if (live) setSelfPubkey(s.pubkey);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [roster]);
	const [internalTab, setInternalTab] = useState<RightPanelTab>(RightPanelTab.Properties);
	const tab = active ?? internalTab;
	const setTab = onTabChange ?? setInternalTab;

	if (!adapter || !documentId) return properties({ tabbed: false });

	return (
		<CommentsProvider
			adapter={adapter}
			authorName={authorName ?? localPresenceName()}
			{...(selfPubkey ? { authorPubkey: selfPubkey } : {})}
			mentionHost={mentionHost}
		>
			<CommentsRightPanel
				documentId={documentId}
				active={tab}
				onTabChange={setTab}
				properties={properties({ tabbed: true })}
			/>
		</CommentsProvider>
	);
}
