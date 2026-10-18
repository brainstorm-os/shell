// @vitest-environment jsdom
import { FILE_ENTITY_TYPE, type VaultEntity } from "@brainstorm-os/sdk-types";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	type LexicalEditor,
	type SerializedEditorState,
	createEditor,
} from "lexical";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pickerCalls: Array<{
	filter: (q: string) => readonly { id: string; label: string; disabled?: boolean }[];
	onSelect: (id: string) => void;
}> = [];

vi.mock("@brainstorm-os/sdk/menus", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@brainstorm-os/sdk/menus")>();
	return {
		...actual,
		openSearchPicker: (opts: (typeof pickerCalls)[number]) => {
			pickerCalls.push(opts);
			return true;
		},
	};
});

import { createEditorT } from "./i18n";
import { $placeMediaBlock, createMediaBlockCommands } from "./media-commands";
import { AudioBlockNode } from "./nodes/audio-block-node";
import { FileBlockNode } from "./nodes/file-block-node";
import { $createImageBlockNode, ImageBlockNode } from "./nodes/image-block-node";
import {
	$createInlineImageNode,
	InlineImageNode,
	clampInlineImageHeight,
} from "./nodes/inline-image-node";
import { VideoBlockNode } from "./nodes/video-block-node";
import { setEntityIndexSource } from "./plugins/entity-index";
import { serializedStateToHtml } from "./serialize-html";
import { serializedStateToMarkdown } from "./serialize-markdown";
import { VaultMediaFilter, filterVaultMedia, vaultMediaFromEntity } from "./vault-media";
import { vaultMediaRows } from "./vault-media-picker";

const ASSET = "0123abcd-0123-4567-89ab-0123456789ab";

function file(id: string, props: Record<string, unknown>): VaultEntity {
	return { id, type: FILE_ENTITY_TYPE, properties: props } as unknown as VaultEntity;
}

const PHOTO = file("f1", { name: "Beach.png", assetId: ASSET, assetMime: "image/png", size: 2048 });
const DOC = file("f2", { name: "Report.pdf", assetId: ASSET, assetMime: "application/pdf" });
const SVG = file("f3", {
	name: "logo.svg",
	assetId: ASSET,
	mime: "image/svg+xml",
	assetMime: "application/octet-stream",
});
const NOTE = {
	id: "n1",
	type: "io.brainstorm.notes/Note/v1",
	properties: { title: "Beach" },
} as unknown as VaultEntity;

describe("vaultMediaFromEntity", () => {
	it("maps a File/v1 row to its served asset URL and MIME", () => {
		expect(vaultMediaFromEntity(PHOTO)).toEqual({
			id: "f1",
			name: "Beach.png",
			url: `brainstorm://asset/${ASSET}`,
			mime: "image/png",
			size: 2048,
		});
	});

	it("rejects non-file entities, malformed asset ids and foreign attachment URLs", () => {
		expect(vaultMediaFromEntity(NOTE)).toBeNull();
		expect(
			vaultMediaFromEntity(file("x", { assetId: "../../etc", assetMime: "image/png" })),
		).toBeNull();
		expect(
			vaultMediaFromEntity(file("y", { attachment: "javascript:alert(1)", mime: "image/png" })),
		).toBeNull();
	});
});

describe("filterVaultMedia", () => {
	const all = [PHOTO, DOC, SVG, NOTE];

	it("Image keeps only images the asset protocol serves as images (no SVG)", () => {
		expect(filterVaultMedia(all, VaultMediaFilter.Image, "").map((m) => m.id)).toEqual(["f1"]);
	});

	it("Any keeps every file, title-filtered", () => {
		expect(
			filterVaultMedia(all, VaultMediaFilter.Any, "")
				.map((m) => m.id)
				.sort(),
		).toEqual(["f1", "f2", "f3"]);
		expect(filterVaultMedia(all, VaultMediaFilter.Any, "rep").map((m) => m.id)).toEqual(["f2"]);
	});

	it("rows carry a disabled empty-state line when nothing matches", () => {
		const t = createEditorT();
		expect(vaultMediaRows([], VaultMediaFilter.Image, "", t)[0]).toMatchObject({ disabled: true });
		expect(vaultMediaRows([], VaultMediaFilter.Any, "zz", t)[0]?.label).toContain("zz");
	});
});

const NODES = [ImageBlockNode, InlineImageNode, VideoBlockNode, AudioBlockNode, FileBlockNode];

function editor(): LexicalEditor {
	return createEditor({
		namespace: "vault-media",
		nodes: NODES,
		onError: (e) => {
			throw e;
		},
	});
}

function types(e: LexicalEditor): string[] {
	return e.getEditorState().read(() =>
		$getRoot()
			.getChildren()
			.map((c) => c.getType()),
	);
}

describe("$placeMediaBlock", () => {
	it("replaces an empty target paragraph, inserts after a non-empty one", () => {
		const e = editor();
		let emptyKey = "";
		let fullKey = "";
		e.update(
			() => {
				const empty = $createParagraphNode();
				const full = $createParagraphNode().append($createTextNode("keep"));
				$getRoot().append(empty, full);
				emptyKey = empty.getKey();
				fullKey = full.getKey();
			},
			{ discrete: true },
		);
		e.update(() => $placeMediaBlock($createImageBlockNode("brainstorm://asset/a"), emptyKey), {
			discrete: true,
		});
		expect(types(e)).toEqual(["image-block", "paragraph"]);
		e.update(() => $placeMediaBlock($createImageBlockNode("brainstorm://asset/b"), fullKey), {
			discrete: true,
		});
		expect(types(e)).toEqual(["image-block", "paragraph", "image-block"]);
	});
});

describe("vault media commands", () => {
	beforeEach(() => {
		pickerCalls.length = 0;
		vi.useFakeTimers();
		setEntityIndexSource({
			list: async () => ({ entities: [PHOTO, DOC] }),
			onChange: () => ({ unsubscribe: () => undefined }),
		});
	});
	afterEach(() => {
		vi.useRealTimers();
		setEntityIndexSource(null);
	});

	async function run(id: string, e: LexicalEditor): Promise<void> {
		const command = createMediaBlockCommands(createEditorT()).find((c) => c.id === id);
		await command?.run({ editor: e });
		await vi.runAllTimersAsync();
	}

	function seeded(text: string): LexicalEditor {
		const e = editor();
		e.update(
			() => {
				const p = $createParagraphNode().append($createTextNode(text));
				$getRoot().append(p);
				p.selectEnd();
			},
			{ discrete: true },
		);
		return e;
	}

	it("Image from vault lists vault images and inserts the pick as an image block", async () => {
		const e = seeded("");
		await run("block.media.image.vault", e);
		const call = pickerCalls[0];
		expect(call?.filter("").map((r) => r.id)).toEqual(["f1"]);
		call?.onSelect("f1");
		expect(types(e)).toEqual(["image-block"]);
	});

	it("File from vault inserts a non-image as a file block", async () => {
		const e = seeded("");
		await run("block.media.file.vault", e);
		pickerCalls[0]?.filter("");
		pickerCalls[0]?.onSelect("f2");
		expect(types(e)).toEqual(["file-block"]);
	});

	it("Inline image lands inside the caret's paragraph", async () => {
		const e = seeded("see ");
		await run("block.media.image.inline", e);
		pickerCalls[0]?.filter("");
		pickerCalls[0]?.onSelect("f1");
		const inline = e.getEditorState().read(() => {
			const p = $getRoot().getFirstChildOrThrow();
			return p.getType() === "paragraph"
				? (p as unknown as { getChildren(): { getType(): string }[] })
						.getChildren()
						.map((c) => c.getType())
				: [];
		});
		expect(inline).toEqual(["text", "inline-image"]);
	});
});

describe("InlineImageNode", () => {
	it("is inline, round-trips through JSON and clamps its height", () => {
		const e = editor();
		e.update(
			() => {
				$getRoot().append(
					$createParagraphNode().append($createInlineImageNode("brainstorm://asset/x", "x", 99)),
				);
			},
			{ discrete: true },
		);
		const json = e.getEditorState().toJSON() as SerializedEditorState;
		const next = editor();
		next.setEditorState(next.parseEditorState(json));
		const node = next.getEditorState().read(() => {
			const p = $getRoot().getFirstChildOrThrow() as unknown as { getFirstChild(): InlineImageNode };
			return p.getFirstChild();
		});
		expect(node.isInline()).toBe(true);
		expect(node.getHeightEm()).toBe(4);
		expect(clampInlineImageHeight("nope")).toBe(1.25);
	});

	it("exports to HTML and Markdown, as do block images", () => {
		const state = {
			root: {
				children: [
					{
						type: "paragraph",
						children: [
							{ type: "text", text: "a " },
							{ type: "inline-image", src: "brainstorm://asset/x", alt: "logo", heightEm: 1.5 },
						],
					},
					{
						type: "image-block",
						src: "brainstorm://asset/y",
						alt: "beach",
						caption: "Sun",
						widthPercent: 50,
					},
					{ type: "image-block", src: "javascript:alert(1)", alt: "x" },
				],
			},
		};
		const html = serializedStateToHtml(state);
		expect(html).toContain('<img src="brainstorm://asset/x" alt="logo" style="height:1.5em');
		expect(html).toContain(
			'<figure><img src="brainstorm://asset/y" alt="beach" style="width:50%" />',
		);
		expect(html).toContain("<figcaption>Sun</figcaption>");
		expect(html).not.toContain("javascript");
		const md = serializedStateToMarkdown(state);
		expect(md).toContain("a ![logo](brainstorm://asset/x)");
		expect(md).toContain("![beach](brainstorm://asset/y)\n\n*Sun*");
	});
});
