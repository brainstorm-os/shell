/**
 * Imperative bridge for mounting `<PresenceStack>` in a plain-DOM app header.
 * React apps use `usePresence` + `<PresenceStack>` directly; imperative apps
 * (Database) call `renderPresenceHeader` from their header refresh path.
 */

import { type Root, createRoot } from "react-dom/client";
import { PresenceStack } from "./presence-stack";
import { usePresence, useSelf } from "./use-presence";

const roots = new WeakMap<HTMLElement, Root>();

function PresenceHeaderMount({
	entityId,
	type,
}: {
	entityId: string | null;
	type: string;
}) {
	const self = useSelf();
	const peers = usePresence(entityId, type, self);
	if (peers.length === 0) return null;
	return <PresenceStack peers={peers} />;
}

/** Mount or update the presence stack inside `host`. Re-renders when the active
 *  entity changes; pass `null` entityId when nothing is open (inert channel). */
export function renderPresenceHeader(
	host: HTMLElement,
	entityId: string | null,
	type: string,
): void {
	let root = roots.get(host);
	if (!root) {
		root = createRoot(host);
		roots.set(host, root);
	}
	root.render(<PresenceHeaderMount entityId={entityId} type={type} />);
}

/** Tear down the host's React root (window close / app dispose). */
export function disposePresenceHeader(host: HTMLElement): void {
	const root = roots.get(host);
	if (!root) return;
	root.render(null);
	root.unmount();
	roots.delete(host);
}
