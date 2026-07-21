/**
 * `<PresenceStack>` — the who's-here avatar cluster for a shared entity
 * (design [73 sibling] presence; the visible half of live collaboration).
 *
 * Deliberately over a **defined `PresencePeer[]` contract**, NOT raw Yjs
 * awareness states: the awareness→peers mapping (what each client publishes,
 * how self is identified, name/colour resolution against the roster) is the
 * live-wiring rung's job — pinning it here would guess a payload shape that
 * doesn't exist yet. This module owns only the pure list math (`capPresence`)
 * + the presentation, so it's testable without the relay and reusable by any
 * app header the wiring feeds.
 *
 * Colours are literal hex on the peer (from `@brainstorm-os/sdk/peer-presence`'s
 * `peerColor`), applied inline — the same rationale as peer-presence: cursor/
 * overlay renderers write `color` straight into styles, so a `var(--…)` would
 * paint nothing. Chrome (ring, overlap, `+N` chip) uses theme tokens.
 */

import type { JSX } from "react";
import "./presence-stack.css";

/** One present collaborator, already resolved by the caller (wiring rung). */
export type PresencePeer = {
	/** Stable identity for dedup — the member's sovereign pubkey (NOT the Yjs
	 *  client id, so a peer's multiple tabs collapse to one avatar). */
	id: string;
	name: string;
	/** Literal hex (peerColor). */
	color: string;
	/** `brainstorm://asset/…` avatar, if the peer has one. */
	avatarRef?: string;
};

export type PresenceSummary = {
	/** Distinct peers to show, capped at `max`, first-seen order preserved. */
	shown: PresencePeer[];
	/** How many distinct peers didn't fit (the `+N` chip; 0 when none). */
	overflow: number;
};

/**
 * Reduce a peer list to a deduped, capped summary. De-dupes by `id`
 * (first-wins, order preserved) so multiple tabs/devices of one person collapse
 * to a single avatar. `max` bounds the visible avatars; the rest become
 * `overflow`. `max <= 0` shows none (all overflow).
 */
export function capPresence(peers: readonly PresencePeer[], max: number): PresenceSummary {
	const distinct: PresencePeer[] = [];
	const seen = new Set<string>();
	for (const p of peers) {
		if (seen.has(p.id)) continue;
		seen.add(p.id);
		distinct.push(p);
	}
	if (max <= 0) return { shown: [], overflow: distinct.length };
	return { shown: distinct.slice(0, max), overflow: Math.max(0, distinct.length - max) };
}

/** Up-to-two-letter initials for an avatar fallback, from a display name.
 *  (Mirrors the chat app's local `initials`; consolidate chat onto this.) */
export function presenceInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
	return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
}

export type PresenceStackProps = {
	peers: readonly PresencePeer[];
	/** Max avatars before collapsing to `+N`. Default 3. */
	max?: number;
	/** Resolve a peer's `avatarRef` to a displayable URL; when omitted (or it
	 *  returns null) the initials-on-colour fallback renders. */
	resolveAvatar?: (avatarRef: string) => string | null;
	/** Accessible label; default derives "N people here". */
	label?: string;
};

export function PresenceStack({
	peers,
	max = 3,
	resolveAvatar,
	label,
}: PresenceStackProps): JSX.Element | null {
	const { shown, overflow } = capPresence(peers, max);
	const total = shown.length + overflow;
	if (total === 0) return null;
	const groupLabel = label ?? `${total} ${total === 1 ? "person" : "people"} here`;
	return (
		<div className="bs-presence" role="group" aria-label={groupLabel}>
			{shown.map((p) => {
				const src = p.avatarRef && resolveAvatar ? resolveAvatar(p.avatarRef) : null;
				return (
					<span
						key={p.id}
						className="bs-presence__avatar"
						style={{ backgroundColor: src ? undefined : p.color }}
						title={p.name}
						aria-label={p.name}
					>
						{src ? <img className="bs-presence__img" src={src} alt="" /> : presenceInitials(p.name)}
					</span>
				);
			})}
			{overflow > 0 ? (
				<span className="bs-presence__more" title={`${overflow} more`} aria-hidden="true">
					{`+${overflow}`}
				</span>
			) : null}
		</div>
	);
}
