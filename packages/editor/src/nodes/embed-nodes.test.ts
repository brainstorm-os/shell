// @vitest-environment jsdom
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";
import { EmbedKind } from "../plugins/embed-providers";
import { $createBookmarkNode, $isBookmarkNode, BookmarkNode } from "./bookmark-node";
import { $createWebEmbedNode, $isWebEmbedNode, WebEmbedNode } from "./web-embed-node";

function editor(): LexicalEditor {
	return createHeadlessEditor({
		namespace: "e",
		nodes: [BookmarkNode, WebEmbedNode],
		onError: (err) => {
			throw err;
		},
	});
}

function roundTrip(e: LexicalEditor): LexicalEditor {
	const json = JSON.stringify(e.getEditorState().toJSON());
	const next = editor();
	next.setEditorState(next.parseEditorState(JSON.parse(json)));
	return next;
}

describe("BookmarkNode", () => {
	it("round-trips url + title + description", () => {
		const e = editor();
		e.update(
			() => {
				$getRoot().append($createBookmarkNode("https://x.com", "Title", "Desc"));
			},
			{ discrete: true },
		);
		roundTrip(e)
			.getEditorState()
			.read(() => {
				const node = $getRoot().getFirstChild();
				expect($isBookmarkNode(node)).toBe(true);
				if (!$isBookmarkNode(node)) return;
				expect(node.getUrl()).toBe("https://x.com");
				expect(node.exportJSON()).toMatchObject({
					type: "bookmark",
					url: "https://x.com",
					title: "Title",
					description: "Desc",
				});
			});
	});
});

describe("BookmarkNode embed hint", () => {
	function hintAfterImport(embedHint: unknown): unknown {
		const e = editor();
		e.setEditorState(
			e.parseEditorState(
				JSON.stringify({
					root: {
						type: "root",
						format: "",
						indent: 0,
						version: 1,
						direction: null,
						children: [{ type: "bookmark", version: 1, url: "", title: "", description: "", embedHint }],
					},
				}),
			),
		);
		let out: unknown;
		e.getEditorState().read(() => {
			const node = $getRoot().getFirstChild();
			out = $isBookmarkNode(node) ? node.exportJSON().embedHint : "not-a-bookmark";
		});
		return out;
	}

	it("round-trips a provider hint and omits the field on a plain bookmark", () => {
		const e = editor();
		e.update(
			() => {
				$getRoot().append(
					$createBookmarkNode("", "", "", EmbedKind.GoogleMaps),
					$createBookmarkNode("https://example.com"),
				);
			},
			{ discrete: true },
		);
		roundTrip(e)
			.getEditorState()
			.read(() => {
				const [hinted, plain] = $getRoot().getChildren();
				expect($isBookmarkNode(hinted) && hinted.exportJSON().embedHint).toBe(EmbedKind.GoogleMaps);
				expect($isBookmarkNode(plain) && "embedHint" in plain.exportJSON()).toBe(false);
			});
	});

	it("drops a hint that is not a catalogue provider", () => {
		expect(hintAfterImport(EmbedKind.YouTube)).toBe(EmbedKind.YouTube);
		for (const bogus of ["bookmark", "evil", "__proto__", "constructor", 7, null, { a: 1 }]) {
			expect(hintAfterImport(bogus), String(bogus)).toBeUndefined();
		}
	});
});

describe("WebEmbedNode", () => {
	it("round-trips url + embedUrl + kind and coerces a bad kind", () => {
		const e = editor();
		e.update(
			() => {
				$getRoot().append(
					$createWebEmbedNode(
						"https://youtu.be/dQw4w9WgXcQ",
						"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
						EmbedKind.YouTube,
					),
				);
			},
			{ discrete: true },
		);
		roundTrip(e)
			.getEditorState()
			.read(() => {
				const node = $getRoot().getFirstChild();
				expect($isWebEmbedNode(node)).toBe(true);
				if (!$isWebEmbedNode(node)) return;
				expect(node.exportJSON()).toMatchObject({
					type: "web-embed",
					kind: EmbedKind.YouTube,
					embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
				});
			});

		// A corrupt persisted `kind` coerces to Bookmark on parse.
		const corrupt = {
			root: {
				type: "root",
				format: "",
				indent: 0,
				version: 1,
				direction: null,
				children: [{ type: "web-embed", version: 1, url: "u", embedUrl: "e", kind: "bogus" }],
			},
		};
		const restored = editor();
		restored.setEditorState(restored.parseEditorState(JSON.stringify(corrupt)));
		restored.getEditorState().read(() => {
			const node = $getRoot().getFirstChild();
			expect($isWebEmbedNode(node) && node.exportJSON().kind).toBe(EmbedKind.Bookmark);
		});
	});

	function parseChild(serializedNode: Record<string, unknown>): WebEmbedNode | null {
		const e = editor();
		e.setEditorState(
			e.parseEditorState(
				JSON.stringify({
					root: {
						type: "root",
						format: "",
						indent: 0,
						version: 1,
						direction: null,
						children: [serializedNode],
					},
				}),
			),
		);
		let result: WebEmbedNode | null = null;
		e.getEditorState().read(() => {
			const node = $getRoot().getFirstChild();
			if ($isWebEmbedNode(node)) result = node;
		});
		return result;
	}

	it("drops an attacker-controlled embedUrl that classifyUrl does not produce", () => {
		// Hostile peer/clipboard payload: both url and embedUrl point at an
		// off-allowlist origin, with a forged YouTube kind to slip past the
		// kind coercion. The renderer must NOT iframe the attacker origin.
		const node = parseChild({
			type: "web-embed",
			version: 1,
			url: "https://attacker.example/evil",
			embedUrl: "https://attacker.example/evil",
			kind: EmbedKind.YouTube,
		});
		expect(node).not.toBeNull();
		if (!node) return;
		const json = node.exportJSON();
		expect(json.embedUrl).toBeNull();
		expect(json.kind).toBe(EmbedKind.Bookmark);
	});

	it("drops a forged allowlisted embedUrl when the source url is off-allowlist", () => {
		// url is hostile but embedUrl is a plausible youtube-nocookie string —
		// re-derivation from `url` must win, not the stored embedUrl.
		const node = parseChild({
			type: "web-embed",
			version: 1,
			url: "https://attacker.example/evil",
			embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
			kind: EmbedKind.YouTube,
		});
		expect(node).not.toBeNull();
		if (!node) return;
		expect(node.exportJSON().embedUrl).toBeNull();
	});

	it("re-derives a legitimate allowlisted embedUrl on import", () => {
		const node = parseChild({
			type: "web-embed",
			version: 1,
			url: "https://youtu.be/dQw4w9WgXcQ",
			// Deliberately wrong stored embedUrl — re-derivation must replace it.
			embedUrl: "https://attacker.example/evil",
			kind: EmbedKind.YouTube,
		});
		expect(node).not.toBeNull();
		if (!node) return;
		const json = node.exportJSON();
		expect(json.kind).toBe(EmbedKind.YouTube);
		expect(json.embedUrl).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
	});
});
