// @vitest-environment jsdom

/**
 * Click-navigation fence for the block-embed fallback card. The card carries a
 * `brainstorm://entity/<id>` href for keyboard / middle-click affordance, but a
 * plain left-click must dispatch the in-app open-entity intent (the renderer
 * does NOT navigate `brainstorm://` hrefs on its own). Without the onClick the
 * card looked clickable but did nothing — this pins that the click travels the
 * shared `dispatchOpenEntity` path (same as the transclusion card).
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setEditorHost } from "../plugins/editor-host";
import { BlockEmbedView, SHELL_ENTITY_CARD_BLOCK_ID } from "./block-embed-node";

const ENTITY = "n_target";
const TYPE = "io.brainstorm.notes/Note/v1";

type Harness = { container: HTMLDivElement; root: Root };
let harness: Harness;

beforeEach(() => {
	const container = document.createElement("div");
	document.body.append(container);
	harness = { container, root: createRoot(container) };
});

afterEach(() => {
	act(() => harness.root.unmount());
	harness.container.remove();
	setEditorHost({});
});

function render(): void {
	act(() => {
		harness.root.render(
			<BlockEmbedView
				blockId={SHELL_ENTITY_CARD_BLOCK_ID}
				entityId={ENTITY}
				entityType={TYPE}
				label="Link Target Note"
			/>,
		);
	});
}

describe("BlockEmbedView click navigation", () => {
	it("renders the fallback card with a brainstorm:// href", () => {
		render();
		const card = harness.container.querySelector<HTMLAnchorElement>("a.notes__embed-card");
		expect(card).not.toBeNull();
		expect(card?.getAttribute("href")).toBe(`brainstorm://entity/${ENTITY}`);
	});

	it("dispatches open-entity on a left-click instead of following the href", () => {
		const opened: { entityId: string; entityType?: string }[] = [];
		setEditorHost({ openEntity: (target) => opened.push(target) });
		render();
		const card = harness.container.querySelector<HTMLAnchorElement>("a.notes__embed-card");
		const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
		act(() => {
			card?.dispatchEvent(event);
		});
		expect(opened).toEqual([{ entityId: ENTITY, entityType: TYPE, mode: "replace" }]);
		expect(event.defaultPrevented).toBe(true);
	});
});
