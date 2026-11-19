// @vitest-environment jsdom

/**
 * The shared external-embed slash rows, driven end to end through a real
 * composer: `/youtube` → the provider's URL prompt → Save → an embed block
 * that is still an unloaded facade. Also pins what a provider row does with
 * a link the allowlist rejects (a bookmark card, never a frame).
 */

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $createParagraphNode, $getRoot, type LexicalEditor } from "lexical";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandCategory } from "./block-command";
import { createEditorT } from "./i18n";
import { $createBookmarkNode, $isBookmarkNode, BookmarkNode } from "./nodes/bookmark-node";
import { $createWebEmbedNode, $isWebEmbedNode, WebEmbedNode } from "./nodes/web-embed-node";
import { EmbedKind } from "./plugins/embed-providers";
import { fullEditorExtraCommands } from "./plugins/full-editor-plugins";
import { filterCommands } from "./slash-sections";
import { WEB_EMBED_COMMAND_IDS, createWebEmbedCommands } from "./web-embed-commands";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = createEditorT();
const commands = createWebEmbedCommands(t);

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let editor: LexicalEditor;

function Capture(): null {
	const [e] = useLexicalComposerContext();
	editor = e;
	return null;
}

beforeEach(async () => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root.render(
			<LexicalComposer
				initialConfig={{
					namespace: "web-embed-commands-test",
					nodes: [BookmarkNode, WebEmbedNode],
					onError: (e) => {
						throw e;
					},
					editorState: () => {
						const paragraph = $createParagraphNode();
						$getRoot().append(paragraph);
						paragraph.select();
					},
				}}
			>
				<RichTextPlugin
					contentEditable={<ContentEditable />}
					placeholder={null}
					ErrorBoundary={LexicalErrorBoundary}
				/>
				<Capture />
			</LexicalComposer>,
		);
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function flush(): Promise<void> {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 0));
	});
}

async function run(id: (typeof WEB_EMBED_COMMAND_IDS)[number]): Promise<void> {
	const command = commands.find((c) => c.id === id);
	if (!command) throw new Error(`missing command ${id}`);
	await act(async () => {
		command.run({ editor });
	});
	await flush();
}

function urlInput(): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>('input[type="url"]');
	if (!input) throw new Error("no URL prompt");
	return input;
}

async function saveUrl(url: string): Promise<void> {
	const input = urlInput();
	const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	await act(async () => {
		setValue?.call(input, url);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const save = container.querySelector<HTMLButtonElement>(".notes__bookmark-btn--primary");
	await act(async () => {
		save?.click();
	});
	await flush();
}

function firstBlock<T>(
	read: (node: ReturnType<ReturnType<typeof $getRoot>["getFirstChild"]>) => T,
): T {
	let out!: T;
	editor.getEditorState().read(() => {
		out = read($getRoot().getFirstChild());
	});
	return out;
}

describe("shared web-embed slash rows", () => {
	it("exposes the generic row and the two v1 provider rows under Embeds", () => {
		expect(commands.map((c) => c.id)).toEqual([...WEB_EMBED_COMMAND_IDS]);
		for (const c of commands) {
			expect(c.category).toBe(CommandCategory.Embed);
			expect(c.label.length).toBeGreaterThan(0);
			expect(c.description?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it("is what `/youtube`, `/maps` and a tier-2 provider name each resolve to first", () => {
		expect(filterCommands(commands, "youtube")[0]?.id).toBe("block.embed.youtube");
		expect(filterCommands(commands, "maps")[0]?.id).toBe("block.embed.maps");
		expect(filterCommands(commands, "bookmark")[0]?.id).toBe("block.embed.bookmark");
		for (const provider of ["spotify", "soundcloud", "codepen", "miro", "vimeo", "figma", "osm"]) {
			expect(filterCommands(commands, provider)[0]?.id, provider).toBe("block.embed.bookmark");
		}
	});

	it("reaches every full-editor host that leaves embeds on, and none that turns them off", () => {
		const on = fullEditorExtraCommands(t, { webEmbed: true }).map((c) => c.id);
		expect(on).toEqual([...WEB_EMBED_COMMAND_IDS]);
		expect(fullEditorExtraCommands(t, { webEmbed: false })).toEqual([]);
		expect(fullEditorExtraCommands(t, {})).toEqual([]);
	});

	it("`/youtube` opens the YouTube prompt and Save yields an unloaded embed block", async () => {
		await run("block.embed.youtube");
		expect(firstBlock((n) => $isBookmarkNode(n) && n.exportJSON().embedHint)).toBe(EmbedKind.YouTube);
		expect(urlInput().placeholder).toBe(t("editor.bookmark.urlPlaceholder.youtube"));

		await saveUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=tracking");
		expect(firstBlock((n) => ($isWebEmbedNode(n) ? n.exportJSON() : null))).toMatchObject({
			kind: EmbedKind.YouTube,
			embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
		});
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.querySelector(".notes__embed-facade")).not.toBeNull();
	});

	it("`/maps` embeds a place link, with Google Maps' own prompt", async () => {
		await run("block.embed.maps");
		expect(urlInput().placeholder).toBe(t("editor.bookmark.urlPlaceholder.googleMaps"));
		await saveUrl("https://www.google.com/maps/place/Berlin/@52.52,13.405,12z");
		expect(firstBlock((n) => $isWebEmbedNode(n) && n.exportJSON().kind)).toBe(EmbedKind.GoogleMaps);
		expect(container.querySelector("iframe")).toBeNull();
	});

	it("a provider row keeps a link the allowlist rejects as a bookmark card", async () => {
		await run("block.embed.maps");
		await saveUrl("https://maps.app.goo.gl/AbCdEf123");
		expect(firstBlock((n) => $isBookmarkNode(n) && n.getUrl())).toBe(
			"https://maps.app.goo.gl/AbCdEf123",
		);
		expect(container.querySelector("iframe")).toBeNull();
		expect(container.querySelector(".notes__embed-facade")).toBeNull();
	});

	it("the generic row saves an embeddable link as a card that offers the embed", async () => {
		await run("block.embed.bookmark");
		expect(urlInput().placeholder).toBe(t("editor.bookmark.urlPlaceholder"));
		await saveUrl("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
		expect(firstBlock((n) => $isBookmarkNode(n))).toBe(true);
		const convert = [...container.querySelectorAll<HTMLButtonElement>(".notes__bookmark-edit")].find(
			(b) => b.textContent === t("editor.bookmark.convertEmbed"),
		);
		expect(convert).toBeDefined();
		await act(async () => {
			convert?.click();
		});
		await flush();
		expect(firstBlock((n) => $isWebEmbedNode(n) && n.exportJSON().kind)).toBe(EmbedKind.Spotify);
		expect(container.querySelector("iframe")).toBeNull();
	});
});

describe("embed decorators with non-string synced fields", () => {
	it("render a safe fallback for any JSON value a peer can write, without throwing", async () => {
		const errors: unknown[] = [];
		const stop = editor.registerUpdateListener(() => undefined);
		const onError = (event: ErrorEvent) => errors.push(event.error);
		window.addEventListener("error", onError);
		for (const hostile of [42, null, { href: "https://youtu.be/dQw4w9WgXcQ" }, ["x"], true]) {
			const bad = hostile as unknown as string;
			await act(async () => {
				editor.update(() => {
					$getRoot()
						.clear()
						.append($createWebEmbedNode(bad, bad, EmbedKind.YouTube), $createBookmarkNode(bad, bad, bad));
				});
			});
			await flush();
			expect(container.querySelector(".notes__embed--link"), String(hostile)).not.toBeNull();
			expect(container.querySelector(".notes__bookmark"), String(hostile)).not.toBeNull();
			expect(container.querySelector("iframe"), String(hostile)).toBeNull();
			expect(container.querySelector("a[href]"), String(hostile)).toBeNull();
		}
		window.removeEventListener("error", onError);
		stop();
		expect(errors).toEqual([]);
	});
});
