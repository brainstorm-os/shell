import { TITLE_NODE_TYPE } from "@brainstorm-os/editor";
import { describe, expect, it } from "vitest";
import { migrateTitleIntoBody } from "./migrate-title";

const ROOT_BASE = {
	type: "root" as const,
	version: 1 as const,
	format: "" as const,
	indent: 0 as const,
	direction: null,
};

describe("migrateTitleIntoBody", () => {
	it("passes strings through unchanged (handled by editor's makeInitialState)", () => {
		expect(migrateTitleIntoBody("hello", "My title")).toBe("hello");
		expect(migrateTitleIntoBody("", "My title")).toBe("");
	});

	it("prepends a TitleNode when the first child is a paragraph", () => {
		const body = {
			root: {
				...ROOT_BASE,
				children: [
					{
						type: "paragraph",
						version: 1,
						format: "",
						indent: 0,
						direction: null,
						children: [
							{
								type: "text",
								version: 1,
								detail: 0,
								format: 0,
								mode: "normal",
								style: "",
								text: "hello",
							},
						],
					},
				],
			},
		} as never;
		const migrated = migrateTitleIntoBody(body, "Stored title") as {
			root: { children: Array<{ type: string; children?: Array<{ text?: string }> }> };
		};
		expect(migrated.root.children).toHaveLength(2);
		expect(migrated.root.children[0]?.type).toBe(TITLE_NODE_TYPE);
		expect(migrated.root.children[0]?.children?.[0]?.text).toBe("Stored title");
		expect(migrated.root.children[1]?.type).toBe("paragraph");
	});

	it("emits a TitleNode with no children when the stored title is empty", () => {
		const body = {
			root: {
				...ROOT_BASE,
				children: [
					{
						type: "paragraph",
						version: 1,
						format: "",
						indent: 0,
						direction: null,
						children: [],
					},
				],
			},
		} as never;
		const migrated = migrateTitleIntoBody(body, "") as {
			root: { children: Array<{ type: string; children?: unknown[] }> };
		};
		expect(migrated.root.children[0]?.type).toBe(TITLE_NODE_TYPE);
		expect(migrated.root.children[0]?.children).toEqual([]);
	});

	it("is idempotent — bodies already starting with a TitleNode pass through", () => {
		const body = {
			root: {
				...ROOT_BASE,
				children: [
					{
						type: TITLE_NODE_TYPE,
						version: 1,
						format: "",
						indent: 0,
						direction: null,
						textFormat: 0,
						textStyle: "",
						children: [
							{
								type: "text",
								version: 1,
								detail: 0,
								format: 0,
								mode: "normal",
								style: "",
								text: "Already there",
							},
						],
					},
				],
			},
		} as never;
		expect(migrateTitleIntoBody(body, "Stored title")).toBe(body);
	});
});
