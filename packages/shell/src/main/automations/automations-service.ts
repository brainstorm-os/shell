/**
 * The app-facing `automations` broker service (11b.6 deploy residue (c) +
 * 11b.15 claim surface): `runNow` (the Manual trigger), `hostStatus`, and
 * `claimHost`. Every method is re-checked server-side against the
 * `automations.run` capability (the same posture as `connectors` / `mail`
 * — the broker's declared-caps check is app-controlled, so this is the
 * authoritative gate).
 *
 * The deployment is per-vault (rebuilt on session open); `getDeployment`
 * returns null when no vault is open → `Unavailable`, fail-closed.
 */

import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { requireServiceCapability } from "../connectors/connectors-service";
import type { AutomationsDeployment } from "./wiring";

export const AUTOMATIONS_RUN_CAP = "automations.run";

export type AutomationsServiceDeps = {
	getDeployment: () => AutomationsDeployment | null;
	/** Server-side capability source; omit only in unit tests. */
	getLedger?: () => Promise<CapabilityLedger | null>;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

function requireDeployment(deps: AutomationsServiceDeps): AutomationsDeployment {
	const deployment = deps.getDeployment();
	if (!deployment) throw makeError("Unavailable", "automations: no active vault session");
	return deployment;
}

function workflowIdArg(envelope: Envelope): string {
	const [arg] = envelope.args as [unknown];
	const workflowId =
		arg && typeof arg === "object" ? (arg as { workflowId?: unknown }).workflowId : undefined;
	if (typeof workflowId !== "string" || workflowId.length === 0) {
		throw makeError(
			"Invalid",
			`automations.${envelope.method}: { workflowId } must be a non-empty string`,
		);
	}
	return workflowId;
}

export function makeAutomationsServiceHandler(deps: AutomationsServiceDeps): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		await requireServiceCapability(envelope, deps.getLedger, AUTOMATIONS_RUN_CAP, "automations");
		const deployment = requireDeployment(deps);
		switch (envelope.method) {
			case "runNow": {
				const result = await deployment.runNow(workflowIdArg(envelope));
				return { status: result?.status ?? null };
			}
			case "hostStatus":
				return deployment.hostStatus();
			case "claimHost":
				return deployment.claimHost();
			case "webhookInfo":
				return deployment.webhookInfo();
			default:
				throw makeError("Invalid", `unknown automations method: ${envelope.method}`);
		}
	};
}
