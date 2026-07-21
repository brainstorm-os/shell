import { type Template, TemplateKind } from "@brainstorm-os/sdk-types";
import { TEMPLATE_SNIPPET_KEY } from "@brainstorm-os/sdk/templates";
import { describe, expect, it } from "vitest";
import { SNIPPET_NAME_MAX, deriveSnippetName, templatesToSnippetOptions } from "./template-snippet";

function snippetTemplate(
	id: string,
	name: string,
	snippet: unknown,
	icon: Template["icon"] = null,
): Template {
	return {
		id,
		templateKind: TemplateKind.BlockSnippet,
		targetType: null,
		name,
		icon,
		cover: null,
		prototype: snippet === undefined ? {} : { [TEMPLATE_SNIPPET_KEY]: snippet },
		createdAt: 1,
		updatedAt: 1,
	};
}

function objectTemplate(id: string, name: string): Template {
	return {
		id,
		templateKind: TemplateKind.Object,
		targetType: "brainstorm/Task/v1",
		name,
		icon: null,
		cover: null,
		prototype: { priority: "high" },
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("templatesToSnippetOptions", () => {
	it("keeps block-snippet templates with an insertable fragment, preserving order", () => {
		const a = snippetTemplate("t_a", "Meeting notes", '{"version":1,"blocks":[{}]}');
		const b = snippetTemplate("t_b", "Standup", '{"version":1,"blocks":[{}]}');
		const options = templatesToSnippetOptions([a, b]);
		expect(options.map((o) => o.id)).toEqual(["t_a", "t_b"]);
		expect(options[0]).toEqual({
			id: "t_a",
			name: "Meeting notes",
			snippet: '{"version":1,"blocks":[{}]}',
			icon: null,
		});
	});

	it("drops object templates", () => {
		const options = templatesToSnippetOptions([
			objectTemplate("t_obj", "Task"),
			snippetTemplate("t_snip", "Snippet", '{"version":1,"blocks":[{}]}'),
		]);
		expect(options.map((o) => o.id)).toEqual(["t_snip"]);
	});

	it("drops snippet rows whose fragment is missing or empty", () => {
		const options = templatesToSnippetOptions([
			snippetTemplate("t_empty", "Empty", ""),
			snippetTemplate("t_missing", "Missing", undefined),
			snippetTemplate("t_nonstring", "Bad", 42),
			snippetTemplate("t_ok", "Ok", '{"version":1,"blocks":[{}]}'),
		]);
		expect(options.map((o) => o.id)).toEqual(["t_ok"]);
	});

	it("carries an authored icon through untouched", () => {
		const icon = { kind: "emoji", value: "📋" } as unknown as Template["icon"];
		const options = templatesToSnippetOptions([
			snippetTemplate("t_icon", "Iconed", '{"version":1,"blocks":[{}]}', icon),
		]);
		expect(options[0]?.icon).toBe(icon);
	});

	it("returns an empty list for no templates", () => {
		expect(templatesToSnippetOptions([])).toEqual([]);
	});
});

describe("deriveSnippetName", () => {
	it("uses the trimmed first-block text", () => {
		expect(deriveSnippetName("  Weekly review  ", "Snippet")).toBe("Weekly review");
	});

	it("collapses internal whitespace", () => {
		expect(deriveSnippetName("Weekly\n\treview   agenda", "Snippet")).toBe("Weekly review agenda");
	});

	it("falls back to the supplied default when blank", () => {
		expect(deriveSnippetName("", "Snippet")).toBe("Snippet");
		expect(deriveSnippetName("   \n\t ", "Snippet")).toBe("Snippet");
	});

	it("truncates to the max length", () => {
		const long = "x".repeat(120);
		const name = deriveSnippetName(long, "Snippet");
		expect(name.length).toBe(SNIPPET_NAME_MAX);
		expect(name).toBe("x".repeat(SNIPPET_NAME_MAX));
	});

	it("trims trailing whitespace left by truncation", () => {
		const text = `${"a".repeat(59)}   trailing`;
		const name = deriveSnippetName(text, "Snippet");
		expect(name).toBe("a".repeat(59));
	});
});
