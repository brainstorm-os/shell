import { describe, expect, it } from "vitest";
import { auditPanelToggles, panelToggleElements } from "./check-panel-toggles.mjs";

const right = (extra = "") => `
	<PanelToggleButton
		side={PanelSide.Right}
		open={propsOpen}
		onClick={toggleProps}
		labels={{ show: t("show"), hide: t("hide") }}${extra}
	/>
`;

const left = `
	<PanelToggleButton
		side={PanelSide.Left}
		open={navOpen}
		onClick={toggleNav}
		labels={{ show: t("show"), hide: t("hide") }}
	/>
`;

describe("panelToggleElements", () => {
	it("yields one props slice per self-closing element", () => {
		const found = [...panelToggleElements(`${left}${right()}`)];
		expect(found).toHaveLength(2);
		expect(found[0]).toContain("PanelSide.Left");
		expect(found[1]).toContain("PanelSide.Right");
	});

	it("yields nothing for a file with no toggles", () => {
		expect([...panelToggleElements("const x = 1;")]).toHaveLength(0);
	});
});

describe("auditPanelToggles", () => {
	const audit = (sources, baseline = []) => auditPanelToggles({ sources, baseline });

	it("passes a right toggle that declares `disabled`", () => {
		const res = audit([{ file: "apps/a/src/app.tsx", src: right("\n\t\tdisabled={!sel}") }]);
		expect(res.newViolations).toEqual([]);
		expect(res.handRolled).toEqual([]);
	});

	it("flags a right toggle with no availability decision", () => {
		const res = audit([{ file: "apps/a/src/app.tsx", src: right() }]);
		expect(res.newViolations).toEqual(["apps/a/src/app.tsx"]);
	});

	it("ignores left toggles — a nav sidebar does not depend on the selection", () => {
		const res = audit([{ file: "apps/a/src/app.tsx", src: left }]);
		expect(res.newViolations).toEqual([]);
	});

	it("does not let a sibling toggle's `disabled` cover an undeclared one", () => {
		const src = `${right("\n\t\tdisabled={!sel}")}${right()}`;
		expect(audit([{ file: "apps/a/src/app.tsx", src }]).newViolations).toEqual([
			"apps/a/src/app.tsx",
		]);
	});

	it("reports a file once however many undeclared toggles it has", () => {
		const src = `${right()}${right()}`;
		expect(audit([{ file: "apps/a/src/app.tsx", src }]).newViolations).toEqual([
			"apps/a/src/app.tsx",
		]);
	});

	it("suppresses a baselined always-live panel", () => {
		const res = audit([{ file: "apps/a/src/app.tsx", src: right() }], ["apps/a/src/app.tsx"]);
		expect(res.newViolations).toEqual([]);
		expect(res.staleBaseline).toEqual([]);
	});

	it("reports a baseline entry that no longer offends (the ratchet floor)", () => {
		const res = audit(
			[{ file: "apps/a/src/app.tsx", src: right("\n\t\tdisabled={!sel}") }],
			["apps/a/src/app.tsx"],
		);
		expect(res.staleBaseline).toEqual(["apps/a/src/app.tsx"]);
	});

	it("flags an app reaching for the SDK's private toggle glyph", () => {
		const src = `import { panelToggleIcon } from "@brainstorm-os/sdk/panel-toggle";`;
		expect(audit([{ file: "apps/a/src/app.ts", src }]).handRolled).toEqual(["apps/a/src/app.ts"]);
	});

	it("does not mistake createPanelToggleButton for a hand-rolled toggle", () => {
		const src = `import { createPanelToggleButton } from "@brainstorm-os/sdk/panel-toggle";`;
		expect(audit([{ file: "apps/a/src/app.ts", src }]).handRolled).toEqual([]);
	});
});
