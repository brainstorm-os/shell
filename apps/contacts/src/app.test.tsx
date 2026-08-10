// @vitest-environment jsdom
/**
 * Contacts and the read-only lock — Lock-5(e).
 *
 * Lock-5(b) gated `patchPerson` / `deletePerson` and called the contact
 * covered. It was not: THREE user-reachable write paths never went near those
 * two callbacks, and a locked contact could be renamed-by-company, edited in
 * its body, or destroyed by a merge.
 *
 *   1. "+ Add company" → `createCompanyFor` → `entities.update(person)` direct.
 *   2. the page body editor → the UniversalBody Y.Doc → `entities.applyDoc`.
 *   3. "Review duplicates" → `entities.merge`, which BINS the losers.
 *
 * Each test below drives the real affordance and asserts the vault write does
 * not happen; delete the corresponding gate and the test fails.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContactsApp } from "./app";

vi.mock("@brainstorm-os/sdk/object-menu", () => ({
	openAnchoredMenu: vi.fn(),
	openObjectMenu: vi.fn(),
	closeObjectMenu: vi.fn(),
	ObjectMenuMoreButton: () => null,
	ObjectMenuTrigger: ({ children }: { children: unknown }) => children,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class StubResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

type StubEntity = { id: string; type: string; properties: Record<string, unknown> };

type Services = {
	update: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
	merge: ReturnType<typeof vi.fn>;
};

let services: Services;

function person(id: string, name: string, extra: Record<string, unknown> = {}): StubEntity {
	return { id, type: "brainstorm/Person/v1", properties: { name, ...extra } };
}

function installShell(entities: StubEntity[]): void {
	services = {
		update: vi.fn(() => Promise.resolve(null)),
		create: vi.fn((_type: string, properties: Record<string, unknown>) =>
			Promise.resolve({ id: `new_${entities.length + 1}`, properties }),
		),
		remove: vi.fn(() => Promise.resolve(null)),
		merge: vi.fn(() => Promise.resolve(null)),
	};
	(window as { brainstorm?: unknown }).brainstorm = {
		services: {
			vaultEntities: {
				list: () => Promise.resolve({ entities, links: [] }),
				onChange: () => ({ unsubscribe: () => {} }),
			},
			entities: {
				get: vi.fn(() => Promise.resolve(null)),
				update: services.update,
				create: services.create,
				delete: services.remove,
				merge: services.merge,
			},
		},
	};
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderApp(): Promise<HTMLDivElement> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(<ContactsApp />);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container;
}

/** Type into a CONTROLLED React input: React tracks the value setter, so a
 *  plain `input.value = …` is swallowed as "no change". */
function typeInto(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Open the contact whose row carries `name`. */
async function openContact(el: HTMLDivElement, name: string): Promise<void> {
	const row = [...el.querySelectorAll<HTMLButtonElement>("button.contacts-row")].find((b) =>
		b.textContent?.includes(name),
	);
	if (!row) throw new Error(`no contact row for ${name}`);
	await act(async () => {
		row.click();
	});
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	container = null;
	root = null;
	(window as { brainstorm?: unknown }).brainstorm = undefined;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("ContactsApp — the read-only lock holds on every write path", () => {
	it("renames an UNLOCKED contact from the hero field", async () => {
		installShell([person("p1", "Ada Lovelace")]);
		const el = await renderApp();
		await openContact(el, "Ada Lovelace");
		const input = el.querySelector<HTMLInputElement>(".contacts-detail__name-input");
		if (!input) throw new Error("no name field");
		expect(input.readOnly).toBe(false);
		await act(async () => {
			typeInto(input, "Ada King");
		});
		await act(async () => {
			input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(services.update).toHaveBeenCalledWith("p1", { name: "Ada King" });
	});

	it("does not paint a rename it will refuse — the locked hero field is read-only", async () => {
		installShell([person("p1", "Ada Lovelace", { locked: true })]);
		const el = await renderApp();
		await openContact(el, "Ada Lovelace");
		const input = el.querySelector<HTMLInputElement>(".contacts-detail__name-input");
		// Graph already learned this: refusing AFTER the optimistic paint leaves
		// the typed name on screen as an edit that never happened.
		expect(input?.readOnly).toBe(true);
		expect(services.update).not.toHaveBeenCalled();
	});

	it("offers no live '+ Add company' on a locked contact, and refuses the write", async () => {
		installShell([person("p1", "Ada Lovelace", { locked: true })]);
		const el = await renderApp();
		await openContact(el, "Ada Lovelace");
		const add = el.querySelector<HTMLButtonElement>(".contacts-detail__add-company");
		// The control stays VISIBLE (a vanished control takes its reason with
		// it) but disabled, with the lock named as the reason.
		expect(add).not.toBeNull();
		expect(add?.disabled).toBe(true);
		expect(add?.title).toContain("locked");
		await act(async () => {
			add?.click();
		});
		expect(el.querySelector(".contacts-detail__add-company-input")).toBeNull();
		expect(services.create).not.toHaveBeenCalled();
		expect(services.update).not.toHaveBeenCalled();
	});

	it("mints + links a company from '+ Add company' when the contact is unlocked", async () => {
		installShell([person("p1", "Ada Lovelace")]);
		const el = await renderApp();
		await openContact(el, "Ada Lovelace");
		await act(async () => {
			el.querySelector<HTMLButtonElement>(".contacts-detail__add-company")?.click();
		});
		const input = el.querySelector<HTMLInputElement>(".contacts-detail__add-company-input");
		if (!input) throw new Error("no company field");
		await act(async () => {
			typeInto(input, "Analytical Engines");
		});
		await act(async () => {
			input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
		});
		expect(services.create).toHaveBeenCalledWith("brainstorm/Company/v1", {
			name: "Analytical Engines",
		});
		expect(services.update).toHaveBeenCalledWith("p1", { company: "new_2" });
	});

	it("locks the contact BODY too — the notes surface is a write path like any other", async () => {
		installShell([person("p1", "Ada Lovelace", { locked: true })]);
		const el = await renderApp();
		await openContact(el, "Ada Lovelace");
		const body = el.querySelector(".contacts-detail__editor");
		expect(body).not.toBeNull();
		expect(body?.getAttribute("contenteditable")).toBe("false");
	});

	it("leaves an unlocked contact's body editable", async () => {
		installShell([person("p1", "Ada Lovelace")]);
		const el = await renderApp();
		await openContact(el, "Ada Lovelace");
		expect(el.querySelector(".contacts-detail__editor")?.getAttribute("contenteditable")).toBe(
			"true",
		);
	});

	it("keeps a locked contact out of duplicate review — a merge would DESTROY it", async () => {
		installShell([
			person("p1", "Ada Lovelace", { email: ["ada@example.com"] }),
			person("p2", "Ada Lovelace", { email: ["ada@example.com"], locked: true }),
		]);
		const el = await renderApp();
		// With the locked twin excluded the pair is no longer a duplicate group,
		// so the review affordance does not offer it at all.
		expect(el.querySelector('[data-testid="contacts-dups-open"]')).toBeNull();
	});

	it("still reviews duplicates when neither contact is locked", async () => {
		installShell([
			person("p1", "Ada Lovelace", { email: ["ada@example.com"] }),
			person("p2", "Ada Lovelace", { email: ["ada@example.com"] }),
		]);
		const el = await renderApp();
		const open = el.querySelector<HTMLButtonElement>('[data-testid="contacts-dups-open"]');
		expect(open).not.toBeNull();
		await act(async () => {
			open?.click();
		});
		await act(async () => {
			el.querySelector<HTMLButtonElement>('[data-testid="contacts-dups-review"]')?.click();
		});
		await act(async () => {
			el.querySelector<HTMLButtonElement>('[data-testid="contacts-dups-merge"]')?.click();
		});
		expect(services.merge).toHaveBeenCalled();
	});
});
