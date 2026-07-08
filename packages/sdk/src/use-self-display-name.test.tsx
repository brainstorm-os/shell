// @vitest-environment jsdom
import type { RosterSelf, RosterService } from "@brainstorm/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSelfDisplayName } from "./use-self-display-name";

function Probe({ roster }: { roster: RosterService | null }) {
	return <span data-testid="name">{useSelfDisplayName(roster)}</span>;
}

function rosterWith(self: Partial<RosterSelf> | Error): RosterService {
	return {
		members: vi.fn(),
		setSelf: vi.fn(),
		self: () =>
			self instanceof Error
				? Promise.reject(self)
				: Promise.resolve({
						pubkey: "pk",
						fingerprint: "ab12·cd34",
						displayName: "",
						...self,
					}),
	} as unknown as RosterService;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	globalThis.localStorage?.clear();
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const name = () => container.querySelector('[data-testid="name"]')?.textContent;
const flush = () => act(async () => await Promise.resolve());

describe("useSelfDisplayName (F-165)", () => {
	it("prefers the signed profile display name", async () => {
		act(() => root.render(<Probe roster={rosterWith({ displayName: "Mira" })} />));
		await flush();
		expect(name()).toBe("Mira");
	});

	it("falls back to the key fingerprint when the name is unset (not 'Anonymous')", async () => {
		act(() => root.render(<Probe roster={rosterWith({ displayName: "" })} />));
		await flush();
		expect(name()).toBe("ab12·cd34");
	});

	it("trims a whitespace-only name to the fingerprint", async () => {
		act(() => root.render(<Probe roster={rosterWith({ displayName: "   " })} />));
		await flush();
		expect(name()).toBe("ab12·cd34");
	});

	it("keeps a non-empty local fallback when the roster is unavailable (null)", () => {
		act(() => root.render(<Probe roster={null} />));
		expect(name()).toBeTruthy();
	});

	it("keeps the local fallback when roster.self() rejects (capability denied)", async () => {
		act(() => root.render(<Probe roster={rosterWith(new Error("denied"))} />));
		await flush();
		expect(name()).toBeTruthy();
	});
});
