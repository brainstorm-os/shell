import { describe, expect, it } from "vitest";
import { EMBED_PACKS, createEmbedT } from "./strings";

describe("embedded-list block strings", () => {
	it("falls back to English for an unshipped language", () => {
		expect(createEmbedT("ja")("embed.empty")).toBe("No items yet");
	});

	it("resolves a region tag through its base language", () => {
		expect(createEmbedT("de-AT")("embed.newIn", { name: "Bücher" })).toBe("Neues Element in Bücher");
	});

	it("ships every key in every pack", () => {
		const english = Object.keys(EMBED_PACKS.de ?? {}).sort();
		expect(english).toHaveLength(6);
		for (const pack of Object.values(EMBED_PACKS)) expect(Object.keys(pack).sort()).toEqual(english);
	});
});
