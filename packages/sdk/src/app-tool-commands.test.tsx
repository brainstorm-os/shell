/**
 * Tool-7b — app tools as editor block commands.
 *
 * The editor surfaces could not carry app tools because `BlockCommand.run` was
 * sync and void-returning, so a named refusal had nowhere to go. These cases
 * pin the two things that makes possible — and the rule it must not lose.
 */

import {
	AppToolEffect,
	type AppToolRecord,
	AppToolSurface,
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

const build = (tools: readonly AppToolRecord[], call = vi.fn(async () => ({ value: "ok" }))) => {
	const reported: unknown[] = [];
	const commands = appToolCommands({
		tools,
		category: "action",
		icon: null,
		call,
		report: (o) => reported.push(o),
	});
	return { commands, reported, call };
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

	it("excludes a tool needing arguments a menu activation cannot supply", () => {
		const { commands } = build([
			tool("rewrite", {
				input: [{ name: "text", description: "d", required: true, valueType: "text" as never }],
			}),
		]);
		expect(commands).toEqual([]);
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
