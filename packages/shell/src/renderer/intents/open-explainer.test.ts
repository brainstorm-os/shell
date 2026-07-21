import { OpenRefusal, OpenRung } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { IntentDispatchResult } from "../../preload";
import { ToastKind } from "../ui/toasts";
import { formatOpenExplainer } from "./open-explainer";

function handled(rung: OpenRung, appId = "notes"): IntentDispatchResult {
	return { handled: true, handler: { appId }, rung };
}

function refused(refusal: OpenRefusal): IntentDispatchResult {
	return { handled: false, reason: "no-handler", rung: OpenRung.Refused, refusal };
}

describe("formatOpenExplainer — success rungs", () => {
	it("InVaultOpeners surfaces a success toast with the resolved app label", () => {
		const r = formatOpenExplainer(handled(OpenRung.InVaultOpeners, "notes"), {
			resolveAppLabel: (id) => (id === "notes" ? "Notes" : null),
		});
		expect(r).toEqual({
			kind: ToastKind.Success,
			titleKey: "shell.openExplainer.inVaultOpeners.title",
			params: { app: "Notes" },
		});
	});

	it("falls back to the bare app id when the resolver returns null/undefined/empty", () => {
		const cases: Array<string | null | undefined> = [null, undefined, ""];
		for (const value of cases) {
			const r = formatOpenExplainer(handled(OpenRung.InVaultOpeners, "weird-app"), {
				resolveAppLabel: () => value,
			});
			expect(r?.params?.app).toBe("weird-app");
		}
	});

	it("StoredDefault carries 'your default' phrasing via a distinct key", () => {
		const r = formatOpenExplainer(handled(OpenRung.StoredDefault, "tasks"), {
			resolveAppLabel: (id) => (id === "tasks" ? "Tasks" : null),
		});
		expect(r?.titleKey).toBe("shell.openExplainer.storedDefault.title");
		expect(r?.params?.app).toBe("Tasks");
		expect(r?.kind).toBe(ToastKind.Success);
	});

	it("OsHandoff surfaces an info toast (system handoff is not a vault choice)", () => {
		const r = formatOpenExplainer(handled(OpenRung.OsHandoff));
		expect(r).toEqual({
			kind: ToastKind.Info,
			titleKey: "shell.openExplainer.osHandoff.title",
		});
	});

	it("InternalResolver + UniversalEditor route to the generic 'handled' explainer", () => {
		for (const rung of [OpenRung.InternalResolver, OpenRung.UniversalEditor]) {
			const r = formatOpenExplainer(handled(rung, "core"));
			expect(r?.titleKey).toBe("shell.openExplainer.handled.title");
			expect(r?.kind).toBe(ToastKind.Success);
			expect(r?.params?.app).toBe("core");
		}
	});

	it("returns null when handled:true carries no rung (pre-OpenRes-1c)", () => {
		const r = formatOpenExplainer({ handled: true, handler: { appId: "notes" } });
		expect(r).toBeNull();
	});

	it("returns null on the structurally-impossible handled:true + Refused (defensive)", () => {
		const r = formatOpenExplainer({
			handled: true,
			handler: { appId: "notes" },
			rung: OpenRung.Refused,
		});
		expect(r).toBeNull();
	});
});

describe("formatOpenExplainer — refusals", () => {
	it("DangerousScheme is a warning (hard floor, user is blocked from the link)", () => {
		const r = formatOpenExplainer(refused(OpenRefusal.DangerousScheme));
		expect(r).toEqual({
			kind: ToastKind.Warning,
			titleKey: "shell.openExplainer.refused.dangerousScheme.title",
			bodyKey: "shell.openExplainer.refused.dangerousScheme.body",
		});
	});

	it("NoHandler is an error (no in-vault opener + no OS handoff)", () => {
		const r = formatOpenExplainer(refused(OpenRefusal.NoHandler));
		expect(r?.kind).toBe(ToastKind.Error);
		expect(r?.titleKey).toBe("shell.openExplainer.refused.noHandler.title");
		expect(r?.bodyKey).toBe("shell.openExplainer.refused.noHandler.body");
	});

	it("UnknownTarget is an error with its own distinct copy", () => {
		const r = formatOpenExplainer(refused(OpenRefusal.UnknownTarget));
		expect(r?.kind).toBe(ToastKind.Error);
		expect(r?.titleKey).toBe("shell.openExplainer.refused.unknownTarget.title");
	});

	it("returns null on Refused without a refusal reason (defensive against bus bug)", () => {
		const r = formatOpenExplainer({
			handled: false,
			reason: "no-handler",
			rung: OpenRung.Refused,
		});
		expect(r).toBeNull();
	});

	it("returns null for handled:false WITHOUT the Refused rung (existing UI keeps the toast)", () => {
		const cases: IntentDispatchResult[] = [
			{ handled: false, reason: "no-handler" },
			{ handled: false, reason: "cancelled" },
			{ handled: false, reason: "handler-error", message: "boom" },
			{ handled: false, reason: "no-delivery-channel" },
			// Non-Refused rung shouldn't surface explainer either — the
			// only handled:false rung the explainer claims is Refused.
			{ handled: false, reason: "handler-error", rung: OpenRung.OsHandoff },
			// OpenRes-1c slice 6 — picker Cancel stamps rung=InVaultOpeners
			// + reason=cancelled. The user explicitly chose Cancel; no
			// "you cancelled" toast spam.
			{
				handled: false,
				reason: "cancelled",
				rung: OpenRung.InVaultOpeners,
				message: "cancelled — choose an app to open https://example.com",
			},
			// OpenRes-1c slice 7 — same picker-Cancel shape; the
			// app-vs-OS fork dismiss path lands here too.
			{
				handled: false,
				reason: "cancelled",
				rung: OpenRung.InVaultOpeners,
				message: "cancelled — choose an app to open https://router.local",
			},
		];
		for (const result of cases) {
			expect(formatOpenExplainer(result)).toBeNull();
		}
	});
});

describe("formatOpenExplainer — exhaustiveness fence", () => {
	it("covers every OpenRung discriminator on the handled:true variant", () => {
		// If a new rung is added to the enum without updating the mapper,
		// this test will fail (or the type-checker will, depending on which
		// caught it first). Lists every enum member in a single pass.
		const allRungs = Object.values(OpenRung) as OpenRung[];
		for (const rung of allRungs) {
			const r = formatOpenExplainer(handled(rung));
			// Refused on handled:true is structurally bad → null is correct.
			if (rung === OpenRung.Refused) {
				expect(r).toBeNull();
				continue;
			}
			expect(r, `rung=${rung}`).not.toBeNull();
		}
	});

	it("covers every OpenRefusal discriminator on the Refused rung", () => {
		const allRefusals = Object.values(OpenRefusal) as OpenRefusal[];
		for (const refusal of allRefusals) {
			const r = formatOpenExplainer(refused(refusal));
			expect(r, `refusal=${refusal}`).not.toBeNull();
		}
	});
});
