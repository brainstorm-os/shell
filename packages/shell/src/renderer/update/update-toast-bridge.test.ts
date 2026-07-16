import { describe, expect, it } from "vitest";
import { UpdateLifecycle } from "../../shared/update-wire-types";
import { UpdateToastKind, planUpdateToast } from "./update-toast-bridge";

describe("planUpdateToast", () => {
	it("plans an Available toast keyed to the version", () => {
		expect(
			planUpdateToast(UpdateLifecycle.Checking, {
				lifecycle: UpdateLifecycle.Available,
				version: "0.5.0",
			}),
		).toEqual({
			kind: UpdateToastKind.Available,
			dedupeKey: "available:0.5.0",
			version: "0.5.0",
		});
	});

	it("plans a Ready toast once the update is staged", () => {
		expect(
			planUpdateToast(UpdateLifecycle.Downloading, {
				lifecycle: UpdateLifecycle.Downloaded,
				version: "0.5.0",
			}),
		).toEqual({
			kind: UpdateToastKind.Ready,
			dedupeKey: "ready:0.5.0",
			version: "0.5.0",
		});
	});

	it("plans a Failed toast only when a download was in flight", () => {
		expect(
			planUpdateToast(UpdateLifecycle.Downloading, {
				lifecycle: UpdateLifecycle.Error,
				error: "disk full",
			}),
		).toEqual({ kind: UpdateToastKind.Failed, error: "disk full" });
	});

	it("stays silent on a failed background check", () => {
		expect(
			planUpdateToast(UpdateLifecycle.Checking, {
				lifecycle: UpdateLifecycle.Error,
				error: "net::ERR_INTERNET_DISCONNECTED",
			}),
		).toBeNull();
	});

	it("stays silent on every non-actionable lifecycle", () => {
		for (const lifecycle of [
			UpdateLifecycle.Idle,
			UpdateLifecycle.Unsupported,
			UpdateLifecycle.Checking,
			UpdateLifecycle.NotAvailable,
			UpdateLifecycle.Downloading,
		]) {
			expect(planUpdateToast(null, { lifecycle })).toBeNull();
		}
	});

	it("stays silent on Available/Downloaded states missing a version", () => {
		expect(planUpdateToast(null, { lifecycle: UpdateLifecycle.Available })).toBeNull();
		expect(planUpdateToast(null, { lifecycle: UpdateLifecycle.Downloaded })).toBeNull();
	});
});
