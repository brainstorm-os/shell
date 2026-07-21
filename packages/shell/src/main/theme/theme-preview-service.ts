/**
 * Transient cross-surface theme preview (9.9.6; OQ-170). An app with the
 * `theme.preview` capability asks the shell to paint a theme's token
 * overrides across the dashboard + every app window for a few seconds, then
 * auto-revert — without committing the active theme.
 *
 * The spec is sanitized through `@brainstorm-os/sdk-types` `sanitizeThemePreview`
 * (canonical token names + injection-safe values only) BEFORE it leaves this
 * process for the renderers — the trusted boundary, since the spec originates
 * in a sandboxed app. The fan-out (`broadcast`) and the auto-revert timer are
 * injected, so the whole preview→revert lifecycle is timer-free + unit-tested.
 */

import { type ThemePreviewSpec, sanitizeThemePreview } from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";

/** `null` payload = clear the preview (revert to the committed theme). */
export type PreviewBroadcast = (payload: ReturnType<typeof sanitizeThemePreview> | null) => void;

export type ThemePreviewTimers = {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
};

const realTimers: ThemePreviewTimers = {
	set: (cb, ms) => setTimeout(cb, ms),
	clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Owns the single active preview. A new `preview` replaces any in-flight
 * one (cancelling its revert timer); `clear` reverts immediately. At most
 * one timer is ever pending.
 */
export class ThemePreviewService {
	private timer: unknown = null;

	constructor(
		private readonly broadcast: PreviewBroadcast,
		private readonly timers: ThemePreviewTimers = realTimers,
	) {}

	preview(spec: ThemePreviewSpec): void {
		const payload = sanitizeThemePreview(spec);
		this.cancelTimer();
		this.broadcast(payload);
		this.timer = this.timers.set(() => {
			this.timer = null;
			this.broadcast(null);
		}, payload.durationMs);
	}

	clearPreview(): void {
		this.cancelTimer();
		this.broadcast(null);
	}

	/** Drop any pending revert without broadcasting (shutdown / dispose). */
	dispose(): void {
		this.cancelTimer();
	}

	private cancelTimer(): void {
		if (this.timer !== null) {
			this.timers.clear(this.timer);
			this.timer = null;
		}
	}
}

/**
 * Broker service handler for `theme`. Capability gating (`theme.preview`)
 * happens in the broker via the envelope's `caps`; the handler is thin —
 * route the method to the service. An unknown method returns `Invalid`.
 */
export function makeThemeServiceHandler(service: ThemePreviewService): ServiceHandler {
	return (envelope: Envelope): unknown => {
		switch (envelope.method) {
			case "preview": {
				const [arg] = envelope.args as [unknown];
				service.preview((arg ?? {}) as ThemePreviewSpec);
				return undefined;
			}
			case "clearPreview": {
				service.clearPreview();
				return undefined;
			}
			default: {
				const err = new Error(`unknown theme method: ${envelope.method}`);
				err.name = "Invalid";
				throw err;
			}
		}
	};
}
