import { describe, expect, it } from "vitest";
import { CaptureKind, captureSlug, captureTags, routeCapture } from "./quick-capture";

const READING = { id: "list-reading", name: "Reading list" };
const IDEAS = { id: "list-ideas", name: "Idées" };

describe("captureSlug", () => {
	it("folds case, accents and separators", () => {
		expect(captureSlug("Reading list")).toBe("reading-list");
		expect(captureSlug("reading_list")).toBe("reading-list");
		expect(captureSlug("  Idées!! ")).toBe("idees");
	});
});

describe("captureTags", () => {
	it("finds every #tag in order and ignores mid-word hashes", () => {
		expect(captureTags("call mom #family then #errands")).toEqual(["family", "errands"]);
		expect(captureTags("issue#42 is not a tag")).toEqual([]);
		expect(captureTags("#leading tag")).toEqual(["leading"]);
	});
});

describe("routeCapture", () => {
	it("ignores a blank line", () => {
		expect(routeCapture("   ", [READING])).toEqual({ kind: CaptureKind.Empty });
	});

	it("keeps an untagged line as a plain line, whitespace-normalised", () => {
		expect(routeCapture("  buy   oat milk ", [READING])).toEqual({
			kind: CaptureKind.Line,
			text: "buy oat milk",
		});
	});

	it("files a line whose tag names a collection, titled without the tag", () => {
		expect(routeCapture("Piranesi by Susanna Clarke #reading-list", [READING, IDEAS])).toEqual({
			kind: CaptureKind.File,
			text: "Piranesi by Susanna Clarke #reading-list",
			title: "Piranesi by Susanna Clarke",
			tag: "reading-list",
			collection: READING,
		});
	});

	it("matches case- and accent-insensitively, tag anywhere in the line", () => {
		const route = routeCapture("#IDEES a journal that files itself", [READING, IDEAS]);
		expect(route).toMatchObject({
			kind: CaptureKind.File,
			title: "a journal that files itself",
			collection: IDEAS,
		});
	});

	it("leaves an unknown tag as part of a plain line", () => {
		expect(routeCapture("lunch with Sam #people", [READING])).toEqual({
			kind: CaptureKind.Line,
			text: "lunch with Sam #people",
		});
	});

	it("routes on the first tag that names a real collection, keeping the others as text", () => {
		const route = routeCapture("Dune #scifi #reading-list", [READING]);
		expect(route).toMatchObject({ kind: CaptureKind.File, title: "Dune #scifi" });
	});

	it("does not file a line that is only a tag", () => {
		expect(routeCapture("#reading-list", [READING])).toEqual({
			kind: CaptureKind.Line,
			text: "#reading-list",
		});
	});
});
