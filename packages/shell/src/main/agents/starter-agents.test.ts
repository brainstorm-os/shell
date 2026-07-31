/**
 * Starter agents (Agent-Teams-4) — the seed instantiates the AgentTemplate
 * format through the real directory path: three neutral-role members with
 * their own keys, conservative traits, and — the OQ-AT-3 position — ZERO
 * grants (a starter is powerless until the human scopes it). Every requested
 * capability must be one the Team surface could actually grant.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAgentGrantableCapability } from "@brainstorm-os/capabilities/agent-grants";
import { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { AgentAutonomy, AgentRouting } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasAgentKey } from "../credentials/agent-keys";
import { generateSymmetricKey } from "../credentials/crypto";
import { CredentialStore } from "../credentials/store";
import { DataStores } from "../storage/data-stores";
import { type AgentDirectorySession, createAgent, listAgents } from "./agent-directory";
import { STARTER_AGENT_TEMPLATES, seedStarterAgents } from "./starter-agents";

describe("starter-agents (Agent-Teams-4)", () => {
	let vaultDir: string;
	let stores: DataStores;
	let session: AgentDirectorySession;
	let ledger: CapabilityLedger;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-starters-"));
		stores = new DataStores(vaultDir);
		ledger = new CapabilityLedger(await stores.open("ledger"));
		session = {
			vaultId: "vault_test",
			vaultPath: vaultDir,
			credentials: new CredentialStore(vaultDir, generateSymmetricKey()),
			dataStores: { open: (name) => stores.open(name) },
			capabilityLedger: async () => ledger,
		};
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("ships three neutral-role templates whose requests are all grantable", () => {
		expect(STARTER_AGENT_TEMPLATES.map((t) => t.displayName)).toEqual([
			"Researcher",
			"Builder",
			"Reviewer",
		]);
		for (const template of STARTER_AGENT_TEMPLATES) {
			expect(template.traits.routing).toBe(AgentRouting.LocalOnly);
			expect(template.traits.autonomy).toBe(AgentAutonomy.ConfirmOnWrite);
			for (const cap of template.requestedCapabilities) {
				expect(isAgentGrantableCapability(cap), cap).toBe(true);
			}
		}
	});

	it("seeds three members with their own keys and ZERO grants", async () => {
		const seeded = await seedStarterAgents(session);
		expect(seeded).toHaveLength(3);
		const fingerprints = new Set(seeded.map((a) => a.def.fingerprint));
		expect(fingerprints.size).toBe(3);
		for (const record of seeded) {
			await expect(hasAgentKey(session.credentials, record.def.fingerprint)).resolves.toBe(true);
			expect(ledger.listActive(record.def.fingerprint)).toHaveLength(0);
			expect(record.def.persona.length).toBeGreaterThan(0);
		}
		expect(await listAgents(session)).toHaveLength(3);
	});

	it("is a no-op when ANY agent already exists (never resurrects a deleted starter)", async () => {
		await createAgent(session, { displayName: "My Own Agent" });
		expect(await seedStarterAgents(session)).toHaveLength(0);
		expect((await listAgents(session)).map((a) => a.def.displayName)).toEqual(["My Own Agent"]);

		await seedStarterAgents(session);
		expect(await listAgents(session)).toHaveLength(1);
	});
});
