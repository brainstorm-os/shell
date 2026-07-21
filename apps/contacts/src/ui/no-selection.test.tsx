// @vitest-environment jsdom
/**
 * Nothing-selected pane — pins the F-321-adjacent dogfood fix: the empty
 * detail pane is the shared `<EmptyState>` with an actionable "New contact"
 * CTA (like Chat / Mailbox / Books), and the hint stops pointing at the
 * contact list when that panel is hidden.
 */

import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoSelection } from "./no-selection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	document.body.replaceChildren();
});

function render(props: { listOpen: boolean; onCreate: () => void }): void {
	act(() => {
		root.render(<NoSelection {...props} />);
	});
}

describe("NoSelection", () => {
	it("renders the shared EmptyState with a New-contact CTA that fires onCreate", () => {
		const onCreate = vi.fn();
		render({ listOpen: true, onCreate });

		expect(container.querySelector(".bs-empty-state")).not.toBeNull();
		expect(container.querySelector(".bs-empty-state__title")?.textContent).toBe(
			"No contact selected",
		);
		expect(container.querySelector(".bs-empty-state__hint")?.textContent).toBe(
			"Choose a person from the list, or create a new contact.",
		);

		const cta = container.querySelector<HTMLButtonElement>(
			'[data-testid="contacts-placeholder-new"]',
		);
		expect(cta?.textContent).toBe("New contact");
		act(() => {
			cta?.click();
		});
		expect(onCreate).toHaveBeenCalledTimes(1);
	});

	it("uses the address-book people glyph, not the generic Entity cube fallback", () => {
		render({ listOpen: true, onCreate: vi.fn() });
		const glyph = container.querySelector(".bs-empty-state__glyph")?.innerHTML ?? "";
		expect(glyph).not.toBe("");

		function renderIcon(name: IconName): string {
			const host = document.createElement("div");
			const iconRoot = createRoot(host);
			act(() => iconRoot.render(<Icon name={name} size={28} />));
			const html = host.innerHTML;
			act(() => iconRoot.unmount());
			return html;
		}

		expect(glyph).toBe(renderIcon(IconName.AddressBook));
		expect(glyph).not.toBe(renderIcon(IconName.Entity));
	});

	it("drops the choose-from-the-list instruction when the list panel is hidden", () => {
		render({ listOpen: false, onCreate: vi.fn() });
		expect(container.querySelector(".bs-empty-state__hint")?.textContent).toBe(
			"Show the contact list to browse people, or create a new contact.",
		);
		expect(container.querySelector('[data-testid="contacts-placeholder-new"]')).not.toBeNull();
	});
});
