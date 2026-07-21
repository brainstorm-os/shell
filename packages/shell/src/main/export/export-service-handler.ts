/**
 * Broker service handler for `export` (B11.12) — the capability-gated,
 * app-reachable "render my HTML to PDF" face.
 *
 * Method:
 *   - printToPdf({ html }) → Uint8Array
 *
 * Capability gating happens in the broker via the envelope's `caps`
 * (`export.printToPdf`). This module is deliberately the *pure* half: it
 * validates the argument (object · string · size cap) and delegates to an
 * injected `renderHtmlToPdf`, so the validation + error surface unit-test
 * without Electron. The privileged BrowserWindow render lives in
 * `print-to-pdf.ts` and is wired in `index.ts`.
 *
 * Throws `Invalid` on a malformed / over-large payload or unknown method;
 * `Unavailable` when the render itself fails (so a renderer crash degrades to
 * a clean error rather than a hung request).
 */

import { type CapabilityLedger, LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { EntitiesRepository } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";
import { type ExportEntity, ExportFormat, exportEntities } from "./export-formats";

export const EXPORT_PRINT_TO_PDF_CAP = "export.print-to-pdf";

const EXPORT_FORMATS = new Set<string>(Object.values(ExportFormat));

/** Hard cap on the HTML payload. A self-contained note export is far under
 *  this; the limit defends the privileged renderer against a hostile
 *  multi-hundred-MB string exhausting memory. */
export const MAX_EXPORT_HTML_BYTES = 8 * 1024 * 1024;

export type RenderHtmlToPdf = (html: string) => Promise<Uint8Array>;

export type ExportServiceOptions = {
	renderHtmlToPdf: RenderHtmlToPdf;
	/** Active vault session for `serializeEntities` (null → `Unavailable`). */
	getSession?: () => VaultSession | null;
	/** Active vault's capability ledger for the per-type read gate. */
	getLedger?: () => Promise<CapabilityLedger | null>;
};

/** `serializeEntities` reads entities, so it's gated read-only: an app gets back
 *  only the entities it may `entities.read` (others are silently filtered, never
 *  erroring — mirrors the entities service, where surfacing existence is itself
 *  information). Returns the chosen format's text; the app saves it via its own
 *  `files` capability. */
async function serializeEntities(
	options: ExportServiceOptions,
	envelope: Envelope,
): Promise<string> {
	const [raw] = envelope.args as [unknown];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw namedError("Invalid", "export.serializeEntities: argument must be an object");
	}
	const arg = raw as Record<string, unknown>;
	const format = arg.format;
	if (typeof format !== "string" || !EXPORT_FORMATS.has(format)) {
		throw namedError(
			"Invalid",
			`export.serializeEntities: format must be one of ${[...EXPORT_FORMATS].join(", ")}`,
		);
	}
	if (!Array.isArray(arg.ids) || arg.ids.some((id) => typeof id !== "string")) {
		throw namedError("Invalid", "export.serializeEntities: { ids } must be a string array");
	}
	const session = options.getSession?.() ?? null;
	const ledger = options.getLedger ? await options.getLedger() : null;
	if (!session || !ledger) {
		throw namedError("Unavailable", "export.serializeEntities: no active vault session");
	}
	const repo = new EntitiesRepository(await session.dataStores.open("entities"));
	const canRead = (type: string): boolean => {
		try {
			return ledger.has(envelope.app, `entities.read:${type}`);
		} catch (error) {
			if (error instanceof LedgerUnavailableError) {
				throw namedError("Unavailable", "export.serializeEntities: capability ledger unavailable");
			}
			throw error;
		}
	};
	const entities: ExportEntity[] = [];
	for (const id of arg.ids as string[]) {
		const row = repo.get(id);
		if (row && canRead(row.type)) {
			entities.push({ id: row.id, type: row.type, properties: row.properties });
		}
	}
	return exportEntities(format as ExportFormat, entities);
}

function namedError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function utf8ByteLength(value: string): number {
	if (typeof Buffer !== "undefined") return Buffer.byteLength(value, "utf8");
	return new TextEncoder().encode(value).length;
}

export function makeExportServiceHandler(options: ExportServiceOptions): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		if (envelope.method === "serializeEntities") {
			return serializeEntities(options, envelope);
		}
		if (envelope.method !== "printToPdf") {
			throw namedError("Invalid", `unknown export method: ${envelope.method}`);
		}
		const [arg] = envelope.args as [unknown];
		if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
			throw namedError("Invalid", "export.printToPdf: argument must be an object");
		}
		const html = (arg as Record<string, unknown>).html;
		if (typeof html !== "string") {
			throw namedError("Invalid", "export.printToPdf: html must be a string");
		}
		if (utf8ByteLength(html) > MAX_EXPORT_HTML_BYTES) {
			throw namedError(
				"Invalid",
				`export.printToPdf: html exceeds the ${MAX_EXPORT_HTML_BYTES}-byte limit`,
			);
		}
		try {
			return await options.renderHtmlToPdf(html);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown error";
			throw namedError("Unavailable", `export.printToPdf: render failed: ${detail}`);
		}
	};
}
