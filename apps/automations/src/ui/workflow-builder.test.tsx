// @vitest-environment jsdom
import { StepKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { type BuilderState, triggerStep } from "../logic/builder-model";
import { emptyBuilderTrigger } from "../logic/builder-trigger";
import { flush, renderInto, typeInto } from "../test/render";
import { type BuilderResult, WorkflowBuilder } from "./workflow-builder";

const APP_CAPS = ["notifications.post", "intents.dispatch:open", "entities.read:*"];

function stateWith(name: string): BuilderState {
	return { name, steps: [triggerStep(), { id: "n", kind: StepKind.Notify, title: "Hi" }] };
}

describe("WorkflowBuilder", () => {
	it("renders the builder dialog with name, trigger, steps, and capability sections", async () => {
		const h = await renderInto(
			<WorkflowBuilder
				appCapabilities={APP_CAPS}
				initialState={stateWith("Greet")}
				initialTrigger={emptyBuilderTrigger()}
				onClose={() => {}}
				onSave={() => {}}
			/>,
		);
		expect(h.container.querySelector('[data-testid="workflow-builder"]')).toBeTruthy();
		expect(h.container.querySelector('[data-testid="builder-name"]')).toBeTruthy();
		expect(h.container.querySelector('[data-testid="builder-capabilities"]')).toBeTruthy();
		expect(h.container.querySelector('[data-testid="builder-step-1"]')).toBeTruthy();
		await h.unmount();
	});

	it("shows the step's required capability in the live sheet", async () => {
		const h = await renderInto(
			<WorkflowBuilder
				appCapabilities={APP_CAPS}
				initialState={stateWith("Greet")}
				initialTrigger={emptyBuilderTrigger()}
				onClose={() => {}}
				onSave={() => {}}
			/>,
		);
		const caps = h.container.querySelector('[data-testid="builder-capabilities"]');
		expect(caps?.textContent).toContain("notifications.post");
		await h.unmount();
	});

	it("blocks save and surfaces issues for an empty name", async () => {
		const onSave = vi.fn();
		const h = await renderInto(
			<WorkflowBuilder
				appCapabilities={APP_CAPS}
				initialState={stateWith("")}
				initialTrigger={emptyBuilderTrigger()}
				onClose={() => {}}
				onSave={onSave}
			/>,
		);
		const save = h.container.querySelector('[data-testid="builder-save"]') as HTMLButtonElement;
		await flush();
		save.click();
		await flush();
		expect(onSave).not.toHaveBeenCalled();
		expect(h.container.querySelector('[role="alert"]')?.textContent ?? "").not.toBe("");
		await h.unmount();
	});

	it("saves a valid workflow, handing back the editable state + trigger", async () => {
		let result: BuilderResult | null = null;
		const h = await renderInto(
			<WorkflowBuilder
				appCapabilities={APP_CAPS}
				initialState={stateWith("Greet")}
				initialTrigger={emptyBuilderTrigger()}
				onClose={() => {}}
				onSave={(r) => {
					result = r;
				}}
			/>,
		);
		const save = h.container.querySelector('[data-testid="builder-save"]') as HTMLButtonElement;
		save.click();
		await flush();
		expect(result).not.toBeNull();
		expect((result as unknown as BuilderResult).state.name).toBe("Greet");
		await h.unmount();
	});

	it("updates the name from the input", async () => {
		let result: BuilderResult | null = null;
		const h = await renderInto(
			<WorkflowBuilder
				appCapabilities={APP_CAPS}
				initialState={stateWith("Greet")}
				initialTrigger={emptyBuilderTrigger()}
				onClose={() => {}}
				onSave={(r) => {
					result = r;
				}}
			/>,
		);
		const name = h.container.querySelector('[data-testid="builder-name"]') as HTMLInputElement;
		await typeInto(name, "Renamed");
		const save = h.container.querySelector('[data-testid="builder-save"]') as HTMLButtonElement;
		save.click();
		await flush();
		expect((result as unknown as BuilderResult).state.name).toBe("Renamed");
		await h.unmount();
	});
});
