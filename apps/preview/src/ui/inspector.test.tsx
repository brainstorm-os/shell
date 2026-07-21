// @vitest-environment jsdom
import { RightPanelTab } from "@brainstorm-os/editor";
import { describe, expect, it } from "vitest";
import { flush, renderInto } from "../test/render";
import { Inspector } from "./inspector";

const NOOP = () => undefined;

describe("Inspector (facts fallback)", () => {
	it("renders filename, type, size, modified, and renderer pairs for a file with no entity", async () => {
		const { container, unmount } = await renderInto(
			<Inspector
				runtime={undefined}
				entityId={null}
				file={{
					name: "demo.md",
					mime: "text/markdown",
					sizeBytes: 1234,
					modifiedAt: new Date(2026, 0, 1, 12, 0, 0, 0).getTime(),
				}}
				pairs={[["Words", "120"]]}
				activeTab={RightPanelTab.Properties}
				onTabChange={NOOP}
				onClose={NOOP}
			/>,
		);
		await flush();
		expect(container.querySelector(".bs-props__title")?.textContent).toBe("demo.md");
		const labels = Array.from(container.querySelectorAll("dl dt")).map((r) => r.textContent);
		expect(labels).toEqual(["Type", "Size", "Modified", "Words"]);
		await unmount();
	});

	it("renders an empty state when no file is selected", async () => {
		const { container, unmount } = await renderInto(
			<Inspector
				runtime={undefined}
				entityId={null}
				file={null}
				pairs={[]}
				activeTab={RightPanelTab.Properties}
				onTabChange={NOOP}
				onClose={NOOP}
			/>,
		);
		await flush();
		expect(container.querySelector(".bs-props__status")?.textContent).toBe("No file selected");
		await unmount();
	});
});
