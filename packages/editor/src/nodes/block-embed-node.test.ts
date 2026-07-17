// @vitest-environment jsdom
import { createHeadlessEditor } from "@lexical/headless";
import { $getRoot, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";
import {
	$createBlockEmbedNode,
	$isBlockEmbedNode,
	BLOCK_EMBED_DOM_FLAG,
	BLOCK_EMBED_DOM_FLAG_VALUE,
	BLOCK_EMBED_NODE_TYPE,
	BlockEmbedNode,
	SHELL_ENTITY_CARD_BLOCK_ID,
} from "./block-embed-node";

function editor(): LexicalEditor {
	return createHeadlessEditor({
		namespace: "be",
		nodes: [BlockEmbedNode],
		onError: (e) => {
			throw e;
		},
	});
}

/** Lexical requires an active editor while creating nodes (so it can issue a
 *  key + reach pending-state). The 9.4.2 HTML clipboard suite below pokes
 *  the converter functions directly — outside the editor's update/read flow
 *  — so it borrows a throwaway editor and runs the test body inside a
 *  `update()` transaction. */
function withEditor<T>(fn: () => T): T {
	const e = editor();
	let result: T | undefined;
	e.update(
		() => {
			result = fn();
		},
		{ discrete: true },
	);
	return result as T;
}

describe("BlockEmbedNode", () => {
	it("round-trips blockId / entityId / entityType / label and is a block node", () => {
		const e = editor();
		e.update(
			() => {
				$getRoot().append(
					$createBlockEmbedNode("ent_whiteboard1", "io.brainstorm.whiteboard/Board/v1", "Q3 board"),
				);
			},
			{ discrete: true },
		);
		const json = JSON.stringify(e.getEditorState().toJSON());

		const next = editor();
		next.setEditorState(next.parseEditorState(json));
		next.getEditorState().read(() => {
			const n = $getRoot().getFirstChild();
			expect($isBlockEmbedNode(n)).toBe(true);
			if (!$isBlockEmbedNode(n)) return;
			expect(n.isInline()).toBe(false);
			expect(n.isKeyboardSelectable()).toBe(true);
			expect(n.getBlockId()).toBe(SHELL_ENTITY_CARD_BLOCK_ID);
			expect(n.getEntityId()).toBe("ent_whiteboard1");
			expect(n.getEntityType()).toBe("io.brainstorm.whiteboard/Board/v1");
			expect(n.getLabel()).toBe("Q3 board");
			expect(n.getTextContent()).toBe("Q3 board");
			expect(n.exportJSON()).toMatchObject({
				type: BLOCK_EMBED_NODE_TYPE,
				version: 1,
				blockId: SHELL_ENTITY_CARD_BLOCK_ID,
				entityId: "ent_whiteboard1",
				entityType: "io.brainstorm.whiteboard/Board/v1",
				label: "Q3 board",
			});
		});
	});

	it("preserves a foreign blockId across round-trip (forward-compat for B9.5 BP blocks)", () => {
		const e = editor();
		e.update(
			() => {
				$getRoot().append(
					$createBlockEmbedNode(
						"ent_db1",
						"io.brainstorm.database/List/v1",
						"Tasks",
						"io.brainstorm.database/embedded-list/v1",
					),
				);
			},
			{ discrete: true },
		);
		const json = JSON.stringify(e.getEditorState().toJSON());
		const next = editor();
		next.setEditorState(next.parseEditorState(json));
		next.getEditorState().read(() => {
			const n = $getRoot().getFirstChild();
			expect($isBlockEmbedNode(n)).toBe(true);
			if (!$isBlockEmbedNode(n)) return;
			expect(n.getBlockId()).toBe("io.brainstorm.database/embedded-list/v1");
		});
	});

	it("caps every field at 1024 chars on import (hostile-body hardening)", () => {
		const e = editor();
		const oversize = "x".repeat(5000);
		e.setEditorState(
			e.parseEditorState(
				JSON.stringify({
					root: {
						type: "root",
						format: "",
						indent: 0,
						version: 1,
						direction: null,
						children: [
							{
								type: BLOCK_EMBED_NODE_TYPE,
								version: 1,
								blockId: oversize,
								entityId: oversize,
								entityType: oversize,
								label: oversize,
							},
						],
					},
				}),
			),
		);
		e.getEditorState().read(() => {
			const n = $getRoot().getFirstChild();
			expect($isBlockEmbedNode(n)).toBe(true);
			if (!$isBlockEmbedNode(n)) return;
			// Every field clamped — defence-in-depth so a malicious imported
			// body can't round-trip a multi-MB string into the vault graph.
			expect(n.getBlockId().length).toBe(1024);
			expect(n.getEntityId().length).toBe(1024);
			expect(n.getEntityType().length).toBe(1024);
			expect(n.getLabel().length).toBe(1024);
		});
	});

	it("coerces missing fields to safe defaults on import", () => {
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
						children: [{ type: BLOCK_EMBED_NODE_TYPE, version: 1 }],
					},
				}),
			),
		);
		e.getEditorState().read(() => {
			const n = $getRoot().getFirstChild();
			expect($isBlockEmbedNode(n)).toBe(true);
			if (!$isBlockEmbedNode(n)) return;
			// Empty blockId → defaults to the shell card id; the rest coerce to "".
			expect(n.getBlockId()).toBe(SHELL_ENTITY_CARD_BLOCK_ID);
			expect(n.getEntityId()).toBe("");
			expect(n.getEntityType()).toBe("");
			expect(n.getLabel()).toBe("");
		});
	});

	describe("HTML clipboard portability (9.4.2)", () => {
		it("exportDOM emits an <a> with the brainstorm:// href and all four data attrs", () => {
			withEditor(() => {
				const node = $createBlockEmbedNode(
					"ent_kanban1",
					"io.brainstorm.kanban/Board/v1",
					"Q3 board",
					"io.example.kanban/board/v1",
				);
				const { element } = node.exportDOM();
				expect(element).toBeInstanceOf(HTMLAnchorElement);
				if (!(element instanceof HTMLAnchorElement)) return;
				expect(element.tagName).toBe("A");
				expect(element.getAttribute("href")).toBe("brainstorm://entity/ent_kanban1");
				expect(element.getAttribute(BLOCK_EMBED_DOM_FLAG)).toBe("true");
				expect(element.getAttribute("data-block-id")).toBe("io.example.kanban/board/v1");
				expect(element.getAttribute("data-entity-id")).toBe("ent_kanban1");
				expect(element.getAttribute("data-entity-type")).toBe("io.brainstorm.kanban/Board/v1");
				expect(element.getAttribute("data-label")).toBe("Q3 board");
				// Visible card content includes the icon glyph + title + type
				// label (in that order) — the visual structure mirrors the
				// in-document `<BlockEmbedView>` so paste targets that strip
				// classes (Word / Docs / Gmail) still see a card, not a link.
				expect(element.textContent).toContain("Q3 board");
				expect(element.textContent).toContain("Board");
				// Card chrome carries inline styles because foreign rich-text
				// editors strip CSS classes on paste.
				expect(element.getAttribute("style")).toContain("border-radius");
				expect(element.children).toHaveLength(2);
				const [icon, body] = Array.from(element.children);
				expect(icon?.textContent?.length).toBeGreaterThan(0);
				expect(body?.children).toHaveLength(2);
				expect(body?.children[0]?.textContent).toBe("Q3 board");
				expect(body?.children[1]?.textContent).toBe("Board");
			});
		});

		it("exportDOM clamps each string field at MAX_FIELD_LEN (1024)", () => {
			withEditor(() => {
				const oversize = "x".repeat(5000);
				const node = $createBlockEmbedNode(oversize, oversize, oversize, oversize);
				const { element } = node.exportDOM();
				if (!(element instanceof HTMLAnchorElement)) {
					throw new Error("expected <a>");
				}
				expect((element.getAttribute("data-block-id") ?? "").length).toBe(1024);
				expect((element.getAttribute("data-entity-id") ?? "").length).toBe(1024);
				expect((element.getAttribute("data-entity-type") ?? "").length).toBe(1024);
				expect((element.getAttribute("data-label") ?? "").length).toBe(1024);
				// href carries the clamped entityId — so the clipboard payload
				// stays bounded even when the source field was hostile.
				expect(element.getAttribute("href")?.startsWith("brainstorm://entity/")).toBe(true);
				expect((element.getAttribute("href") ?? "").length).toBeLessThanOrEqual(
					"brainstorm://entity/".length + 1024,
				);
			});
		});

		it("exportDOM HTML-escapes the label (XSS regression-fence, broadened payload set)", () => {
			// Every payload below tests one regression-fence: if a future
			// refactor switches `strong.textContent = label` to `innerHTML`,
			// the corresponding `querySelector` would start finding the tag
			// embedded in the label and the test would fail. The narrow
			// `<script` substring is not enough — `<img onerror>` /
			// `<svg onload>` / `<iframe>` all bypass that, so we sweep the
			// realistic tag classes here.
			const payloads = [
				"<script>alert(1)</script>",
				'<img src=x onerror="alert(1)">',
				'<svg onload="alert(1)">',
				'<iframe srcdoc="<script>alert(1)</script>"></iframe>',
				"</strong></a><script>alert(1)</script>",
			];
			for (const evil of payloads) {
				withEditor(() => {
					const node = $createBlockEmbedNode("ent_evil", "io.brainstorm.notes/Note/v1", evil);
					const { element } = node.exportDOM();
					if (!(element instanceof HTMLAnchorElement)) {
						throw new Error("expected <a>");
					}
					expect(element.textContent).toContain(evil);
					// No dangerous tag should ever appear inside the exported
					// element — the visible label is text, never parsed HTML.
					expect(element.querySelector("script, img, svg, iframe, object, embed")).toBeNull();
					// data-label attribute round-trips the literal string.
					expect(element.getAttribute("data-label")).toBe(evil);
				});
			}
		});

		it("strips bidi-override / zero-width / control-code chars across import + export (Trojan-Source fence)", () => {
			// U+202E = RIGHT-TO-LEFT OVERRIDE; U+200B = ZWSP; U+0007 = BEL.
			// All MUST be stripped at every field boundary so the rendered
			// label can't visually masquerade as a different string.
			const evilLabel = "Q3-Budget‮evil​text";
			const evilId = "ent_‮hacker​";
			withEditor(() => {
				// Witness 1: exportDOM clamps both id and label clean on the
				// clipboard surface.
				const node = $createBlockEmbedNode(evilId, "io.brainstorm.notes/Note/v1", evilLabel);
				const { element } = node.exportDOM();
				if (!(element instanceof HTMLAnchorElement)) throw new Error("expected <a>");
				expect(element.getAttribute("data-label")).toBe("Q3-Budgeteviltext");
				// Visible title inside the card body is the clean string —
				// no bidi-override leaks into the rendered text.
				const titleSpan = element.children[1]?.children[0];
				expect(titleSpan?.textContent).toBe("Q3-Budgeteviltext");
				expect(element.getAttribute("data-entity-id")).toBe("ent_hacker");
			});
			// Witness 2: a hostile JSON body coming off-disk gets stripped on
			// the importJSON boundary too — defense-in-depth for vault sync.
			const eFresh = editor();
			eFresh.setEditorState(
				eFresh.parseEditorState(
					JSON.stringify({
						root: {
							type: "root",
							format: "",
							indent: 0,
							version: 1,
							direction: null,
							children: [
								{
									type: BLOCK_EMBED_NODE_TYPE,
									version: 1,
									blockId: SHELL_ENTITY_CARD_BLOCK_ID,
									entityId: evilId,
									entityType: "io.brainstorm.notes/Note/v1",
									label: evilLabel,
								},
							],
						},
					}),
				),
			);
			eFresh.getEditorState().read(() => {
				const n = $getRoot().getFirstChild();
				if (!$isBlockEmbedNode(n)) throw new Error("expected BlockEmbedNode");
				expect(n.getLabel()).toBe("Q3-Budgeteviltext");
				expect(n.getEntityId()).toBe("ent_hacker");
			});
		});

		it("exportDOM URL-encodes the entityId in the href (scheme-confusion fence)", () => {
			withEditor(() => {
				// `#` and `?` would otherwise truncate the URI parser; `/`
				// would let an attacker masquerade as a different path; the
				// `brainstorm:` prefix already defangs `javascript:` so the
				// remaining risk is confused-deputy via path/query split.
				const trickyId = "real_target#/../evil?spoof=1";
				const node = $createBlockEmbedNode(trickyId, "io.brainstorm.notes/Note/v1", "x");
				const { element } = node.exportDOM();
				if (!(element instanceof HTMLAnchorElement)) throw new Error("expected <a>");
				const href = element.getAttribute("href") ?? "";
				// No raw `#`, `?`, or `/` (other than the literal prefix slash)
				// from the entityId leaks into the URL.
				expect(href.startsWith("brainstorm://entity/")).toBe(true);
				const tail = href.slice("brainstorm://entity/".length);
				expect(tail).not.toContain("#");
				expect(tail).not.toContain("?");
				expect(tail).not.toContain("/");
				// Round-trips losslessly to the in-vault entityId.
				expect(decodeURIComponent(tail)).toBe(trickyId);
			});
		});

		it("importDOM ignores a plain <a> without the data-lexical-block-embed flag", () => {
			const map = BlockEmbedNode.importDOM();
			expect(map).not.toBeNull();
			if (!map) return;
			const aHandler = map.a;
			expect(typeof aHandler).toBe("function");
			if (typeof aHandler !== "function") return;
			const bare = document.createElement("a");
			bare.setAttribute("href", "https://example.com");
			// A plain link must not become a BlockEmbedNode — that's regular
			// link-paste territory.
			expect(aHandler(bare)).toBeNull();
		});

		it("importDOM rejects an <a> whose flag value is not exactly BLOCK_EMBED_DOM_FLAG_VALUE", () => {
			const map = BlockEmbedNode.importDOM();
			if (!map) throw new Error("expected importDOM map");
			const aHandler = map.a;
			if (typeof aHandler !== "function") throw new Error("expected `a` handler");
			// Attacker shapes — flag is present but with the wrong value —
			// must NOT be smuggled through.
			for (const wrong of ["false", "", "1", "yes", "TRUE"]) {
				const a = document.createElement("a");
				a.setAttribute(BLOCK_EMBED_DOM_FLAG, wrong);
				a.setAttribute("data-entity-id", "ent_x");
				expect(aHandler(a)).toBeNull();
			}
			// Sanity: the exact stamp value DOES convert.
			const a = document.createElement("a");
			a.setAttribute(BLOCK_EMBED_DOM_FLAG, BLOCK_EMBED_DOM_FLAG_VALUE);
			a.setAttribute("data-entity-id", "ent_x");
			expect(aHandler(a)).not.toBeNull();
		});

		it("importDOM rejects an <a> with an empty data-entity-id (empty-reference masquerade fence)", () => {
			withEditor(() => {
				const map = BlockEmbedNode.importDOM();
				if (!map) throw new Error("expected importDOM map");
				const aHandler = map.a;
				if (typeof aHandler !== "function") throw new Error("expected `a` handler");
				const a = document.createElement("a");
				a.setAttribute("href", "brainstorm://entity/");
				a.setAttribute(BLOCK_EMBED_DOM_FLAG, BLOCK_EMBED_DOM_FLAG_VALUE);
				a.setAttribute("data-entity-id", "");
				a.setAttribute("data-entity-type", "io.brainstorm.notes/Note/v1");
				a.setAttribute("data-label", "looks-legit");
				const conversion = aHandler(a);
				if (!conversion) throw new Error("expected matcher to fire");
				const out = conversion.conversion(a);
				if (!out) throw new Error("expected output");
				// An entityId-less reference is no reference at all — the
				// conversion must produce no node so the paste falls through
				// to Lexical's default link handling.
				expect(out.node).toBeNull();
			});
		});

		it("importDOM round-trips an anchor carrying the flag into a BlockEmbedNode", () => {
			withEditor(() => {
				const map = BlockEmbedNode.importDOM();
				if (!map) throw new Error("expected importDOM map");
				const aHandler = map.a;
				if (typeof aHandler !== "function") throw new Error("expected `a` handler");
				const a = document.createElement("a");
				a.setAttribute("href", "brainstorm://entity/ent_db1");
				a.setAttribute(BLOCK_EMBED_DOM_FLAG, "true");
				a.setAttribute("data-block-id", "io.example.kanban/board/v1");
				a.setAttribute("data-entity-id", "ent_db1");
				a.setAttribute("data-entity-type", "io.brainstorm.database/List/v1");
				a.setAttribute("data-label", "Tasks");
				const conversion = aHandler(a);
				expect(conversion).not.toBeNull();
				if (!conversion) return;
				expect(conversion.priority).toBe(1);
				const out = conversion.conversion(a);
				expect(out).not.toBeNull();
				if (!out) return;
				const produced = out.node;
				expect(produced).not.toBeNull();
				expect(Array.isArray(produced)).toBe(false);
				if (!produced || Array.isArray(produced)) return;
				expect($isBlockEmbedNode(produced)).toBe(true);
				if (!$isBlockEmbedNode(produced)) return;
				expect(produced.getBlockId()).toBe("io.example.kanban/board/v1");
				expect(produced.getEntityId()).toBe("ent_db1");
				expect(produced.getEntityType()).toBe("io.brainstorm.database/List/v1");
				expect(produced.getLabel()).toBe("Tasks");
			});
		});

		it("importDOM defaults missing data-block-id to SHELL_ENTITY_CARD_BLOCK_ID", () => {
			withEditor(() => {
				const map = BlockEmbedNode.importDOM();
				if (!map) throw new Error("expected importDOM map");
				const aHandler = map.a;
				if (typeof aHandler !== "function") throw new Error("expected `a` handler");
				const a = document.createElement("a");
				a.setAttribute("href", "brainstorm://entity/ent_x");
				a.setAttribute(BLOCK_EMBED_DOM_FLAG, "true");
				a.setAttribute("data-entity-id", "ent_x");
				a.setAttribute("data-entity-type", "io.brainstorm.notes/Note/v1");
				a.setAttribute("data-label", "Untitled");
				const conversion = aHandler(a);
				if (!conversion) throw new Error("expected conversion");
				const out = conversion.conversion(a);
				if (!out) throw new Error("expected output");
				const produced = out.node;
				if (!produced || Array.isArray(produced) || !$isBlockEmbedNode(produced)) {
					throw new Error("expected a single BlockEmbedNode");
				}
				expect(produced.getBlockId()).toBe(SHELL_ENTITY_CARD_BLOCK_ID);
			});
		});

		it("importDOM clamps each field at MAX_FIELD_LEN (1024)", () => {
			withEditor(() => {
				const map = BlockEmbedNode.importDOM();
				if (!map) throw new Error("expected importDOM map");
				const aHandler = map.a;
				if (typeof aHandler !== "function") throw new Error("expected `a` handler");
				const oversize = "x".repeat(5000);
				const a = document.createElement("a");
				a.setAttribute("href", "brainstorm://entity/x");
				a.setAttribute(BLOCK_EMBED_DOM_FLAG, "true");
				a.setAttribute("data-block-id", oversize);
				a.setAttribute("data-entity-id", oversize);
				a.setAttribute("data-entity-type", oversize);
				a.setAttribute("data-label", oversize);
				const conversion = aHandler(a);
				if (!conversion) throw new Error("expected conversion");
				const out = conversion.conversion(a);
				if (!out) throw new Error("expected output");
				const produced = out.node;
				if (!produced || Array.isArray(produced) || !$isBlockEmbedNode(produced)) {
					throw new Error("expected a single BlockEmbedNode");
				}
				expect(produced.getBlockId().length).toBe(1024);
				expect(produced.getEntityId().length).toBe(1024);
				expect(produced.getEntityType().length).toBe(1024);
				expect(produced.getLabel().length).toBe(1024);
			});
		});

		it("HTML round-trip preserves a foreign blockId (pre-B9.5 forward-compat)", () => {
			withEditor(() => {
				const node = $createBlockEmbedNode(
					"ent_db1",
					"io.brainstorm.database/List/v1",
					"Tasks",
					"io.example.kanban/board",
				);
				const { element } = node.exportDOM();
				if (!(element instanceof HTMLAnchorElement)) {
					throw new Error("expected <a>");
				}
				const map = BlockEmbedNode.importDOM();
				if (!map) throw new Error("expected importDOM map");
				const aHandler = map.a;
				if (typeof aHandler !== "function") throw new Error("expected `a` handler");
				const conversion = aHandler(element);
				if (!conversion) throw new Error("expected conversion");
				const out = conversion.conversion(element);
				if (!out) throw new Error("expected output");
				const produced = out.node;
				if (!produced || Array.isArray(produced) || !$isBlockEmbedNode(produced)) {
					throw new Error("expected a single BlockEmbedNode");
				}
				expect(produced.getBlockId()).toBe("io.example.kanban/board");
			});
		});

		it("exportDOM → importDOM round-trip preserves every byte (the headline)", () => {
			// Bind the four inputs to local consts and assert the OUTPUT
			// against those literals — comparing produced.getX() to
			// node.getX() only proves "import reads what export wrote"
			// transitively, not byte-identity to the source. Pin bytes.
			const blockIdIn = "io.example.kanban/board/v2";
			const entityIdIn = "ent_round_trip_1";
			const entityTypeIn = "io.brainstorm.whiteboard/Board/v1";
			const labelIn = "Roadmap board";
			withEditor(() => {
				const node = $createBlockEmbedNode(entityIdIn, entityTypeIn, labelIn, blockIdIn);
				const { element } = node.exportDOM();
				if (!(element instanceof HTMLAnchorElement)) {
					throw new Error("expected <a>");
				}
				const map = BlockEmbedNode.importDOM();
				if (!map) throw new Error("expected importDOM map");
				const aHandler = map.a;
				if (typeof aHandler !== "function") throw new Error("expected `a` handler");
				const conversion = aHandler(element);
				if (!conversion) throw new Error("expected conversion");
				const out = conversion.conversion(element);
				if (!out) throw new Error("expected output");
				const produced = out.node;
				if (!produced || Array.isArray(produced) || !$isBlockEmbedNode(produced)) {
					throw new Error("expected a single BlockEmbedNode");
				}
				expect(produced.getBlockId()).toBe(blockIdIn);
				expect(produced.getEntityId()).toBe(entityIdIn);
				expect(produced.getEntityType()).toBe(entityTypeIn);
				expect(produced.getLabel()).toBe(labelIn);
			});
		});
	});
});
