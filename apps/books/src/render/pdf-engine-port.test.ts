// @vitest-environment jsdom
import type { PdfEngineDocument, PdfEnginePage } from "@brainstorm-os/sdk/pdf-engine";
import { describe, expect, it, vi } from "vitest";
import { enginePagePort } from "./pdf-engine-port";

function fakePage(
	width: number,
	height: number,
): {
	page: PdfEnginePage;
	render: ReturnType<typeof vi.fn>;
} {
	const render = vi.fn().mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() });
	const page: PdfEnginePage = {
		getViewport: ({ scale }) => ({ width: width * scale, height: height * scale }),
		render,
	};
	return { page, render };
}

function fakeDoc(
	pages: PdfEnginePage[],
	gate?: Promise<void>,
): { doc: PdfEngineDocument; destroy: ReturnType<typeof vi.fn> } {
	const destroy = vi.fn().mockResolvedValue(undefined);
	const doc: PdfEngineDocument = {
		numPages: pages.length,
		getPage: async (n) => {
			await gate;
			const page = pages[n - 1];
			if (!page) throw new Error(`no page ${n}`);
			return page;
		},
		getMetadata: async () => ({}),
		getOutline: async () => null,
		getDestination: async () => null,
		getPageIndex: async () => 0,
		destroy,
	};
	return { doc, destroy };
}

function contextfulCanvas(): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	vi.spyOn(canvas, "getContext").mockReturnValue({} as never);
	return canvas;
}

describe("enginePagePort", () => {
	it("maps numPages and renders the 1-based page fitted to the stage", async () => {
		const { page, render } = fakePage(100, 200);
		const { doc } = fakeDoc([fakePage(10, 10).page, page]);
		const port = enginePagePort(doc);
		expect(port.pageCount).toBe(2);

		const canvas = contextfulCanvas();
		const handle = port.renderPage(1, canvas, 50, 1000);
		await handle?.promise;
		// fitScale(100, 200, 50, 1000) = 0.5; jsdom devicePixelRatio = 1.
		expect(render).toHaveBeenCalledTimes(1);
		expect(canvas.width).toBe(50);
		expect(canvas.height).toBe(100);
	});

	it("a cancel before the page resolves skips the paint", async () => {
		let open = (): void => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const { page, render } = fakePage(100, 100);
		const { doc } = fakeDoc([page], gate);
		const port = enginePagePort(doc);

		const handle = port.renderPage(0, contextfulCanvas(), 100, 100);
		handle?.cancel();
		open();
		await handle?.promise;
		expect(render).not.toHaveBeenCalled();
	});

	it("dispose destroys the document", () => {
		const { doc, destroy } = fakeDoc([fakePage(10, 10).page]);
		enginePagePort(doc).dispose();
		expect(destroy).toHaveBeenCalledTimes(1);
	});
});
