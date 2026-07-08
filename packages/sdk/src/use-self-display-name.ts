/**
 * The local user's display name for authoring surfaces (a posted comment's
 * author, an optimistic echo, …). F-165: comment authors rendered as
 * "Anonymous" because `localPresenceName()` reads a renderer-local
 * `localStorage` pref that nothing sets. The signed vault profile
 * (`roster.self().displayName`, Collab-C6) is the real identity, so this
 * hook prefers it, falls back to the short key fingerprint when the name is
 * unset (honest — it's your key, not "Anonymous"), and only falls back to
 * `localPresenceName()` when the roster is unavailable (an older shell or a
 * renderer without `roster.read`).
 *
 * The self profile is fetched once per roster identity; a live re-fetch on
 * a Settings rename isn't needed for authoring (the name at post time is
 * what's stamped), so this stays a thin read.
 */

import type { RosterService } from "@brainstorm/sdk-types";
import { useEffect, useState } from "react";
import { localPresenceName } from "./peer-presence";

export function useSelfDisplayName(roster: RosterService | null): string {
	const [name, setName] = useState<string>(() => localPresenceName());
	useEffect(() => {
		if (!roster) return;
		let cancelled = false;
		void roster
			.self()
			.then((self) => {
				if (cancelled) return;
				const resolved = self.displayName?.trim() || self.fingerprint;
				if (resolved) setName(resolved);
			})
			.catch(() => {
				// `roster.read` denied / older shell — keep the localPresence fallback.
			});
		return () => {
			cancelled = true;
		};
	}, [roster]);
	return name;
}
