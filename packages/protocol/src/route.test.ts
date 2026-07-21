import { describe, expect, it } from "vitest";
import { canonicalizeRoute, entityRoute, routesEquivalent } from "./route";

describe("entityRoute", () => {
	it("builds a canonical brainstorm://entity URI", () => {
		expect(entityRoute("ent_42")).toBe("brainstorm://entity/ent_42");
	});

	it("encodes id segments", () => {
		expect(entityRoute("a/b c")).toBe("brainstorm://entity/a%2Fb%20c");
	});
});

describe("canonicalizeRoute", () => {
	it("splits the fragment off the base", () => {
		expect(canonicalizeRoute("brainstorm://entity/ent_x#anchor-1")).toEqual({
			base: "brainstorm://entity/ent_x",
			fragment: "anchor-1",
		});
	});

	it("strips ephemeral query params and sorts the rest", () => {
		expect(canonicalizeRoute("brainstorm://entity/ent_x?from=notes&z=1&a=2").base).toBe(
			"brainstorm://entity/ent_x?a=2&z=1",
		);
	});

	it("drops a trailing slash", () => {
		expect(canonicalizeRoute("brainstorm://entity/ent_x/").base).toBe("brainstorm://entity/ent_x");
	});

	it("fails soft on a non-URL string", () => {
		expect(canonicalizeRoute("not a url/")).toEqual({ base: "not a url", fragment: null });
	});
});

describe("routesEquivalent", () => {
	it("matches on the entity portion regardless of fragment", () => {
		expect(routesEquivalent("brainstorm://entity/ent_x#a", "brainstorm://entity/ent_x#b")).toBe(true);
	});

	it("matches regardless of an ephemeral `from` param", () => {
		expect(routesEquivalent("brainstorm://entity/ent_x", "brainstorm://entity/ent_x?from=db")).toBe(
			true,
		);
	});

	it("does not match different entities", () => {
		expect(routesEquivalent("brainstorm://entity/ent_x", "brainstorm://entity/ent_y")).toBe(false);
	});
});
