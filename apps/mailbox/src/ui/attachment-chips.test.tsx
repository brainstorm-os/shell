// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAttachmentPart } from "../types/mail-view";
import { AttachmentChips } from "./attachment-chips";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const PARTS: MailAttachmentPart[] = [
	{ partRef: "m1:a1", filename: "report.pdf", mimeType: "application/pdf", sizeBytes: 2048 },
	{ partRef: "m1:a2", filename: "photo.jpg" },
];

function chips(): HTMLButtonElement[] {
	return [...host.querySelectorAll<HTMLButtonElement>(".mb-attachment")];
}

describe("AttachmentChips", () => {
	it("renders nothing when the message carries no parts", () => {
		act(() => root.render(<AttachmentChips parts={[]} />));
		expect(host.querySelector(".mb-attachments")).toBeNull();
	});

	it("renders a chip per part with a size only when the server declared one", () => {
		act(() => root.render(<AttachmentChips parts={PARTS} onOpen={vi.fn()} />));
		const rendered = chips();
		expect(rendered).toHaveLength(2);
		expect(rendered[0]?.textContent).toContain("report.pdf");
		expect(rendered[0]?.textContent).toContain("2.0 KB");
		expect(rendered[1]?.textContent).toContain("photo.jpg");
		expect(rendered[1]?.querySelector(".mb-attachment__size")).toBeNull();
	});

	it("passes the clicked part's ref to the opener", async () => {
		const onOpen = vi.fn().mockResolvedValue(undefined);
		act(() => root.render(<AttachmentChips parts={PARTS} onOpen={onOpen} />));
		await act(async () => {
			chips()[1]?.click();
		});
		expect(onOpen).toHaveBeenCalledWith("m1:a2");
	});

	it("disables only the chip being fetched, leaving siblings clickable", async () => {
		let release: (() => void) | undefined;
		const onOpen = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		act(() => root.render(<AttachmentChips parts={PARTS} onOpen={onOpen} />));
		await act(async () => {
			chips()[0]?.click();
		});
		expect(chips()[0]?.disabled).toBe(true);
		expect(chips()[0]?.textContent).toContain("Getting");
		expect(chips()[1]?.disabled).toBe(false);
		await act(async () => {
			release?.();
		});
		expect(chips()[0]?.disabled).toBe(false);
	});

	it("ignores a second click while a fetch is already in flight", async () => {
		const onOpen = vi.fn(() => new Promise<void>(() => {}));
		act(() => root.render(<AttachmentChips parts={PARTS} onOpen={onOpen} />));
		await act(async () => {
			chips()[0]?.click();
		});
		await act(async () => {
			chips()[0]?.click();
		});
		expect(onOpen).toHaveBeenCalledTimes(1);
	});

	it("marks the failing chip rather than the whole pane, and allows a retry", async () => {
		const onOpen = vi.fn().mockRejectedValueOnce(new Error("offline"));
		act(() => root.render(<AttachmentChips parts={PARTS} onOpen={onOpen} />));
		await act(async () => {
			chips()[0]?.click();
		});
		expect(chips()[0]?.className).toContain("is-error");
		expect(chips()[1]?.className).not.toContain("is-error");

		onOpen.mockResolvedValueOnce(undefined);
		await act(async () => {
			chips()[0]?.click();
		});
		expect(chips()[0]?.className).not.toContain("is-error");
		expect(onOpen).toHaveBeenCalledTimes(2);
	});

	it("renders chips inert when no opener is supplied", () => {
		act(() => root.render(<AttachmentChips parts={PARTS} />));
		expect(chips().every((c) => c.disabled)).toBe(true);
	});
});
