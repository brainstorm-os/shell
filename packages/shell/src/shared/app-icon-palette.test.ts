import { gradientFor } from "@brainstorm-os/protocol/app-icon-palette";
import { describe, expect, it } from "vitest";
import { gradientFor as rendererGradientFor } from "../renderer/dashboard/app-icon-palette";

describe("shared app-icon palette", () => {
	it("gradientFor is deterministic for a given seed", () => {
		expect(gradientFor("io.example.notes")).toEqual(gradientFor("io.example.notes"));
	});

	it("gradientFor returns a different gradient for different seeds (probabilistic)", () => {
		expect(gradientFor("io.example.notes")).not.toEqual(gradientFor("io.example.tasks"));
	});

	it("gradientFor returns a well-formed gradient for an empty seed", () => {
		const g = gradientFor("");
		expect(g.from).toMatch(/^#[0-9a-f]{6}$/);
		expect(g.to).toMatch(/^#[0-9a-f]{6}$/);
		expect(g.ink).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("the renderer re-export resolves to the SAME gradient (single source)", () => {
		for (const id of ["io.example.notes", "io.example.tasks", "io.example.graph", ""]) {
			expect(rendererGradientFor(id)).toEqual(gradientFor(id));
		}
	});
});
