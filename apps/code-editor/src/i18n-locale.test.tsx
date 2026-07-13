/**
 * @vitest-environment jsdom
 */
import { type LocaleRuntime, useLocalePackT } from "@brainstorm/sdk/i18n-react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODE_EDITOR_MESSAGES } from "./i18n";

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

describe("code-editor locale packs (12.15)", () => {
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
		es: async () => ({ default: { appTitle: "Editor de código", filesHeading: "Archivos" } }),
	};

	it("applies the Spanish overlay once the pack resolves", async () => {
		const rt = fakeRuntime("es");
		let out = "";
		function Probe() {
			out = useLocalePackT(CODE_EDITOR_MESSAGES, importers, rt)("appTitle");
			return null;
		}
		act(() => root.render(<Probe />));
		await flush();
		expect(out).toBe("Editor de código");
	});

	it("re-derives when the runtime locale changes", async () => {
		const rt = fakeRuntime("en");
		let out = "";
		function Probe() {
			out = useLocalePackT(CODE_EDITOR_MESSAGES, importers, rt)("filesHeading");
			return null;
		}
		act(() => root.render(<Probe />));
		expect(out).toBe("Files");
		await act(async () => {
			rt.emit("es");
			await Promise.resolve();
		});
		await flush();
		expect(out).toBe("Archivos");
	});
});