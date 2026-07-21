/**
 * `<SyncStatusPopover>` — SSR-rendered tests for each state + the
 * relay-host extractor + relative-age formatter. Negative pin: the
 * seq-state diagnostic shows count + bytes only; no pubkey-shaped
 * substring leaks through.
 */

import { AttachmentSyncPauseReason } from "@brainstorm-os/protocol/sync-status-types";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SyncStatusPopover, formatRelativeAge, relayUrlHost } from "./sync-status-popover";
import { SyncState, type SyncStatusSnapshot } from "./use-sync-status";

function snap(partial: Partial<SyncStatusSnapshot> = {}): SyncStatusSnapshot {
	return {
		state: SyncState.Syncing,
		transportState: null,
		relayUrl: null,
		connectionId: null,
		lastInboundAtMs: null,
		lastOutboundAtMs: null,
		droppedSends: 0,
		droppedInbound: 0,
		seqStateBytes: 0,
		pairKeyCount: 0,
		attachmentSyncPausedReason: null,
		...partial,
	};
}

describe("relayUrlHost", () => {
	it("returns host for a valid URL", () => {
		expect(relayUrlHost("wss://relay.example.test:7780/ws")).toBe("relay.example.test:7780");
	});
	it("returns null for null", () => {
		expect(relayUrlHost(null)).toBeNull();
	});
	it("returns the raw value for an unparseable URL", () => {
		expect(relayUrlHost("not a url")).toBe("not a url");
	});
});

describe("formatRelativeAge", () => {
	it("returns 'Never' for null", () => {
		expect(formatRelativeAge(null, 1_000)).toMatch(/never/i);
	});
	it("returns just-now for an age < 5 seconds", () => {
		expect(formatRelativeAge(1_000, 1_001)).toMatch(/just now/i);
	});
	it("returns seconds-ago for an age in 5..60s", () => {
		expect(formatRelativeAge(1_000, 11_000)).toMatch(/10s/);
	});
	it("returns minutes-ago for an age >= 60s", () => {
		expect(formatRelativeAge(1_000, 121_000)).toMatch(/2m/);
	});
	it("returns hours-ago for an age >= 60m", () => {
		expect(formatRelativeAge(1_000, 1_000 + 3_600_000)).toMatch(/1h/);
	});
});

describe("<SyncStatusPopover>", () => {
	it("renders the popover chrome", () => {
		const html = renderToStaticMarkup(
			<SyncStatusPopover
				snapshot={snap({})}
				derivedState={SyncState.Syncing}
				onClose={() => undefined}
			/>,
		);
		expect(html).toContain('role="dialog"');
		expect(html).toContain('data-testid="sync-status-popover"');
	});

	it("renders LocalOnly with the 'No relay configured' copy and hides traffic rows", () => {
		const html = renderToStaticMarkup(
			<SyncStatusPopover
				snapshot={snap({})}
				derivedState={SyncState.LocalOnly}
				onClose={() => undefined}
			/>,
		);
		expect(html).toContain("No relay configured");
		expect(html).not.toContain("Last inbound");
		expect(html).not.toContain("Last outbound");
	});

	it("renders Offline with the relay host + traffic rows", () => {
		const html = renderToStaticMarkup(
			<SyncStatusPopover
				snapshot={snap({ relayUrl: "wss://relay.example.test:7780/path" })}
				derivedState={SyncState.Offline}
				onClose={() => undefined}
			/>,
		);
		expect(html).toContain("relay.example.test:7780");
		expect(html).toContain("Last inbound");
		expect(html).toContain("Last outbound");
	});

	it("renders Stale + Syncing variants", () => {
		const stale = renderToStaticMarkup(
			<SyncStatusPopover
				snapshot={snap({ relayUrl: "wss://r.test" })}
				derivedState={SyncState.Stale}
				onClose={() => undefined}
			/>,
		);
		expect(stale).toContain("Stale");
		const syncing = renderToStaticMarkup(
			<SyncStatusPopover
				snapshot={snap({ relayUrl: "wss://r.test" })}
				derivedState={SyncState.Syncing}
				onClose={() => undefined}
			/>,
		);
		expect(syncing).toContain("Syncing");
	});

	it("shows dropped-sends only when nonzero", () => {
		const zero = renderToStaticMarkup(
			<SyncStatusPopover
				snapshot={snap({ relayUrl: "wss://r.test", droppedSends: 0 })}
				derivedState={SyncState.Syncing}
				onClose={() => undefined}
			/>,
		);
		expect(zero).not.toContain("Dropped sends");
		const nonzero = renderToStaticMarkup(
			<SyncStatusPopover
				snapshot={snap({ relayUrl: "wss://r.test", droppedSends: 17 })}
				derivedState={SyncState.Syncing}
				onClose={() => undefined}
			/>,
		);
		expect(nonzero).toContain("Dropped sends");
		expect(nonzero).toContain("17");
	});

	it("shows the quota pause line only when attachment sync is paused (14.7)", () => {
		const paused = renderToStaticMarkup(
			<SyncStatusPopover
				snapshot={snap({
					relayUrl: "wss://r.test",
					attachmentSyncPausedReason: AttachmentSyncPauseReason.StorageQuota,
				})}
				derivedState={SyncState.Syncing}
				onClose={() => undefined}
			/>,
		);
		expect(paused).toContain('data-testid="sync-status-popover-quota-paused"');
		expect(paused).toContain("Attachment sync paused");
		const unpaused = renderToStaticMarkup(
			<SyncStatusPopover
				snapshot={snap({ relayUrl: "wss://r.test" })}
				derivedState={SyncState.Syncing}
				onClose={() => undefined}
			/>,
		);
		expect(unpaused).not.toContain("sync-status-popover-quota-paused");
	});

	it("seq diagnostic renders count + bytes; no raw pubkey-shaped substring leaks", () => {
		const html = renderToStaticMarkup(
			<SyncStatusPopover
				snapshot={snap({ relayUrl: "wss://r.test", seqStateBytes: 2048, pairKeyCount: 7 })}
				derivedState={SyncState.Syncing}
				onClose={() => undefined}
			/>,
		);
		expect(html).toContain("2048");
		expect(html).toContain("7");
		// Negative pin: a base64-url shaped 43-char pubkey would mean we
		// leaked the raw seq-tracker key set into the popover.
		expect(html).not.toMatch(/[A-Za-z0-9_-]{43}/);
	});
});
