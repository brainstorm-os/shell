/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { beginInlineEdit } from "./inline-edit";

function mountLabel(text: string): { host: HTMLElement; label: HTMLElement } {
	const host = document.createElement("div");
	const label = document.createElement("span");
	label.textContent = text;
	host.appendChild(label);
	document.body.appendChild(host);
	return { host, label };
}

function open(
	label: HTMLElement,
	onCommit = vi.fn(),
	value = label.textContent ?? "",
): {
	input: HTMLInputElement;
	onCommit: ReturnType<typeof vi.fn>;
} {
	const host = label.parentElement;
	beginInlineEdit(label, { value, ariaLabel: "Rename", inputClassName: "x-input", onCommit });
	const input = host?.querySelector("input");
	if (!input) throw new Error("no input swapped in");
	return { input: input as HTMLInputElement, onCommit };
}

describe("beginInlineEdit", () => {
	it("swaps the label for a seeded, selected input", () => {
		const { label } = mountLabel("Original");
		const { input } = open(label);
		expect(input.value).toBe("Original");
		expect(input.className).toBe("x-input");
		expect(input.getAttribute("aria-label")).toBe("Rename");
		expect(label.isConnected).toBe(false);
	});

	it("commits the trimmed, changed value on Enter and restores the label", async () => {
		const { label } = mountLabel("Original");
		const { input, onCommit } = open(label);
		input.value = "  Renamed  ";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		// The DOM restore is synchronous; the reactive onCommit is deferred (F-254).
		expect(label.isConnected).toBe(true);
		expect(label.textContent).toBe("Renamed");
		await Promise.resolve();
		expect(onCommit).toHaveBeenCalledWith("Renamed");
	});

	it("commits on blur", async () => {
		const { label } = mountLabel("Original");
		const { input, onCommit } = open(label);
		input.value = "Done";
		input.dispatchEvent(new FocusEvent("blur"));
		await Promise.resolve();
		expect(onCommit).toHaveBeenCalledWith("Done");
	});

	it("defers onCommit OUT of the blur dispatch, restoring the label synchronously (F-254)", async () => {
		const { label } = mountLabel("Original");
		const { input, onCommit } = open(label);
		input.value = "Renamed";
		input.dispatchEvent(new FocusEvent("blur"));
		// The label is back in the DOM immediately; onCommit (which re-renders the
		// host) has NOT fired inside the blur event — that's the race this avoids.
		expect(label.isConnected).toBe(true);
		expect(onCommit).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(onCommit).toHaveBeenCalledWith("Renamed");
	});

	it("does not commit an unchanged value", () => {
		const { label } = mountLabel("Original");
		const { input, onCommit } = open(label);
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("does not commit an empty value and keeps the original label", () => {
		const { label } = mountLabel("Original");
		const { input, onCommit } = open(label);
		input.value = "   ";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(onCommit).not.toHaveBeenCalled();
		expect(label.textContent).toBe("Original");
	});

	it("cancels on Escape without committing", () => {
		const { label } = mountLabel("Original");
		const { input, onCommit } = open(label);
		input.value = "Discarded";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(onCommit).not.toHaveBeenCalled();
		expect(label.isConnected).toBe(true);
		expect(label.textContent).toBe("Original");
	});

	it("refuses to open a second input in a host that is already editing", () => {
		const { host, label } = mountLabel("Original");
		const sibling = document.createElement("span");
		sibling.textContent = "Sibling";
		host.appendChild(sibling);
		open(label);
		beginInlineEdit(sibling, {
			value: "Sibling",
			ariaLabel: "Rename",
			inputClassName: "x-input",
			onCommit: vi.fn(),
		});
		expect(host.querySelectorAll("input").length).toBe(1);
		expect(sibling.isConnected).toBe(true);
	});

	it("no-ops on a detached label with no parent", () => {
		const label = document.createElement("span");
		expect(() => open(label)).toThrow("no input swapped in");
	});
});
