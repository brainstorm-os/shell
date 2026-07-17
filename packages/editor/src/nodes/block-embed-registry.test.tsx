/**
 * Integration fence for the 9.4.3 registry bridge inside `BlockEmbedNode`'s
 * decorator. The headless JSON suite in `block-embed-node.test.ts` covers
 * shape; this file mounts the live `<BlockEmbedView>` under jsdom + the
 * `<BlockRendererRegistryProvider>` and verifies the `data-renderer-kind`
 * attribute reflects what the registry resolved.
 */

// @vitest-environment jsdom

import {
	BlockRendererKind,
	type BlockRendererRegistry,
	BlockRendererRegistryProvider,
	type BpResolver,
	DEFAULT_BUILTIN_CUSTOM_NODES,
	SHELL_ENTITY_CARD_BLOCK_ID,
	createBlockRendererRegistry,
} from "@brainstorm/sdk/block-registry";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $getRoot } from "lexical";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setEditorHost } from "../plugins/editor-host";
import { $createBlockEmbedNode, BlockEmbedNode } from "./block-embed-node";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	// `BlockEmbedView` fetches the block bundle via the editor host's
	// `blocks.source` before it mounts the live iframe — stub a host that
	// returns a tiny valid bundle so the BlockProtocol path can light up
	// under jsdom.
	setEditorHost({
		blocks: { source: async () => "/* test block bundle */", forType: async () => null },
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	setEditorHost({});
});

function ComposerHost({
	embed,
}: {
	embed: { entityId: string; entityType: string; label: string; blockId: string };
}) {
	return (
		<LexicalComposer
			initialConfig={{
				namespace: "be-registry-test",
				nodes: [BlockEmbedNode],
				onError: (e) => {
					throw e;
				},
				editorState: () => {
					$getRoot().append(
						$createBlockEmbedNode(embed.entityId, embed.entityType, embed.label, embed.blockId),
					);
				},
			}}
		>
			<RichTextPlugin
				contentEditable={<ContentEditable data-testid="ce" />}
				placeholder={null}
				ErrorBoundary={LexicalErrorBoundary}
			/>
		</LexicalComposer>
	);
}

async function flush(ms = 0): Promise<void> {
	await act(async () => {
		await new Promise((r) => setTimeout(r, ms));
	});
}

function embedCard(): HTMLElement | null {
	return container.querySelector(".notes__embed-card");
}

async function render(
	registry: BlockRendererRegistry | null,
	embed: { entityId: string; entityType: string; label: string; blockId: string },
): Promise<void> {
	const tree = <ComposerHost embed={embed} />;
	const wrapped = registry ? (
		<BlockRendererRegistryProvider registry={registry}>{tree}</BlockRendererRegistryProvider>
	) : (
		tree
	);
	await act(async () => {
		root.render(wrapped);
	});
	await flush();
}

describe("BlockEmbedView + registry bridge", () => {
	it("resolves the shell entity-card id as a CustomNode kind", async () => {
		const registry = createBlockRendererRegistry({
			builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES,
		});
		await render(registry, {
			entityId: "ent_q3",
			entityType: "io.brainstorm.whiteboard/Board/v1",
			label: "Q3 board",
			blockId: SHELL_ENTITY_CARD_BLOCK_ID,
		});
		const card = embedCard();
		expect(card).not.toBeNull();
		expect(card?.getAttribute("data-renderer-kind")).toBe(BlockRendererKind.CustomNode);
	});

	it("falls back to NoProvider when no registry provider is mounted", async () => {
		await render(null, {
			entityId: "ent_q3",
			entityType: "io.brainstorm.whiteboard/Board/v1",
			label: "Q3 board",
			blockId: SHELL_ENTITY_CARD_BLOCK_ID,
		});
		const card = embedCard();
		expect(card?.getAttribute("data-renderer-kind")).toBe(BlockRendererKind.Fallback);
	});

	it("surfaces BlockProtocol for a provider-resolved blockId and shows the 'provided by' subtitle", async () => {
		const resolver: BpResolver = async () => ({
			appId: "io.brainstorm.tasks",
			name: "list",
		});
		const registry = createBlockRendererRegistry({
			builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES,
			bpResolver: resolver,
		});
		await render(registry, {
			entityId: "ent_q3",
			entityType: "io.brainstorm.tasks/List/v1",
			label: "Sprint todos",
			blockId: "io.brainstorm.tasks/list",
		});
		// Allow the async resolve to land.
		await flush(20);
		const card = embedCard();
		expect(card?.getAttribute("data-renderer-kind")).toBe(BlockRendererKind.BlockProtocol);
		const subtitle = card?.querySelector(".notes__embed-card-type");
		expect(subtitle?.textContent).toContain("io.brainstorm.tasks");
	});

	it("9.11 — BlockProtocol resolution mounts a sandboxed iframe (mount path end-to-end)", async () => {
		// The 9.11 wire-up: when the registry says BlockProtocol, the
		// BlockEmbedView switches to the bp variant and renders a live
		// `<BpBlockMount>`. The iframe MUST carry the 9.5.1 pinned
		// sandbox / referrerpolicy / loading / srcdoc-not-src attributes
		// — those are security-relevant invariants and any drift breaks
		// the threat model the 9.5 trio closed.
		const resolver: BpResolver = async () => ({
			appId: "io.brainstorm.tasks",
			name: "list",
		});
		const registry = createBlockRendererRegistry({
			builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES,
			bpResolver: resolver,
		});
		await render(registry, {
			entityId: "ent_q3",
			entityType: "io.brainstorm.tasks/List/v1",
			label: "Sprint todos",
			blockId: "io.brainstorm.tasks/list",
		});
		await flush(20);
		const card = embedCard();
		expect(card?.classList.contains("notes__embed-card--bp")).toBe(true);
		const mount = card?.querySelector(".notes__embed-card-mount");
		expect(mount).not.toBeNull();
		const iframe = mount?.querySelector("iframe");
		expect(iframe).not.toBeNull();
		expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
		expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(iframe?.getAttribute("loading")).toBe("lazy");
		// A live bundle loads from its own bsblock:// origin (escapes the
		// embedder CSP); the inert stub path keeps srcdoc. Here a bundle is
		// stubbed, so the frame carries the bsblock src, not srcdoc.
		expect(iframe?.getAttribute("src")?.startsWith("bsblock://frame/")).toBe(true);
		expect(iframe?.hasAttribute("srcdoc")).toBe(false);
		// The chrome anchor still points at the entity URI so keyboard /
		// click navigation reaches the underlying entity even when the
		// iframe absorbs pointer events inside its own surface.
		const chrome = card?.querySelector(".notes__embed-card-chrome");
		expect(chrome?.getAttribute("href")).toContain("brainstorm://entity/ent_q3");
	});

	it("upgrades a fallback-card embed to the live block once a type provider exists (F-140)", async () => {
		// An embed inserted before the provider registered froze the fallback
		// card id. The provider now claims `brainstorm/List/v1` via `forType`;
		// the SAME persisted node (still holding SHELL_ENTITY_CARD_BLOCK_ID) must
		// re-resolve and light up the live block, not stay a static card.
		const DB_BLOCK = "io.brainstorm.database/embedded-list";
		setEditorHost({
			blocks: {
				source: async () => "/* test block bundle */",
				forType: async (type: string) => (type === "brainstorm/List/v1" ? DB_BLOCK : null),
			},
		});
		const resolver: BpResolver = async (blockId) =>
			blockId === DB_BLOCK ? { appId: "io.brainstorm.database", name: "embedded-list" } : null;
		const registry = createBlockRendererRegistry({
			builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES,
			bpResolver: resolver,
		});
		await render(registry, {
			entityId: "ent_clients",
			entityType: "brainstorm/List/v1",
			label: "Clients",
			blockId: SHELL_ENTITY_CARD_BLOCK_ID,
		});
		await flush(20);
		const card = embedCard();
		expect(card?.getAttribute("data-renderer-kind")).toBe(BlockRendererKind.BlockProtocol);
		expect(card?.getAttribute("data-block-id")).toBe(DB_BLOCK);
		expect(card?.classList.contains("notes__embed-card--bp")).toBe(true);
		expect(card?.querySelector(".notes__embed-card-mount")).not.toBeNull();
	});

	it("leaves a fallback-card embed as a card when no type provider exists", async () => {
		// The re-resolution must NOT manufacture a live mount for a type nobody
		// provides — a Note embed stays the generic card.
		setEditorHost({
			blocks: { source: async () => "/* bundle */", forType: async () => null },
		});
		const registry = createBlockRendererRegistry({
			builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES,
			bpResolver: async () => null,
		});
		await render(registry, {
			entityId: "ent_note",
			entityType: "io.brainstorm.notes/Note/v1",
			label: "A note",
			blockId: SHELL_ENTITY_CARD_BLOCK_ID,
		});
		await flush(20);
		const card = embedCard();
		expect(card?.classList.contains("notes__embed-card--bp")).toBe(false);
		expect(card?.getAttribute("data-block-id")).toBe(SHELL_ENTITY_CARD_BLOCK_ID);
	});

	it("surfaces Fallback{Invalid} for a malformed blockId without calling the resolver", async () => {
		let calls = 0;
		const resolver: BpResolver = async () => {
			calls += 1;
			return null;
		};
		const registry = createBlockRendererRegistry({
			builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES,
			bpResolver: resolver,
		});
		await render(registry, {
			entityId: "ent_q3",
			entityType: "io.brainstorm.notes/Note/v1",
			label: "Broken",
			blockId: "no-slash-here",
		});
		await flush();
		const card = embedCard();
		expect(card?.getAttribute("data-renderer-kind")).toBe(BlockRendererKind.Fallback);
		expect(calls).toBe(0);
	});
});
