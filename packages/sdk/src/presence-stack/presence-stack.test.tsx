// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PresencePeer, PresenceStack, capPresence, presenceInitials } from "./presence-stack";

const peer = (id: string, name: string, color = "#2f6df6"): PresencePeer => ({ id, name, color });

describe("capPresence", () => {
	it("de-dupes by id (a peer's multiple tabs collapse), order preserved", () => {
		const { shown, overflow } = capPresence(
			[peer("u1", "Alice"), peer("u1", "Alice (tab 2)"), peer("u2", "Bob")],
			5,
		);
		expect(shown.map((p) => p.id)).toEqual(["u1", "u2"]);
		expect(overflow).toBe(0);
	});

	it("caps at max and reports the overflow of DISTINCT peers", () => {
		const { shown, overflow } = capPresence(
			[peer("a", "A"), peer("b", "B"), peer("c", "C"), peer("d", "D")],
			2,
		);
		expect(shown.map((p) => p.id)).toEqual(["a", "b"]);
		expect(overflow).toBe(2);
	});

	it("max <= 0 shows none (all overflow)", () => {
		expect(capPresence([peer("a", "A"), peer("b", "B")], 0)).toEqual({ shown: [], overflow: 2 });
	});

	it("empty input is empty", () => {
		expect(capPresence([], 3)).toEqual({ shown: [], overflow: 0 });
	});
});

describe("presenceInitials", () => {
	it("takes first+last initial for a multi-word name", () => {
		expect(presenceInitials("Ada Lovelace")).toBe("AL");
	});
	it("takes up to two letters for a single word", () => {
		expect(presenceInitials("mira")).toBe("MI");
	});
	it("degrades a blank name to ?", () => {
		expect(presenceInitials("   ")).toBe("?");
	});
});

describe("<PresenceStack>", () => {
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

	it("renders nothing when no peers are present", () => {
		act(() => root.render(<PresenceStack peers={[]} />));
		expect(container.querySelector(".bs-presence")).toBeNull();
	});

	it("renders one avatar per distinct peer plus a +N chip over max", () => {
		const peers = [peer("a", "Ann"), peer("b", "Bo"), peer("c", "Cy"), peer("d", "Di")];
		act(() => root.render(<PresenceStack peers={peers} max={2} />));
		expect(container.querySelectorAll(".bs-presence__avatar").length).toBe(2);
		const more = container.querySelector(".bs-presence__more");
		expect(more?.textContent).toBe("+2");
		// The group is labelled with the TOTAL distinct count, not just the shown.
		expect(container.querySelector(".bs-presence")?.getAttribute("aria-label")).toBe("4 people here");
	});

	it("renders an avatar image when resolveAvatar yields a url, else initials", () => {
		const peers = [{ ...peer("a", "Ann"), avatarRef: "brainstorm://asset/x" }, peer("b", "Bo")];
		act(() =>
			root.render(<PresenceStack peers={peers} resolveAvatar={(r) => (r ? "blob:avatar" : null)} />),
		);
		expect(container.querySelector(".bs-presence__img")?.getAttribute("src")).toBe("blob:avatar");
		// Bo has no avatarRef → initials fallback.
		const avatars = [...container.querySelectorAll(".bs-presence__avatar")];
		expect(avatars[1]?.textContent).toBe("BO");
	});

	it("labels a single peer with the singular form", () => {
		act(() => root.render(<PresenceStack peers={[peer("a", "Ann")]} />));
		expect(container.querySelector(".bs-presence")?.getAttribute("aria-label")).toBe("1 person here");
	});
});
