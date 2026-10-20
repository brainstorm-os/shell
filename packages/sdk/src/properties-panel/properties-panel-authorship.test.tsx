// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PropertiesPanel } from "./index";

describe("<PropertiesPanel authorship> (Agent-16)", () => {
	let host: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});
	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	it("shows 'Created by <agent>' from the stamp ahead of the host's meta", () => {
		act(() =>
			root.render(
				<PropertiesPanel
					title="Properties"
					rows={[]}
					entityId="e1"
					meta={[{ label: "Modified", value: "now" }]}
					authorship={{
						properties: {
							agentProvenance: { agent: "io.brainstorm.agent", conversationId: "c", createdAt: 1 },
						},
					}}
				/>,
			),
		);
		const rows = [...host.querySelectorAll(".bs-props__meta-row")].map((r) => r.textContent);
		expect(rows).toEqual(["Created byAgent", "Modifiednow"]);
	});

	it("renders no authorship row for an object no agent created", () => {
		act(() =>
			root.render(
				<PropertiesPanel
					title="P"
					rows={[]}
					entityId="e1"
					authorship={{ properties: { title: "x" } }}
				/>,
			),
		);
		expect(host.querySelector(".bs-props__meta")).toBeNull();
	});
});
