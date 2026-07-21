import { SYSTEM_TYPOGRAPHY, type TypographyDef, TypographyScale } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { typographyCssVars } from "./index";

const FAMILY_KEYS = [
	"--text-family-ui",
	"--text-family-body",
	"--text-family-code",
	"--text-family-display",
];

describe("typographyCssVars", () => {
	it("emits exactly one var per FontRole plus the scale var", () => {
		const keys = Object.keys(typographyCssVars(null)).sort();
		expect(keys).toEqual([...FAMILY_KEYS, "--typography-scale"].sort());
	});

	it("null/undefined → the SYSTEM_TYPOGRAPHY base for every role + default scale", () => {
		const vars = typographyCssVars(null);
		expect(vars["--text-family-ui"]).toBe(SYSTEM_TYPOGRAPHY.fonts.ui.stack);
		expect(vars["--text-family-code"]).toBe(SYSTEM_TYPOGRAPHY.fonts.code.stack);
		expect(vars["--typography-scale"]).toBe(TypographyScale.Default);
		for (const k of FAMILY_KEYS) expect(vars[k]).not.toBe("");
	});

	it("passes a well-formed def's stacks + scale straight through", () => {
		const def: TypographyDef = {
			name: "Serif reading",
			fonts: {
				ui: { stack: "Inter, sans-serif" },
				body: { stack: "Georgia, serif" },
				code: { stack: "JetBrains Mono, monospace" },
				display: { stack: "Playfair Display, serif" },
			},
			scale: TypographyScale.Comfortable,
		};
		const vars = typographyCssVars(def);
		expect(vars["--text-family-body"]).toBe("Georgia, serif");
		expect(vars["--text-family-display"]).toBe("Playfair Display, serif");
		expect(vars["--typography-scale"]).toBe(TypographyScale.Comfortable);
	});

	it("falls back per-role for a blank/missing stack (loose vault data)", () => {
		const def = {
			name: "Partial",
			fonts: { ui: { stack: "  " }, body: { stack: "Lora, serif" } },
			scale: TypographyScale.Default,
		} as unknown as TypographyDef;
		const vars = typographyCssVars(def);
		expect(vars["--text-family-ui"]).toBe(SYSTEM_TYPOGRAPHY.fonts.ui.stack);
		expect(vars["--text-family-body"]).toBe("Lora, serif");
		expect(vars["--text-family-code"]).toBe(SYSTEM_TYPOGRAPHY.fonts.code.stack);
	});

	it("an invalid scale degrades to the SYSTEM scale", () => {
		const def = { ...SYSTEM_TYPOGRAPHY, scale: "ginormous" } as unknown as TypographyDef;
		expect(typographyCssVars(def)["--typography-scale"]).toBe(SYSTEM_TYPOGRAPHY.scale);
	});
});
