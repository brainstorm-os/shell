// @vitest-environment jsdom
import { ConfirmKind } from "@brainstorm-os/sdk-types";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmHost, ConfirmVariant, confirm } from "./confirm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom never finishes an exit animation, so a dismissed dialog would linger
// (and block the next one under `mode="wait"`); render presence synchronously.
vi.mock("framer-motion", async (importOriginal) => ({
	...(await importOriginal<typeof import("framer-motion")>()),
	AnimatePresence: ({ children }: { children: ReactNode }) => children,
}));

describe("confirm — Don't ask again (6.15)", () => {
	let host: HTMLDivElement;
	let root: Root;
	let stored: string[];
	const confirmations = {
		list: vi.fn(() => Promise.resolve([...stored])),
		remember: vi.fn((kind: string) => {
			stored.push(kind);
			return Promise.resolve(true);
		}),
	};

	beforeEach(() => {
		stored = [];
		confirmations.list.mockClear();
		confirmations.remember.mockClear();
		(window as unknown as { brainstorm: unknown }).brainstorm = { confirmations };
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		act(() => root.render(<ConfirmHost />));
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	});

	const dialog = () => document.querySelector('[data-testid="confirm-dialog"]');
	const skipBox = () =>
		document.querySelector<HTMLInputElement>('[data-testid="confirm-dont-ask-again"] input') ??
		document.querySelector<HTMLInputElement>('input[data-testid="confirm-dont-ask-again"]');
	const clickButton = (label: string) => {
		const button = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
		if (!button) throw new Error(`no ${label} button`);
		act(() => button.click());
	};

	async function ask(kind?: ConfirmKind): Promise<{ answer: Promise<boolean> }> {
		let pending: Promise<boolean> = Promise.resolve(false);
		await act(async () => {
			pending = confirm({
				title: "Move to Bin?",
				confirmLabel: "Move",
				confirmVariant: ConfirmVariant.Destructive,
				...(kind ? { kind } : {}),
			});
			await Promise.resolve();
			await Promise.resolve();
		});
		return { answer: pending };
	}

	it("offers the checkbox on a reversible kind, remembers it, then skips the dialog", async () => {
		const { answer: first } = await ask(ConfirmKind.MoveToBin);
		expect(dialog()).not.toBeNull();
		const box = skipBox();
		expect(box).not.toBeNull();
		act(() => box?.click());
		clickButton("Move");
		await expect(first).resolves.toBe(true);
		expect(confirmations.remember).toHaveBeenCalledWith(ConfirmKind.MoveToBin);

		const { answer: second } = await ask(ConfirmKind.MoveToBin);
		await expect(second).resolves.toBe(true);
		expect(dialog()).toBeNull();
	});

	it("cancelling never remembers, even with the box ticked", async () => {
		const { answer: pending } = await ask(ConfirmKind.MoveToBin);
		act(() => skipBox()?.click());
		clickButton("Cancel");
		await expect(pending).resolves.toBe(false);
		expect(confirmations.remember).not.toHaveBeenCalled();
	});

	it("never offers the checkbox on an irreversible kind, nor on an untyped prompt", async () => {
		for (const kind of [ConfirmKind.EmptyBin, ConfirmKind.PurgeFromBin, undefined]) {
			const { answer: pending } = await ask(kind);
			expect(dialog()).not.toBeNull();
			expect(skipBox()).toBeNull();
			clickButton("Move");
			await expect(pending).resolves.toBe(true);
		}
		expect(confirmations.remember).not.toHaveBeenCalled();
	});

	it("an irreversible kind always asks even if a skip were somehow stored", async () => {
		stored = [ConfirmKind.EmptyBin];
		const { answer: pending } = await ask(ConfirmKind.EmptyBin);
		expect(dialog()).not.toBeNull();
		clickButton("Cancel");
		await expect(pending).resolves.toBe(false);
	});
});
