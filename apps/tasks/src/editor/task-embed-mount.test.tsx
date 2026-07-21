/**
 * Mount fence for the inline-task embed (9.14.3) — proves that a
 * `TaskEmbedNode` resolving to a `BlockProtocol` provider lights up a live
 * `<BpBlockMount>` whose iframe loads the bundle over the `bsblock://` loader
 * (9.5.x), not the inert stub. Mirrors Notes' `block-embed-registry.test.tsx`.
 */

// @vitest-environment jsdom

import {
	BlockRendererKind,
	type BlockRendererRegistry,
	BlockRendererRegistryProvider,
	type BpResolver,
	DEFAULT_BUILTIN_CUSTOM_NODES,
	createBlockRendererRegistry,
} from "@brainstorm-os/sdk/block-registry";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $getRoot } from "lexical";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { $createTaskEmbedNode, SHELL_ENTITY_CARD_BLOCK_ID, TaskEmbedNode } from "./task-embed-node";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INLINE_TASK_BLOCK = "io.brainstorm.tasks/inline-task";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	// The embed fetches the block bundle via `services.blocks.source` before it
	// mounts the live iframe — stub a runtime that serves a tiny valid bundle so
	// the BlockProtocol path lights up under jsdom, plus `forType` so a fallback
	// embed re-resolves to the inline-task block.
	(window as unknown as { brainstorm?: unknown }).brainstorm = {
		services: {
			blocks: {
				source: async () => "/* inline-task bundle */",
				forType: async (type: string) => (type === "brainstorm/Task/v1" ? INLINE_TASK_BLOCK : null),
			},
		},
	};
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
});

function ComposerHost({
	embed,
}: {
	embed: { entityId: string; entityType: string; label: string; blockId: string };
}) {
	return (
		<LexicalComposer
			initialConfig={{
				namespace: "task-embed-mount-test",
				nodes: [TaskEmbedNode],
				onError: (e) => {
					throw e;
				},
				editorState: () => {
					$getRoot().append(
						$createTaskEmbedNode(embed.entityId, embed.entityType, embed.label, embed.blockId),
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

function card(): HTMLElement | null {
	return container.querySelector(".tasks-embed-card");
}

async function render(
	registry: BlockRendererRegistry,
	embed: { entityId: string; entityType: string; label: string; blockId: string },
): Promise<void> {
	await act(async () => {
		root.render(
			<BlockRendererRegistryProvider registry={registry}>
				<ComposerHost embed={embed} />
			</BlockRendererRegistryProvider>,
		);
	});
	await flush();
}

function inlineTaskRegistry(): BlockRendererRegistry {
	const resolver: BpResolver = async (blockId) =>
		blockId === INLINE_TASK_BLOCK ? { appId: "io.brainstorm.tasks", name: "inline-task" } : null;
	return createBlockRendererRegistry({
		builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES,
		bpResolver: resolver,
	});
}

describe("TaskEmbedView + inline-task loader", () => {
	it("mounts the inline-task block in a sandboxed iframe served by the bsblock:// loader", async () => {
		await render(inlineTaskRegistry(), {
			entityId: "task-7",
			entityType: "brainstorm/Task/v1",
			label: "Ship spec",
			blockId: INLINE_TASK_BLOCK,
		});
		await flush(20);
		const el = card();
		expect(el?.getAttribute("data-renderer-kind")).toBe(BlockRendererKind.BlockProtocol);
		expect(el?.classList.contains("tasks-embed-card--bp")).toBe(true);
		const mount = el?.querySelector(".tasks-embed-card-mount");
		expect(mount).not.toBeNull();
		const iframe = mount?.querySelector("iframe");
		expect(iframe).not.toBeNull();
		// Pinned 9.5.1 sandbox invariants — any drift breaks the threat model.
		expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
		expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(iframe?.getAttribute("loading")).toBe("lazy");
		// A live bundle loads from its own bsblock:// origin (escapes the embedder
		// CSP); the inert stub path keeps srcdoc.
		expect(iframe?.getAttribute("src")?.startsWith("bsblock://frame/")).toBe(true);
		expect(iframe?.hasAttribute("srcdoc")).toBe(false);
	});

	it("upgrades a fallback-card embed to the live inline-task block once the type provider exists", async () => {
		await render(inlineTaskRegistry(), {
			entityId: "task-9",
			entityType: "brainstorm/Task/v1",
			label: "Legacy embed",
			blockId: SHELL_ENTITY_CARD_BLOCK_ID,
		});
		await flush(20);
		const el = card();
		expect(el?.getAttribute("data-block-id")).toBe(INLINE_TASK_BLOCK);
		expect(el?.getAttribute("data-renderer-kind")).toBe(BlockRendererKind.BlockProtocol);
		expect(el?.querySelector(".tasks-embed-card-mount")).not.toBeNull();
	});

	it("stays a static card when the entity type has no live block provider", async () => {
		const registry = createBlockRendererRegistry({
			builtInCustomNodes: DEFAULT_BUILTIN_CUSTOM_NODES,
			bpResolver: async () => null,
		});
		(window as unknown as { brainstorm?: unknown }).brainstorm = {
			services: { blocks: { source: async () => "/* x */", forType: async () => null } },
		};
		await render(registry, {
			entityId: "task-3",
			entityType: "brainstorm/Task/v1",
			label: "No provider",
			blockId: SHELL_ENTITY_CARD_BLOCK_ID,
		});
		await flush(20);
		const el = card();
		expect(el?.classList.contains("tasks-embed-card--bp")).toBe(false);
		expect(el?.getAttribute("data-block-id")).toBe(SHELL_ENTITY_CARD_BLOCK_ID);
	});
});
