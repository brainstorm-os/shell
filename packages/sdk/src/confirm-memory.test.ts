import { ConfirmKind, confirmSkipKey } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { createConfirmMemory } from "./confirm-memory";

function memorySettings() {
	const values = new Map<string, unknown>();
	return {
		values,
		get: vi.fn(async (key: string) => (values.has(key) ? values.get(key) : null)) as never,
		put: vi.fn(async (key: string, value: unknown) => {
			values.set(key, value);
		}),
	};
}

describe("createConfirmMemory (6.15)", () => {
	it("remembers a reversible kind under the reserved key", async () => {
		const settings = memorySettings();
		const memory = createConfirmMemory(settings);
		expect(memory.canRemember(ConfirmKind.MoveToBin)).toBe(true);
		expect(await memory.isSkipped(ConfirmKind.MoveToBin)).toBe(false);
		expect(await memory.remember(ConfirmKind.MoveToBin)).toBe(true);
		expect(settings.values.get(confirmSkipKey(ConfirmKind.MoveToBin))).toBe(true);
		expect(await memory.isSkipped(ConfirmKind.MoveToBin)).toBe(true);
	});

	it("refuses an irreversible kind and never reports it skipped", async () => {
		const settings = memorySettings();
		settings.values.set(confirmSkipKey(ConfirmKind.EmptyBin), true);
		const memory = createConfirmMemory(settings);
		expect(memory.canRemember(ConfirmKind.EmptyBin)).toBe(false);
		expect(await memory.remember(ConfirmKind.PurgeFromBin)).toBe(false);
		expect(await memory.isSkipped(ConfirmKind.EmptyBin)).toBe(false);
		expect(settings.put).not.toHaveBeenCalled();
	});

	it("degrades to always-ask without a settings service or on a failing one", async () => {
		const none = createConfirmMemory(undefined);
		expect(none.canRemember(ConfirmKind.MoveToBin)).toBe(false);
		expect(await none.isSkipped(ConfirmKind.MoveToBin)).toBe(false);
		const broken = createConfirmMemory({
			get: () => Promise.reject(new Error("Unavailable")),
			put: () => Promise.reject(new Error("Unavailable")),
		});
		expect(await broken.isSkipped(ConfirmKind.MoveToBin)).toBe(false);
		expect(await broken.remember(ConfirmKind.MoveToBin)).toBe(false);
	});
});
