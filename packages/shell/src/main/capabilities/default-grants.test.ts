/**
 * Scarce-capability invariant: `system.open-external` (OS handoff, doc
 * 57 §System default) must be held by the trusted shell identity but
 * **never** auto-granted to an app at install. An app/agent that wants
 * to fling a URL/file at the OS must request it explicitly — the
 * default-minimum set must not leak it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_APP_CAPABILITIES,
	SHELL_CAPABILITIES,
	SHELL_IDENTITY,
	applyDefaultAppGrants,
	applyShellGrants,
} from "@brainstorm-os/capabilities/default-grants";
import { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { describe, expect, it } from "vitest";
import { ENVELOPE_PROTOCOL_VERSION, isEnvelope } from "../../ipc/envelope";
import { DataStores } from "../storage/data-stores";

const OPEN_EXTERNAL = "system.open-external";

// Every declared capability must pass the envelope's CAPABILITY_PATTERN —
// otherwise an app stamping it gets `Invalid` from the broker *before* the
// grant check, so the call silently fails for a fully-granted app. This is
// exactly how `export.printToPdf` (camelCase → fails the lowercase pattern)
// shipped broken: nothing exercised the real envelope path, so PDF export
// always failed at the file-save step. Guard the whole set, not just that one.
describe("every declared capability is a valid envelope capability string", () => {
	const all = [...DEFAULT_APP_CAPABILITIES, ...SHELL_CAPABILITIES].map((c) => c.capability);
	for (const capability of [...new Set(all)]) {
		it(`accepts "${capability}"`, () => {
			const wire = {
				v: ENVELOPE_PROTOCOL_VERSION,
				msg: "m1",
				app: "io.example.app",
				service: "export",
				method: "probe",
				args: [],
				caps: [capability],
			};
			expect(isEnvelope(wire)).toBe(true);
		});
	}
});

describe("system.open-external is shell-scarce", () => {
	it("is in the shell set but not the default-app set (static)", () => {
		expect(SHELL_CAPABILITIES.map((c) => c.capability)).toContain(OPEN_EXTERNAL);
		expect(DEFAULT_APP_CAPABILITIES.map((c) => c.capability)).not.toContain(OPEN_EXTERNAL);
	});

	it("is granted to the shell but denied to a freshly-installed app (ledger)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bs-grants-"));
		const stores = new DataStores(dir);
		try {
			const ledger = new CapabilityLedger(await stores.open("ledger"));
			applyShellGrants(ledger);
			applyDefaultAppGrants(ledger, "io.example.app");
			expect(ledger.has(SHELL_IDENTITY, OPEN_EXTERNAL)).toBe(true);
			expect(ledger.has("io.example.app", OPEN_EXTERNAL)).toBe(false);
			// sanity: the app still gets its real default-minimum caps
			expect(ledger.has("io.example.app", "storage.kv")).toBe(true);
		} finally {
			stores.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
