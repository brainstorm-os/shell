import { describe, expect, it } from "vitest";
import { MediaAlignment } from "../media-types";
import { resizedWidthPercent } from "./image-block-node";

describe("resizedWidthPercent", () => {
	it("maps the trailing-edge drag onto % of the content column", () => {
		expect(resizedWidthPercent(400, -100, 800, MediaAlignment.Left, false)).toBe(38);
		expect(resizedWidthPercent(400, 100, 800, MediaAlignment.Right, false)).toBe(63);
	});

	it("counts the drag twice for a centred image (it grows on both sides)", () => {
		expect(resizedWidthPercent(400, 100, 800, MediaAlignment.Center, false)).toBe(75);
	});

	it("flips the drag direction in RTL", () => {
		expect(resizedWidthPercent(400, 100, 800, MediaAlignment.Left, true)).toBe(38);
	});

	it("clamps to the media width range", () => {
		expect(resizedWidthPercent(400, 5000, 800, MediaAlignment.Left, false)).toBe(100);
		expect(resizedWidthPercent(400, -5000, 800, MediaAlignment.Left, false)).toBe(10);
		expect(resizedWidthPercent(400, 10, 0, MediaAlignment.Left, false)).toBe(100);
	});
});
