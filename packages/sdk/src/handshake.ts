/**
 * App handshake encoding — the SDK ships both `encodeHandshake` (used by
 * the shell's main process when spawning an app window) and
 * `decodeHandshake` (used by the app preload to rebuild the runtime).
 *
 * Lives in the SDK package so the preload can decode without reaching back
 * into the shell's main-process code — `main/apps/launcher.ts` imports
 * `node:path` and other node built-ins that aren't resolvable from a
 * sandboxed preload, and used to be the home of these helpers.
 *
 * Base64-encoded JSON keeps the value robust against shell-arg quoting on
 * every platform. The unicode-safe trick (`unescape(encodeURIComponent(json))`)
 * avoids `btoa`'s "Latin-1 only" restriction; deprecated but works in every
 * runtime the SDK targets (browsers, Node 16+, Electron sandboxed preloads).
 */

import type { AppHandshake } from "@brainstorm-os/sdk-types";

export function encodeHandshake(handshake: AppHandshake): string {
	const json = JSON.stringify(handshake);
	return btoa(unescape(encodeURIComponent(json)));
}

export function decodeHandshake(encoded: string): AppHandshake {
	const json = decodeURIComponent(escape(atob(encoded)));
	return JSON.parse(json) as AppHandshake;
}
