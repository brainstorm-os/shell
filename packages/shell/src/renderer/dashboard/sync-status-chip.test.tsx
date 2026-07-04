/**
 * `<SyncStatusChip>` — dashboard sync chip pure-render tests.
 *
 * The chip reads from `useSyncStatus()` in production but accepts an
 * `override` for stories + tests so we can pin a state without driving
 * IPC. SSR rendering matches the renderer's first paint shape.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IconName } from "../ui/icon";
import { SyncStatusChip, iconForState } from "./sync-status-chip";
import { SyncState, type SyncStatusSnapshot } from "./use-sync-status";

function snap(partial: Partial<SyncStatusSnapshot>): SyncStatusSnapshot {
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

describe("iconForState", () => {
	it("returns Cloud for Syncing", () => {
		expect(iconForState(SyncState.Syncing)).toBe(IconName.Cloud);
	});
	it("returns CloudSlash for Stale + Offline", () => {
		expect(iconForState(SyncState.Stale)).toBe(IconName.CloudSlash);
		expect(iconForState(SyncState.Offline)).toBe(IconName.CloudSlash);
	});
	it("returns Warning for Error", () => {
		expect(iconForState(SyncState.Error)).toBe(IconName.Warning);
	});
	it("returns Lock for LocalOnly", () => {
		expect(iconForState(SyncState.LocalOnly)).toBe(IconName.Lock);
	});
});

describe("<SyncStatusChip>", () => {
	it("renders null when derivedState is null", () => {
		const html = renderToStaticMarkup(
			<SyncStatusChip override={{ snapshot: null, derivedState: null }} />,
		);
		expect(html).toBe("");
	});

	it("renders the Syncing label and state class", () => {
		const html = renderToStaticMarkup(
			<SyncStatusChip
				override={{ snapshot: snap({ state: SyncState.Syncing }), derivedState: SyncState.Syncing }}
			/>,
		);
		expect(html).toContain('data-testid="sync-status-chip"');
		expect(html).toContain('data-state="syncing"');
		expect(html).toContain("sync-status-chip--syncing");
		expect(html).toContain("Syncing");
	});

	it("renders the Stale label + state class", () => {
		const html = renderToStaticMarkup(
			<SyncStatusChip override={{ snapshot: snap({}), derivedState: SyncState.Stale }} />,
		);
		expect(html).toContain('data-state="stale"');
		expect(html).toContain("Stale");
	});

	it("renders LocalOnly with quiet styling (no badge)", () => {
		const html = renderToStaticMarkup(
			<SyncStatusChip override={{ snapshot: snap({}), derivedState: SyncState.LocalOnly }} />,
		);
		expect(html).toContain('data-state="local-only"');
		expect(html).toContain("sync-status-chip--quiet");
		expect(html).toContain("Local only");
	});

	it("renders the Error state in its own state class", () => {
		const html = renderToStaticMarkup(
			<SyncStatusChip override={{ snapshot: snap({}), derivedState: SyncState.Error }} />,
		);
		expect(html).toContain('data-state="error"');
		expect(html).toContain("sync-status-chip--error");
		expect(html).toContain("Error");
	});

	it("label carries aria-live=polite for screen-reader transitions", () => {
		const html = renderToStaticMarkup(
			<SyncStatusChip override={{ snapshot: snap({}), derivedState: SyncState.Syncing }} />,
		);
		expect(html).toContain('aria-live="polite"');
	});
});
