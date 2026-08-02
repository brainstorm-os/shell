/**
 * Tool-7 — projecting app tools onto the shared contributed-action shape.
 *
 * The point of the projection is that app tools flow through the SAME anti-rot
 * policy as intent contributions rather than growing a second one. These cases
 * pin the three places that could silently stop being true.
 */

import { describe, expect, it } from "vitest";
import {
	AppToolEffect,
	type AppToolRecord,
	AppToolSurface,
	appToolId,
	appToolToContributedAction,
	sanitizeAppLabel,
} from "./app-tools";
import {
	ActionGroup,
	ActionTrustTier,
	INLINE_ACTIONS_PER_GROUP,
	groupContributedActions,
} from "./contributed-actions";

function tool(appId: string, name: string, over: Partial<AppToolRecord> = {}): AppToolRecord {
	return {
		id: appToolId(appId, name),
		appId,
		name,
		title: over.title ?? name,
		description: "does a thing",
		effect: AppToolEffect.Pure,
		appliesTo: [],
		surfaces: [AppToolSurface.Menu],
		input: [],
		registeredAt: 1,
		...over,
	};
}

describe("appToolToContributedAction", () => {
	it("carries the tool id as the dedupe key, so two apps' tools both survive", () => {
		// This is the collision the whole track exists to remove: addressing a
		// tool by verb alone made two providers' tools one row.
		const actions = [
			appToolToContributedAction(tool("io.a", "summarize", { trustTier: ActionTrustTier.Trusted })),
			appToolToContributedAction(tool("io.b", "summarize", { trustTier: ActionTrustTier.Trusted })),
		];
		const groups = groupContributedActions(actions);
		const rows = groups.flatMap((g) => [...g.inline, ...g.overflow]);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.appId).sort()).toEqual(["io.a", "io.b"]);
	});

	it("does NOT change dedupe for intent-derived contributions", () => {
		// Same (verb, kind) from two apps must still collapse to one row.
		const intent = (appId: string) => ({
			id: `share::${appId}`,
			verb: "share" as never,
			label: "Share",
			group: ActionGroup.Share,
			priority: "secondary" as const,
			trustTier: ActionTrustTier.Trusted,
			appId,
			appLabel: appId,
		});
		const groups = groupContributedActions([intent("io.a"), intent("io.b")]);
		expect(groups.flatMap((g) => [...g.inline, ...g.overflow])).toHaveLength(1);
	});

	it("quarantines a tool with no resolved trust tier", () => {
		// An unstamped tier must read as sideloaded — unknown provenance is
		// never promoted into the inline rows.
		const action = appToolToContributedAction(tool("io.x", "rewrite"));
		expect(action.trustTier).toBe(ActionTrustTier.Sideloaded);
		const [group] = groupContributedActions([action]);
		expect(group?.inline).toEqual([]);
		expect(group?.overflow).toHaveLength(1);
	});

	it("shares the inline cap with intent contributions rather than adding its own", () => {
		const trusted = (i: number) =>
			appToolToContributedAction(
				tool("io.x", `t${i}`, { trustTier: ActionTrustTier.Trusted, title: `T${i}` }),
			);
		const groups = groupContributedActions([trusted(1), trusted(2), trusted(3), trusted(4)]);
		const actions = groups.find((g) => g.group === ActionGroup.Actions);
		expect(actions?.inline).toHaveLength(INLINE_ACTIONS_PER_GROUP);
		expect(actions?.overflow).toHaveLength(4 - INLINE_ACTIONS_PER_GROUP);
	});

	it("falls back to the app id when no display name was resolved", () => {
		expect(appToolToContributedAction(tool("io.x", "rewrite")).appLabel).toBe("io.x");
		expect(
			appToolToContributedAction(tool("io.x", "rewrite", { appLabel: "Rewriter" })).appLabel,
		).toBe("Rewriter");
	});
});

describe("sanitizeAppLabel", () => {
	it("refuses a provider name that renders as nothing", () => {
		// `manifest.name` is validated only as "a non-empty string" — unlike a
		// tool title, it never passed the invisible-text screen. It does now,
		// because Tool-7 renders it as attribution.
		for (const bad of ["", "   ", "\u3164", "\u2800", "Rewriter\u200b", "x".repeat(200)]) {
			expect(sanitizeAppLabel(bad), JSON.stringify(bad)).toBeNull();
		}
	});

	it("keeps a legitimate name, including international text", () => {
		expect(sanitizeAppLabel("Rewriter")).toBe("Rewriter");
		expect(sanitizeAppLabel("  日本語アプリ  ")).toBe("日本語アプリ");
	});
});
