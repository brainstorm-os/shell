// @vitest-environment jsdom
/**
 * Backlinks click-routing regression. The backlinks section renders
 * *outside* the Lexical contenteditable, so the editor-root click
 * interceptor (bound to `editor.getRootElement()`) never sees these
 * clicks. Before the fix the row's only handler was the `<a href>`, so
 * a click escaped to a raw `brainstorm://entity/<id>` navigation that
 * 404s at the shell protocol handler ("clicked a link and got to
 * nowhere").
 *
 * What this proves:
 *   - A plain click on a backlink row is prevented (no navigation) and
 *     dispatches the shared `open` intent with the row's id + type.
 *   - A modifier-held click (Cmd) passes through (not prevented, no
 *     dispatch) so power users keep "open in new window".
 */

import { setEditorHost, setEntityIndexSource } from "@brainstorm-os/editor";
import { openEntity } from "@brainstorm-os/sdk";
import type { VaultEntity } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BacklinksPlugin } from "./backlinks-plugin";

const CURRENT = "release-hub";
const SOURCE_ID = "n_planning";
const SOURCE_TYPE = "io.brainstorm.notes/Note/v1";

function snapshotWithBacklink(): { entities: readonly VaultEntity[] } {
	return {
		entities: [
			{
				id: SOURCE_ID,
				type: SOURCE_TYPE,
				properties: {
					title: "Planning",
					body: {
						root: {
							type: "root",
							children: [{ type: "mention", entityId: CURRENT, entityType: SOURCE_TYPE }],
						},
					},
				},
			} as unknown as VaultEntity,
		],
	};
}

let container: HTMLDivElement;
let root: Root;
const dispatch = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
	dispatch.mockClear();
	// The shared vault-entity index is source-injected now (no longer self-
	// started off window.brainstorm) — wire it to the mock for this test.
	setEntityIndexSource({
		list: () => Promise.resolve(snapshotWithBacklink()),
		onChange: () => ({ unsubscribe: () => {} }),
	});
	// Open-entity navigation routes through the host bridge → the SDK
	// `openEntity` (which produces the `{verb:"open", payload}` intent) →
	// the dispatch mock, mirroring the real app wiring (notes/main.tsx).
	setEditorHost({
		openEntity: (target) => {
			void openEntity({ services: { intents: { dispatch } } }, target);
		},
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	setEntityIndexSource(null);
	setEditorHost({});
});

async function mountAndGetRow(): Promise<HTMLAnchorElement> {
	await act(async () => {
		root.render(<BacklinksPlugin currentNoteId={CURRENT} />);
	});
	// Flush the entity-title-index async refresh so the row renders.
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
	const anchor = container.querySelector<HTMLAnchorElement>("a.notes__backlinks-item");
	if (!anchor) throw new Error("backlink row did not render");
	return anchor;
}

describe("BacklinksPlugin click routing", () => {
	it("prevents navigation and dispatches the shared open intent", async () => {
		const anchor = await mountAndGetRow();
		expect(anchor.getAttribute("href")).toBe(`brainstorm://entity/${SOURCE_ID}`);

		const event = new MouseEvent("click", { bubbles: true, cancelable: true });
		await act(async () => {
			anchor.dispatchEvent(event);
			await Promise.resolve();
		});

		expect(event.defaultPrevented).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledWith({
			verb: "open",
			payload: { entityId: SOURCE_ID, entityType: SOURCE_TYPE },
		});
	});

	it("passes a modifier-held click through to the browser", async () => {
		const anchor = await mountAndGetRow();

		const event = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
		await act(async () => {
			anchor.dispatchEvent(event);
			await Promise.resolve();
		});

		expect(event.defaultPrevented).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
	});
});
