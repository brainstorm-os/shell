// @vitest-environment jsdom
/**
 * The detail page's own lock guards — Lock-5(f).
 *
 * `commitName` and `commitCompany` each carry a lock check ABOVE the callback
 * they fire. Nothing asserted them: the suite only ever checked that the field
 * paints `readOnly` / the button paints `disabled`, and a chrome assertion says
 * nothing about a commit. Both guards survived deletion.
 *
 * They are not reachable through the chrome — that is the point of the chrome.
 * They are reachable through the RACE the chrome cannot cover: the field is
 * opened and typed into while the contact is unlocked, another device locks it,
 * and the blur commit fires against a page that has already repainted. These
 * tests drive exactly that, so deleting either guard sends the write out.
 */

import { YDocProvider, createYDocResolver } from "@brainstorm-os/react-yjs";
import { EMPTY_ENTITY_TITLE_SOURCE } from "@brainstorm-os/sdk/property-ui";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Person } from "../types/person";
import { PersonDetail } from "./person-detail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class StubResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

function person(over: Partial<Person> = {}): Person {
	return {
		id: "p1",
		name: "Ada Lovelace",
		emails: [],
		phones: [],
		linkIds: [],
		companyId: null,
		role: "",
		bio: "",
		birthday: null,
		anniversary: null,
		icon: null,
		cover: null,
		locked: false,
		...over,
	};
}

// In-memory Y.Doc resolver — the body editor binds a UniversalBody, and
// without a provider `useYDoc` throws before any of this page renders.
function inMemoryResolver() {
	return createYDocResolver({ load: async () => null, persist: () => {}, release: () => {} });
}

let container: HTMLDivElement;
let root: Root;
let resolver: ReturnType<typeof inMemoryResolver>;
let onRenamePerson: ReturnType<typeof vi.fn<(name: string) => void>>;
let onCreateCompany: ReturnType<typeof vi.fn<(name: string) => void>>;
let onPatch: ReturnType<typeof vi.fn<(patch: Record<string, unknown>) => void>>;

async function render(locked: boolean): Promise<void> {
	await act(async () => {
		root.render(
			<YDocProvider resolver={resolver.resolve}>
				<PersonDetail
					person={person()}
					companyName={null}
					now={0}
					properties={null}
					entityTitleSource={EMPTY_ENTITY_TITLE_SOURCE}
					showProperties={false}
					onToggleProperties={() => {}}
					locked={locked}
					coverPickerOpen={false}
					onCoverPickerOpenChange={() => {}}
					onRenamePerson={onRenamePerson}
					onPatch={onPatch}
					onCreateCompany={onCreateCompany}
					onOpenCompany={() => {}}
				/>
			</YDocProvider>,
		);
	});
}

/** Type into a CONTROLLED React input: React tracks the value setter, so a
 *  plain `input.value = …` is swallowed as "no change". */
function typeInto(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function blur(el: HTMLElement): Promise<void> {
	await act(async () => {
		el.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
		el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
	});
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	resolver = inMemoryResolver();
	onRenamePerson = vi.fn<(name: string) => void>();
	onCreateCompany = vi.fn<(name: string) => void>();
	onPatch = vi.fn<(patch: Record<string, unknown>) => void>();
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	resolver.dispose();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("PersonDetail — commitName", () => {
	it("commits a rename while the contact is unlocked", async () => {
		await render(false);
		const input = container.querySelector<HTMLInputElement>(".contacts-detail__name-input");
		if (!input) throw new Error("no name field");
		await act(async () => typeInto(input, "Ada King"));
		await blur(input);
		expect(onRenamePerson).toHaveBeenCalledWith("Ada King");
	});

	it("drops the commit when the lock lands MID-EDIT", async () => {
		// Typed while unlocked, locked by another device, then blurred. The
		// field repaints read-only but the pending draft and the blur handler
		// are already in flight — the guard is what stops the rename.
		await render(false);
		const input = container.querySelector<HTMLInputElement>(".contacts-detail__name-input");
		if (!input) throw new Error("no name field");
		await act(async () => typeInto(input, "Ada King"));
		await render(true);
		expect(input.readOnly).toBe(true);
		await blur(input);
		expect(onRenamePerson).not.toHaveBeenCalled();
	});
});

describe("PersonDetail — commitCompany", () => {
	it("mints a company from the open draft while unlocked", async () => {
		await render(false);
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".contacts-detail__add-company")?.click();
		});
		const input = container.querySelector<HTMLInputElement>(".contacts-detail__add-company-input");
		if (!input) throw new Error("no company field");
		await act(async () => typeInto(input, "Analytical Engines"));
		await blur(input);
		expect(onCreateCompany).toHaveBeenCalledWith("Analytical Engines");
	});

	it("drops the commit when the lock lands while the draft is open", async () => {
		await render(false);
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".contacts-detail__add-company")?.click();
		});
		const input = container.querySelector<HTMLInputElement>(".contacts-detail__add-company-input");
		if (!input) throw new Error("no company field");
		await act(async () => typeInto(input, "Analytical Engines"));
		await render(true);
		await blur(input);
		// Refused before the Company is minted, so there is no orphan either.
		expect(onCreateCompany).not.toHaveBeenCalled();
	});
});
