/**
 * Agent directory (Agent-Teams-1) — the real path over a tmpdir vault: create
 * mints a sealed key + a parseable `Agent/v1` row; grants ride the SAME
 * CapabilityLedger the broker enforces, keyed on the agent fingerprint; the
 * grant gate fail-closes on unknown agents and non-grantable capabilities;
 * delete revokes the whole ceiling and destroys the key. Audit rows land in
 * the vault audit log keyed on the agent fingerprint.
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { AgentAutonomy, AgentRouting } from "@brainstorm-os/sdk-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasAgentKey } from "../credentials/agent-keys";
import { generateSymmetricKey } from "../credentials/crypto";
import { CredentialStore } from "../credentials/store";
import { DataStores } from "../storage/data-stores";
import { auditLogPath } from "../vault/audit-log";
import {
	type AgentDirectorySession,
	createAgent,
	deleteAgent,
	findAgentByFingerprint,
	grantAgentCapability,
	listAgentGrants,
	listAgents,
	revokeAgentCapability,
	updateAgent,
} from "./agent-directory";

describe("agent-directory (Agent-Teams-1)", () => {
	let vaultDir: string;
	let stores: DataStores;
	let session: AgentDirectorySession;
	let ledger: CapabilityLedger;

	beforeEach(async () => {
		vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-agents-"));
		stores = new DataStores(vaultDir);
		const credentials = new CredentialStore(vaultDir, generateSymmetricKey());
		const ledgerDb = await stores.open("ledger");
		ledger = new CapabilityLedger(ledgerDb);
		session = {
			vaultId: "vault_test",
			vaultPath: vaultDir,
			credentials,
			dataStores: { open: (name) => stores.open(name) },
			capabilityLedger: async () => ledger,
		};
	});

	afterEach(async () => {
		stores.close();
		await rm(vaultDir, { recursive: true, force: true });
	});

	it("create mints a sealed key and a listable Agent/v1 record with conservative defaults", async () => {
		const record = await createAgent(session, { displayName: "  Researcher  " });
		expect(record.def.displayName).toBe("Researcher");
		expect(record.def.routing).toBe(AgentRouting.LocalOnly);
		expect(record.def.autonomy).toBe(AgentAutonomy.ConfirmOnWrite);
		expect(record.def.fingerprint).toMatch(/^ed25519:[0-9a-f]{16}$/);
		await expect(hasAgentKey(session.credentials, record.def.fingerprint)).resolves.toBe(true);

		const listed = await listAgents(session);
		expect(listed.map((a) => a.id)).toEqual([record.id]);
		await expect(findAgentByFingerprint(session, record.def.fingerprint)).resolves.toMatchObject({
			id: record.id,
		});
	});

	it("two agents are distinct principals", async () => {
		const a = await createAgent(session, { displayName: "A" });
		const b = await createAgent(session, { displayName: "B" });
		expect(a.def.fingerprint).not.toBe(b.def.fingerprint);
		expect(a.def.pubkey).not.toBe(b.def.pubkey);
	});

	it("refuses an empty display name", async () => {
		await expect(createAgent(session, { displayName: "   " })).rejects.toMatchObject({
			name: "Invalid",
		});
	});

	it("update edits persona/traits but can never touch identity", async () => {
		const record = await createAgent(session, { displayName: "Researcher" });
		const updated = await updateAgent(session, record.id, {
			persona: "You verify claims.",
			routing: AgentRouting.CloudAllowed,
		});
		expect(updated?.def.persona).toBe("You verify claims.");
		expect(updated?.def.routing).toBe(AgentRouting.CloudAllowed);
		expect(updated?.def.pubkey).toBe(record.def.pubkey);
		expect(updated?.def.fingerprint).toBe(record.def.fingerprint);
	});

	it("grants land in the broker's ledger under the agent fingerprint", async () => {
		const record = await createAgent(session, { displayName: "Researcher" });
		const fp = record.def.fingerprint;
		const result = await grantAgentCapability(session, fp, "entities.read:brainstorm/Task/v1");
		expect(result.granted).toBe(true);
		// The exact check the broker runs for any principal:
		expect(ledger.has(fp, "entities.read:brainstorm/Task/v1")).toBe(true);
		expect(ledger.has(fp, "entities.read:brainstorm/Event/v1")).toBe(false);
		const grants = await listAgentGrants(session, fp);
		expect(grants).toHaveLength(1);
		expect(grants[0]).toMatchObject({ capability: "entities.read", scope: "brainstorm/Task/v1" });
	});

	it("fail-closes granting to a fingerprint no live agent owns", async () => {
		const result = await grantAgentCapability(session, "ed25519:00000000deadbeef", "entities.read:*");
		expect(result).toEqual({ granted: false, reason: "unknown-agent" });
	});

	it("fail-closes non-grantable capabilities (the write/network/dispatch invariants)", async () => {
		const record = await createAgent(session, { displayName: "Researcher" });
		const fp = record.def.fingerprint;
		for (const cap of [
			"entities.write:*",
			"network.egress:https://x.example",
			"intents.dispatch:open",
			"sharing.share",
		]) {
			await expect(grantAgentCapability(session, fp, cap)).resolves.toEqual({
				granted: false,
				reason: "not-grantable",
			});
		}
		expect(await listAgentGrants(session, fp)).toHaveLength(0);
	});

	it("revoke removes a live grant and returns false on a second try", async () => {
		const record = await createAgent(session, { displayName: "Researcher" });
		const fp = record.def.fingerprint;
		await grantAgentCapability(session, fp, "search.read");
		expect(await revokeAgentCapability(session, fp, "search.read")).toBe(true);
		expect(ledger.has(fp, "search.read")).toBe(false);
		expect(await revokeAgentCapability(session, fp, "search.read")).toBe(false);
	});

	it("delete revokes the whole ceiling, destroys the key, and unlists the agent", async () => {
		const record = await createAgent(session, { displayName: "Researcher" });
		const fp = record.def.fingerprint;
		await grantAgentCapability(session, fp, "search.read");
		await grantAgentCapability(session, fp, "entities.read:*");

		expect(await deleteAgent(session, record.id)).toBe(true);
		expect(ledger.has(fp, "search.read")).toBe(false);
		expect(ledger.has(fp, "entities.read:anything/T/v1")).toBe(false);
		await expect(hasAgentKey(session.credentials, fp)).resolves.toBe(false);
		expect(await listAgents(session)).toHaveLength(0);
		// Deleting again is a clean no-op.
		expect(await deleteAgent(session, record.id)).toBe(false);
	});

	it("appends audit rows keyed on the agent fingerprint", async () => {
		const record = await createAgent(session, { displayName: "Researcher" });
		const fp = record.def.fingerprint;
		await grantAgentCapability(session, fp, "search.read");
		await revokeAgentCapability(session, fp, "search.read");
		await deleteAgent(session, record.id);
		// appendAuditEvent is fire-and-forget; give the writes a beat.
		await new Promise((r) => setTimeout(r, 50));
		const log = await readFile(auditLogPath(vaultDir), "utf8");
		const kinds = log
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((e) => e.agent === fp)
			.map((e) => e.kind);
		expect(kinds).toEqual(["agent.create", "agent.grant", "agent.revoke", "agent.delete"]);
	});
});
