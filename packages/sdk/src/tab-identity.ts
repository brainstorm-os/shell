/**
 * publishTabIdentity — the ONE way an app labels its tab (and the OS window)
 * with the open object's name + icon. The shell reads `document.title` via
 * `page-title-updated` and the favicon via `page-favicon-updated` (see
 * `@brainstorm-os/sdk-types` tab-identity for the favicon codec), so this is
 * pure DOM — no IPC, no capability.
 *
 * Call it whenever the open object changes (or its name/icon edits land):
 *
 *   publishTabIdentity({ title: fileName, icon: row.icon });
 *
 * Pass `icon: null` (or omit) when the object has none — the helper still
 * writes the explicit "no icon" favicon so a previously-published icon is
 * cleared (removing the `<link>` would not re-fire the Electron event).
 */

import type { Icon } from "@brainstorm-os/sdk-types";
import { tabFaviconUrl } from "@brainstorm-os/sdk-types";

export type TabIdentity = {
	/** The open object's display name (tab label + OS window title). */
	title: string;
	/** The object's own universal icon, or null/absent for none. */
	icon?: Icon | null;
};

const LINK_MARKER = "data-bs-tab-icon";

export function publishTabIdentity(identity: TabIdentity): void {
	if (document.title !== identity.title) document.title = identity.title;
	const href = tabFaviconUrl(identity.icon ?? null);
	let link = document.head.querySelector<HTMLLinkElement>(`link[rel="icon"][${LINK_MARKER}]`);
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		link.setAttribute(LINK_MARKER, "");
		document.head.appendChild(link);
	}
	if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}
