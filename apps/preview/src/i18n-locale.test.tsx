/**
 * @vitest-environment jsdom
 */
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREVIEW_I18N } from "./i18n";

function fakeRuntime(initial: string): LocaleRuntime & { emit: (locale: string) => void } {
	const listeners = new Set<(locale: string) => void>();
	return {
		locale: initial,
		onLocaleChange(handler) {
			listeners.add(handler);
			return { unsubscribe: () => listeners.delete(handler) };
		},
		emit(locale: string) {
			for (const fn of listeners) fn(locale);
		},
	};
}

describe("preview locale packs (12.15)", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	async function flush() {
		await act(async () => {
			await Promise.resolve();
		});
	}

	const importers = {
		es: async () => ({ default: { "app.title": "Vista previa", "nav.prev": "Archivo anterior" } }),
	};

	it("applies the Spanish overlay once the pack resolves", async () => {
		const rt = fakeRuntime("es");
		let out = "";
		function Probe() {
			out = useLocalePackT(PREVIEW_I18N, importers, rt)("app.title");
			return null;
		}
		act(() => root.render(<Probe />));
		await flush();
		expect(out).toBe("Vista previa");
	});

	it("re-derives when the runtime locale changes", async () => {
		const rt = fakeRuntime("en");
		let out = "";
		function Probe() {
			out = useLocalePackT(PREVIEW_I18N, importers, rt)("nav.prev");
			return null;
		}
		act(() => root.render(<Probe />));
		expect(out).toBe("Previous file");
		await act(async () => {
			rt.emit("es");
			await Promise.resolve();
		});
		await flush();
		expect(out).toBe("Archivo anterior");
	});
});
