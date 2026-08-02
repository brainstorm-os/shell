/**
 * Tool-7b — app tools as editor block commands.
 *
 * The editor surfaces could not carry app tools because `BlockCommand.run` was
 * sync and void-returning, so a named refusal had nowhere to go. These cases
 * pin the two things that makes possible — and the rule it must not lose.
 */

import {
	ActionTrustTier,
	AppToolEffect,
	type AppToolInput,
	type AppToolRecord,
	AppToolSurface,
	ValueType,
	appToolId,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { appToolCommands } from "./app-tool-commands";

function tool(name: string, over: Partial<AppToolRecord> = {}): AppToolRecord {
	return {
		id: appToolId("io.example.p", name),
		appId: "io.example.p",
		name,
		title: over.title ?? name,
		description: "does a thing",
		effect: AppToolEffect.Pure,
		appliesTo: [],
		surfaces: [AppToolSurface.Menu],
		input: [],
		registeredAt: 1,
		appLabel: "Provider",
		...over,
	};
}

const build = (
	tools: readonly AppToolRecord[],
	call = vi.fn(async (_input: { tool: string; args?: Readonly<Record<string, unknown>> }) => ({
		value: "ok",
	})),
	promptForArgs?: (tool: AppToolRecord) => Promise<Readonly<Record<string, unknown>> | null>,
) => {
	const reported: unknown[] = [];
	const commands = appToolCommands({
		tools,
		category: "action",
		icon: null,
		call,
		report: (o) => reported.push(o),
		...(promptForArgs ? { promptForArgs } : {}),
	});
	return { commands, reported, call };
};

const requiredText: AppToolInput = {
	name: "text",
	description: "d",
	required: true,
	valueType: ValueType.Text,
};

describe("appToolCommands", () => {
	it("attributes the provider, so two same-titled tools are distinguishable", () => {
		const { commands } = build([tool("slugify", { title: "Slugify" })]);
		expect(commands[0]?.label).toBe("Slugify — Provider");
	});

	it("reports a refusal instead of swallowing it", async () => {
		// The whole reason the editor surfaces could not carry tools: a named
		// refusal had nowhere to go through a void return.
		const call = vi.fn(async () => {
			throw Object.assign(new Error("nope"), { name: "Denied" });
		});
		const { commands, reported } = build([tool("slugify")], call as never);
		await commands[0]?.run();
		expect(reported[0]).toMatchObject({ ok: false, kind: "Denied" });
	});

	it("reports success too", async () => {
		const { commands, reported } = build([tool("slugify")]);
		await commands[0]?.run();
		expect(reported[0]).toMatchObject({ ok: true, value: "ok" });
	});

	it("excludes a required-argument tool when the host has no prompt", () => {
		const { commands } = build([tool("rewrite", { input: [requiredText] })]);
		expect(commands).toEqual([]);
	});

	it("offers a required-argument tool when the host supplies promptForArgs", async () => {
		const { commands, reported, call } = build(
			[tool("rewrite", { input: [requiredText] })],
			undefined,
			async () => ({
				text: "collected",
			}),
		);
		expect(commands).toHaveLength(1);
		await commands[0]?.run();
		expect(call.mock.calls[0]?.[0]).toEqual({
			tool: expect.any(String),
			args: { text: "collected" },
		});
		expect(reported[0]).toMatchObject({ ok: true });
	});

	it("a cancelled prompt makes NO call and reports NOTHING", async () => {
		const { commands, reported, call } = build(
			[tool("rewrite", { input: [requiredText] })],
			undefined,
			async () => null,
		);
		await commands[0]?.run();
		expect(call).not.toHaveBeenCalled();
		expect(reported).toEqual([]);
	});

	it("still hides a required input the prompt cannot collect (free-form multi)", () => {
		const multi: AppToolInput = { ...requiredText, name: "items", count: { min: 1, max: 5 } };
		const { commands } = build([tool("bulk", { input: [multi] })], undefined, async () => ({}));
		expect(commands).toEqual([]);
	});

	it("screens the attribution and carries the lister-stamped trust tier", () => {
		// A malicious manifest name full of zero-width characters must not
		// become row attribution; the registry-minted app id stands in.
		const { commands } = build([tool("slugify", { title: "Slugify", appLabel: "​​" })]);
		expect(commands[0]?.label).toBe("Slugify — io.example.p");
		// Absent tier reads as Sideloaded, never promoted.
		expect(commands[0]?.trustTier).toBe(ActionTrustTier.Sideloaded);
	});

	it("sorts sideloaded tools after trusted ones", () => {
		const { commands } = build([
			tool("zeta", { title: "Zeta" }), // no tier ⇒ sideloaded
			tool("alpha", { title: "Alpha", trustTier: ActionTrustTier.Trusted }),
		]);
		expect(commands.map((c) => c.label.split(" — ")[0])).toEqual(["Alpha", "Zeta"]);
	});

	it("excludes non-menu surfaces and poisoned declarations", () => {
		expect(build([tool("agentOnly", { surfaces: [AppToolSurface.Agent] })]).commands).toEqual([]);
		expect(build([tool("bad", { declarationInvalid: true })]).commands).toEqual([]);
	});

	it("is searchable by tool and provider words in the slash menu", () => {
		const { commands } = build([tool("slugify", { title: "Slugify" })]);
		expect(commands[0]?.keywords).toContain("slugify");
		expect(commands[0]?.keywords).toContain("provider");
	});
});
