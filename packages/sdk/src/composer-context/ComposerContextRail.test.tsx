import { AttachmentKind, type MessageAttachment } from "@brainstorm-os/sdk-types";
// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComposerContextRail } from "./ComposerContextRail";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const ATTACHMENTS: MessageAttachment[] = [
	{ kind: AttachmentKind.Entity, ref: "ent-1", label: "Spec doc", entityType: "Note/v1" },
	{ kind: AttachmentKind.Person, ref: "person-1", label: "Sol" },
	{
		kind: AttachmentKind.Media,
		ref: "brainstorm://asset/a1",
		label: "shot.png",
		mediaType: "image/png",
	},
];

describe("ComposerContextRail", () => {
	it("renders nothing when there are no attachments", () => {
		act(() =>
			root.render(<ComposerContextRail attachments={[]} onRemove={() => {}} removeLabel={(l) => l} />),
		);
		expect(container.querySelector('[data-testid="composer-context-rail"]')).toBeNull();
	});

	it("renders one chip per attachment, labelled and kinded", () => {
		act(() =>
			root.render(
				<ComposerContextRail
					attachments={ATTACHMENTS}
					onRemove={() => {}}
					removeLabel={(l) => `Remove ${l}`}
				/>,
			),
		);
		const chips = container.querySelectorAll(".bs-composer-context__chip");
		expect(chips).toHaveLength(3);
		expect(chips[0]?.getAttribute("data-kind")).toBe("entity");
		expect(chips[1]?.getAttribute("data-kind")).toBe("person");
		expect(chips[2]?.getAttribute("data-kind")).toBe("media");
		expect(container.textContent).toContain("Spec doc");
		expect(container.textContent).toContain("Sol");
		expect(container.textContent).toContain("shot.png");
	});

	it("falls back to the ref when an attachment has no label", () => {
		act(() =>
			root.render(
				<ComposerContextRail
					attachments={[{ kind: AttachmentKind.Entity, ref: "ent-x" }]}
					onRemove={() => {}}
					removeLabel={(l) => l}
				/>,
			),
		);
		expect(container.textContent).toContain("ent-x");
	});

	it("calls onRemove with the attachment ref when the remove button is clicked", () => {
		const removed: string[] = [];
		act(() =>
			root.render(
				<ComposerContextRail
					attachments={ATTACHMENTS}
					onRemove={(ref) => removed.push(ref)}
					removeLabel={(l) => `Remove ${l}`}
				/>,
			),
		);
		const removeBtn = container.querySelector<HTMLButtonElement>(".bs-composer-context__chip-remove");
		act(() => removeBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(removed).toEqual(["ent-1"]);
	});

	it("uses the host removeLabel for the button aria-label", () => {
		act(() =>
			root.render(
				<ComposerContextRail
					attachments={ATTACHMENTS}
					onRemove={() => {}}
					removeLabel={(l) => `Remove ${l}`}
				/>,
			),
		);
		const btn = container.querySelector(".bs-composer-context__chip-remove");
		expect(btn?.getAttribute("aria-label")).toBe("Remove Spec doc");
	});
});
