import { ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { pairableInverseCandidates } from "./inverse-candidates";

const rel = (key: string, inverseOf?: string) => ({
	key,
	valueType: ValueType.EntityRef as string,
	...(inverseOf ? { inverseOf } : {}),
});

describe("pairableInverseCandidates", () => {
	it("excludes BOTH sides of an existing pair, including the unmarked one", () => {
		const keys = pairableInverseCandidates([rel("x", "y"), rel("y"), rel("free")]).map((d) => d.key);
		expect(keys).toEqual(["free"]);
	});

	it("excludes self-pairs and non-relations", () => {
		const keys = pairableInverseCandidates([
			rel("self", "self"),
			{ key: "n", valueType: ValueType.Number },
			rel("open"),
		]).map((d) => d.key);
		expect(keys).toEqual(["open"]);
	});
});
