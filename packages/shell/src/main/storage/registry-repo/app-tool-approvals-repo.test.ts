/**
 * Tool-5 — the approvals table's lifecycle rules, which are the whole point of
 * it being a separate table rather than a column on `app_tools`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AppToolApprovalState,
	AppToolEffect,
	type AppToolRecord,
	AppToolSurface,
	appToolApprovalState,
	appToolFingerprint,
	appToolId,
} from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DataStores } from "../data-stores";
import { AppToolApprovalsRepository } from "./app-tool-approvals-repo";

const APP = "io.example.p";
const CALLER = "io.brainstorm.notes";
const TOOL = appToolId(APP, "rewrite");

function tool(over: Partial<AppToolRecord> = {}): AppToolRecord {
	return {
		id: TOOL,
		appId: APP,
		name: "rewrite",
		title: "Rewrite",
		description: "Rewrite the text.",
		effect: AppToolEffect.Pure,
		appliesTo: [],
		surfaces: [AppToolSurface.Menu],
		input: [],
		registeredAt: 1,
		...over,
	};
}

describe("app tool approvals", () => {
	let dir: string;
	let stores: DataStores;
	let repo: AppToolApprovalsRepository;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "brainstorm-approvals-"));
		stores = new DataStores(dir);
		repo = new AppToolApprovalsRepository(await stores.open("registry"));
	});
	afterEach(async () => {
		stores.close();
		await rm(dir, { recursive: true, force: true });
	});

	it("reads back nothing for a tool that was never approved", () => {
		expect(repo.get(CALLER, TOOL)).toBeNull();
		expect(appToolApprovalState(tool(), repo.get(CALLER, TOOL))).toBe(AppToolApprovalState.New);
	});

	it("round-trips an approval and recognises the same surface", () => {
		repo.approve(CALLER, TOOL, APP, appToolFingerprint(tool()), 1);
		expect(appToolApprovalState(tool(), repo.get(CALLER, TOOL))).toBe(AppToolApprovalState.Approved);
	});

	it("survives a REINSTALL of the same declaration, and only that", () => {
		// The table records a decision a person made, not a fact derived from the
		// manifest — so it is not replaced wholesale like `app_tools`.
		repo.approve(CALLER, TOOL, APP, appToolFingerprint(tool()), 1);
		// A reinstall bumps registeredAt but changes nothing the user read.
		expect(appToolApprovalState(tool({ registeredAt: 999 }), repo.get(CALLER, TOOL))).toBe(
			AppToolApprovalState.Approved,
		);
		// A reinstall that rewrote the tool does not keep the approval.
		expect(appToolApprovalState(tool({ description: "different" }), repo.get(CALLER, TOOL))).toBe(
			AppToolApprovalState.Changed,
		);
	});

	it("re-baselines in place rather than accumulating rows", () => {
		repo.approve(CALLER, TOOL, APP, "one", 1);
		repo.approve(CALLER, TOOL, APP, "two", 2);
		expect(repo.get(CALLER, TOOL)).toBe("two");
		expect(repo.listForApp(APP)).toHaveLength(1);
	});

	it("drops every approval for an app on uninstall", () => {
		// An approval left behind would silently pre-approve a future app that
		// reclaimed the same id.
		repo.approve(CALLER, TOOL, APP, "fp", 1);
		repo.approve(CALLER, appToolId(APP, "summarize"), APP, "fp2", 1);
		repo.approve(CALLER, appToolId("io.other", "x"), "io.other", "fp3", 1);
		expect(repo.deleteForApp(APP)).toBe(2);
		expect(repo.get(CALLER, TOOL)).toBeNull();
		expect(repo.listForApp("io.other")).toHaveLength(1);
	});

	it("does not let one caller's assertion approve the tool for another", () => {
		// `confirmed` is a claim about a human the caller cannot prove, so a
		// global row would turn a forged flag from a one-call problem into a
		// standing one for every other caller.
		repo.approve(CALLER, TOOL, APP, appToolFingerprint(tool()), 1);
		expect(repo.get("io.other.caller", TOOL)).toBeNull();
		expect(appToolApprovalState(tool(), repo.get("io.other.caller", TOOL))).toBe(
			AppToolApprovalState.New,
		);
	});

	it("drops approvals an app made as a CALLER on uninstall too", () => {
		repo.approve(CALLER, TOOL, APP, "fp", 1);
		expect(repo.deleteForApp(CALLER)).toBe(1);
		expect(repo.get(CALLER, TOOL)).toBeNull();
	});
});
