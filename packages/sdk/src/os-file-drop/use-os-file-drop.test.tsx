// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useOsFileDrop } from "./use-os-file-drop";

function dragEvent(type: string, files: File[] = []): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", {
		value: { types: ["Files"], files, dropEffect: "none" },
	});
	return event;
}

describe("useOsFileDrop", () => {
	it("tracks hover and delivers dropped files to the latest onFiles", () => {
		const first = vi.fn();
		const latest = vi.fn();
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		function Zone({ onFiles }: { onFiles(files: File[]): void }) {
			const { isOver, dropProps } = useOsFileDrop({ onFiles });
			return <div data-testid="zone" data-over={isOver ? "true" : "false"} {...dropProps} />;
		}
		act(() => root.render(<Zone onFiles={first} />));
		act(() => root.render(<Zone onFiles={latest} />));
		const zone = host.querySelector<HTMLElement>('[data-testid="zone"]');
		if (!zone) throw new Error("zone not rendered");

		act(() => {
			zone.dispatchEvent(dragEvent("dragenter"));
		});
		expect(zone.dataset.over).toBe("true");

		const file = new File(["x"], "x.txt");
		act(() => {
			zone.dispatchEvent(dragEvent("drop", [file]));
		});
		expect(zone.dataset.over).toBe("false");
		expect(first).not.toHaveBeenCalled();
		expect(latest).toHaveBeenCalledWith([file]);
		act(() => root.unmount());
	});
});
