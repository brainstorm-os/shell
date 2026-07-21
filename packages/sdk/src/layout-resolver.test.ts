import {
	LayoutCellKind,
	LayoutContext,
	type LayoutDef,
	LayoutMode,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	type LayoutCandidate,
	LayoutResolveSource,
	type LayoutResolveTarget,
	SCOPE_PRECEDENCE,
	resolveLayout,
	scopeMatches,
} from "./layout-resolver";

function def(
	scope: LayoutDef["scope"],
	context: LayoutContext | null = LayoutContext.Full,
	tag = "title",
): LayoutDef {
	return {
		mode: LayoutMode.Stacked,
		scope,
		context,
		cells: [{ id: tag, kind: LayoutCellKind.Property, property: "title" }],
	};
}

const target: LayoutResolveTarget = {
	entityId: "ent_1",
	types: ["io.x/Doc/v1", "brainstorm/Note/v1"],
	collectionIds: ["col_a"],
	userId: "user_1",
	orgId: "org_1",
	context: LayoutContext.Full,
};

describe("SCOPE_PRECEDENCE", () => {
	it("is the frozen doc-27 chain, most→least specific", () => {
		expect([...SCOPE_PRECEDENCE]).toEqual(["entity", "list", "type", "user", "org"]);
		expect(Object.isFrozen(SCOPE_PRECEDENCE)).toBe(true);
	});
});

describe("scopeMatches", () => {
	it("matches each kind against its target dimension", () => {
		expect(scopeMatches({ kind: "entity", target: "ent_1" }, target)).toBe(true);
		expect(scopeMatches({ kind: "entity", target: "ent_X" }, target)).toBe(false);
		expect(scopeMatches({ kind: "type", target: "brainstorm/Note/v1" }, target)).toBe(true); // any of types
		expect(scopeMatches({ kind: "type", target: "io.x/Other/v1" }, target)).toBe(false);
		expect(scopeMatches({ kind: "list", target: "col_a" }, target)).toBe(true);
		expect(scopeMatches({ kind: "user", target: "user_1" }, target)).toBe(true);
		expect(scopeMatches({ kind: "org", target: "org_1" }, target)).toBe(true);
	});

	it("never matches a scope whose discriminant dimension is absent on the target", () => {
		const bare: LayoutResolveTarget = { entityId: "e", types: [], context: LayoutContext.Card };
		expect(scopeMatches({ kind: "user", target: "user_1" }, bare)).toBe(false);
		expect(scopeMatches({ kind: "org", target: "org_1" }, bare)).toBe(false);
		expect(scopeMatches({ kind: "list", target: "col_a" }, bare)).toBe(false);
	});
});

describe("resolveLayout — scope precedence", () => {
	it("picks the most specific scope regardless of candidate order", () => {
		const candidates: LayoutCandidate[] = [
			{ layout: def({ kind: "org", target: "org_1" }, LayoutContext.Full, "org") },
			{ layout: def({ kind: "type", target: "io.x/Doc/v1" }, LayoutContext.Full, "type") },
			{ layout: def({ kind: "entity", target: "ent_1" }, LayoutContext.Full, "entity") },
			{ layout: def({ kind: "user", target: "user_1" }, LayoutContext.Full, "user") },
			{ layout: def({ kind: "list", target: "col_a" }, LayoutContext.Full, "list") },
		];
		const r = resolveLayout(target, candidates);
		expect(r.source).toBe(LayoutResolveSource.Scope);
		if (r.source === LayoutResolveSource.Scope) expect(r.scope.kind).toBe("entity");
	});

	it("falls down the chain when the more-specific scopes don't match", () => {
		const candidates: LayoutCandidate[] = [
			{ layout: def({ kind: "entity", target: "someone-else" }) },
			{ layout: def({ kind: "type", target: "io.x/Doc/v1" }, LayoutContext.Full, "type") },
			{ layout: def({ kind: "org", target: "org_1" }, LayoutContext.Full, "org") },
		];
		const r = resolveLayout(target, candidates);
		expect(r.source === LayoutResolveSource.Scope && r.scope.kind).toBe("type");
	});
});

describe("resolveLayout — context", () => {
	it("excludes a layout whose context is a different specific context", () => {
		const r = resolveLayout(target, [
			{ layout: def({ kind: "entity", target: "ent_1" }, LayoutContext.Card) },
		]);
		expect(r.source).toBe(LayoutResolveSource.None);
	});

	it("an any-context (null) layout matches the request", () => {
		const r = resolveLayout(target, [{ layout: def({ kind: "entity", target: "ent_1" }, null) }]);
		expect(r.source).toBe(LayoutResolveSource.Scope);
	});

	it("a context-specific layout out-ranks an any-context one at the same scope", () => {
		const candidates: LayoutCandidate[] = [
			{ layout: def({ kind: "type", target: "io.x/Doc/v1" }, null, "any"), updatedAt: 9999 },
			{
				layout: def({ kind: "type", target: "io.x/Doc/v1" }, LayoutContext.Full, "specific"),
				updatedAt: 1,
			},
		];
		const r = resolveLayout(target, candidates);
		expect(r.source === LayoutResolveSource.Scope && r.layout.cells[0]?.id).toBe("specific");
	});
});

describe("resolveLayout — tiebreak", () => {
	it("most-recent-modified wins at equal scope + context-specificity", () => {
		const candidates: LayoutCandidate[] = [
			{ layout: def({ kind: "user", target: "user_1" }, LayoutContext.Full, "old"), updatedAt: 100 },
			{ layout: def({ kind: "user", target: "user_1" }, LayoutContext.Full, "new"), updatedAt: 200 },
		];
		const r = resolveLayout(target, candidates);
		expect(r.source === LayoutResolveSource.Scope && r.layout.cells[0]?.id).toBe("new");
		expect(r.source === LayoutResolveSource.Scope && r.updatedAt).toBe(200);
	});

	it("equal everything → earliest-listed stays (stable)", () => {
		const candidates: LayoutCandidate[] = [
			{ layout: def({ kind: "user", target: "user_1" }, LayoutContext.Full, "first") },
			{ layout: def({ kind: "user", target: "user_1" }, LayoutContext.Full, "second") },
		];
		const r = resolveLayout(target, candidates);
		expect(r.source === LayoutResolveSource.Scope && r.layout.cells[0]?.id).toBe("first");
	});
});

describe("resolveLayout — fallback chain", () => {
	const noMatch: LayoutCandidate[] = [{ layout: def({ kind: "entity", target: "nobody" }) }];

	it("app-default when no scoped candidate matched", () => {
		const appDefault = def({ kind: "type", target: "io.x/Doc/v1" });
		const r = resolveLayout(target, noMatch, { appDefault });
		expect(r).toEqual({ source: LayoutResolveSource.AppDefault, layout: appDefault });
	});

	it("shell-fallback when there's no app-default either", () => {
		const shellFallback = def({ kind: "type", target: "io.x/Doc/v1" });
		const r = resolveLayout(target, noMatch, { shellFallback });
		expect(r).toEqual({ source: LayoutResolveSource.ShellFallback, layout: shellFallback });
	});

	it("None when nothing matches and no fallbacks supplied", () => {
		expect(resolveLayout(target, noMatch)).toEqual({ source: LayoutResolveSource.None });
		expect(resolveLayout(target, [])).toEqual({ source: LayoutResolveSource.None });
	});

	it("a scoped match always beats the fallbacks", () => {
		const r = resolveLayout(target, [{ layout: def({ kind: "org", target: "org_1" }) }], {
			appDefault: def({ kind: "type", target: "io.x/Doc/v1" }),
		});
		expect(r.source).toBe(LayoutResolveSource.Scope);
	});
});
