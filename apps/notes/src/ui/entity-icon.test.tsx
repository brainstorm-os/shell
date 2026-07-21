// @vitest-environment jsdom

import { IconKind } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { EntityIcon } from "./entity-icon";

let container: HTMLDivElement;

function render(node: React.ReactElement) {
	container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => root.render(node));
	return { root };
}

afterEach(() => {
	container?.remove();
});

describe("<EntityIcon> (SDK-delegating adapter)", () => {
	it("renders the shared fallback when there is no icon", () => {
		render(<EntityIcon icon={null} size={16} fallback={<span>FB</span>} />);
		expect(container.textContent).toContain("FB");
	});

	it("rejects a malformed blob via the SDK parser → fallback", () => {
		render(
			<EntityIcon icon={{ kind: "nope", value: "" } as never} size={16} fallback={<span>FB</span>} />,
		);
		expect(container.textContent).toContain("FB");
	});

	it("mounts the SDK element for an emoji icon (its own node, not our markup)", () => {
		render(<EntityIcon icon={{ kind: IconKind.Emoji, value: "🌟" }} size={20} />);
		// The SDK helper owns the rendered node + its data attribute.
		const el = container.querySelector('[data-entity-icon-kind="emoji"]');
		expect(el).not.toBeNull();
		expect(el?.textContent).toBe("🌟");
	});

	it("renders an image icon through the SDK element + egress guard", () => {
		render(<EntityIcon icon={{ kind: IconKind.Image, value: "brainstorm://icon/abc" }} size={18} />);
		const img = container.querySelector("img");
		expect(img).not.toBeNull();
		expect(img?.getAttribute("src")).toBe("brainstorm://icon/abc");
	});

	it("blocks a non-brainstorm: image URL (SDK parser drops it) → fallback", () => {
		render(
			<EntityIcon
				icon={{ kind: IconKind.Image, value: "https://evil.example/beacon.gif" }}
				size={18}
				fallback={<span>FB</span>}
			/>,
		);
		expect(container.querySelector("img")).toBeNull();
		expect(container.textContent).toContain("FB");
	});

	it("keeps pack glyphs in-app (degrades to fallback until the chunk loads)", () => {
		render(
			<EntityIcon
				icon={{ kind: IconKind.Pack, value: "phosphor/Star" }}
				size={16}
				fallback={<span>FB</span>}
			/>,
		);
		// The Phosphor-React chunk isn't synchronously available in the test
		// runtime, so the pack branch shows the caller's fallback (the
		// documented degraded rendering) rather than a blank.
		expect(container.textContent).toContain("FB");
	});
});
