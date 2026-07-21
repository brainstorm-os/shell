/**
 * The `WebView` host-service contract — the **chrome-only / shell-engine
 * split keystone** (§The core tension).
 *
 * Browser-1 first froze this contract here as app-local types. Browser-2
 * lifted it to a shared wire-types home (`@brainstorm-os/sdk-types`) so the
 * shell-side host service imports the *same* enums; this module now re-exports
 * from there, keeping the app's import path stable and the frozen wire values
 * identical. The chrome drives the host through {@link WebViewMethod} calls and
 * receives only {@link WebViewEvent} *metadata* events — never the page DOM or
 * bytes. The dangerous engine is shell-side, exactly like Mailbox.
 */

export {
	SitePermissionKind,
	WEB_BROWSE_CAP,
	WEB_CAPTURE_CAP,
	WebViewEventKind,
	WebViewMethod,
} from "@brainstorm-os/sdk-types";
export type { WebViewEvent, WebViewRect, WebViewRequest } from "@brainstorm-os/sdk-types";
