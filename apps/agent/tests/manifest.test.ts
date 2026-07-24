import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLLECTION_TYPE_URL, GENERIC_OBJECT_TYPE } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../../packages/shell/src/main/apps/manifest";
import { curatedToolCapabilities } from "../src/logic/agent-tools";

const MANIFEST_PATH = join(__dirname, "..", "manifest.json");

function readManifest(): unknown {
	return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

describe("apps/agent/manifest.json", () => {
	it("passes the shell's manifest validator", () => {
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(`manifest invalid at ${result.path}: ${result.reason}`);
		expect(result.ok).toBe(true);
	});

	it("declares the expected app id + sdk pin", () => {
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		expect(result.manifest.id).toBe("io.brainstorm.agent");
		expect(result.manifest.sdk).toBe("1");
	});

	it("holds ai.use so the broker permits ai.generate", () => {
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		expect(result.manifest.capabilities).toContain("ai.use");
	});

	it("registers Conversation + Message with inline schemas (offline-install)", () => {
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		const types = result.manifest.registrations?.entityTypes ?? [];
		for (const id of ["brainstorm/Conversation/v1", "brainstorm/Message/v1"]) {
			const t = types.find((x) => x.id === id);
			expect(t, `${id} registered`).toBeDefined();
			expect(t?.schema).toBeDefined();
		}
	});

	it("registers Conversation/v1 as primary opener so intent.open routes here", () => {
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		const openers = result.manifest.registrations?.openers ?? [];
		expect(
			openers.find((op) => op.entityType === "brainstorm/Conversation/v1" && op.kind === "primary"),
		).toBeDefined();
	});

	it("declares every capability the curated agent tools require (Agent-3)", () => {
		// The three-tier ceiling can only NARROW the manifest caps, so the manifest
		// must hold the full footprint of the curated tools or none would ever be
		// offered. Fail-closed: a curated tool whose cap is undeclared is dead.
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		for (const cap of curatedToolCapabilities()) {
			expect(result.manifest.capabilities, `manifest declares ${cap}`).toContain(cap);
		}
	});

	it("declares the write caps an approved database-row proposal exercises (Agent-11d)", () => {
		// A row lands as its database's own type (the generic Object for a manual
		// collection), and a manual collection also needs its membership patched.
		// Undeclared caps would mean the model is offered a row tool whose approval
		// is denied — so the offer filter and the manifest have to agree.
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		for (const cap of [
			"intents.dispatch:propose-row",
			`entities.write:${GENERIC_OBJECT_TYPE}`,
			`entities.write:${COLLECTION_TYPE_URL}`,
		]) {
			expect(result.manifest.capabilities, `manifest declares ${cap}`).toContain(cap);
		}
	});

	it("holds search.read + search.hybrid so the broker assembles retrieval (Agent-4)", () => {
		// Grounding rides the capability-gated search service ONLY — the app has
		// no direct entity-read path for retrieval. `search.hybrid` is the gated
		// fusion verb; `search.read` is the lexical fallback.
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		expect(result.manifest.capabilities).toContain("search.read");
		expect(result.manifest.capabilities).toContain("search.hybrid");
	});

	it("declares the cloud provider caps the per-conversation model picker offers (Agent-5)", () => {
		// The picker offers exactly the providers the app holds `ai.provider:<id>`
		// caps for; declaring them lets a conversation pin a cloud model (still
		// re-checked server-side). It can never offer a provider the manifest lacks.
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		for (const id of ["ollama", "anthropic", "openai", "glm", "gemini"]) {
			expect(result.manifest.capabilities, `manifest declares ai.provider:${id}`).toContain(
				`ai.provider:${id}`,
			);
		}
	});

	it("holds entities.read:* — useVaultEntities reads the whole-vault live snapshot", () => {
		// The Agent UI lists conversations + messages through the shared
		// reactivity stack (`useVaultEntities`), whose `vault-entities.list`
		// requires `entities.read:*`. (AI *retrieval* scoping is a separate
		// broker concern; it does not constrain the app's own UI reads.)
		const result = validateManifest(readManifest());
		if (!result.ok) throw new Error(result.reason);
		expect(result.manifest.capabilities).toContain("entities.read:*");
	});
});
