import type { FormatContext } from "@brainstorm-os/sdk-types";
// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalePackImporters } from "./common-labels";
import {
	type FormatRuntime,
	type LocaleRuntime,
	useFormatContext,
	useFormatDate,
	useFormatNumber,
	useLocale,
	useLocalePackT,
	useT,
} from "./react";

/** A controllable fake of the SDK runtime's locale surface — mirrors what the
 *  shell preload exposes (`buildRuntimeWithEmitter`): a snapshot `locale` plus
 *  an `onLocaleChange` the host drives. */
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

describe("useLocale (12.15)", () => {
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
		(globalThis as { brainstorm?: unknown }).brainstorm = undefined;
	});

	it("seeds from the runtime's launch locale", () => {
		const rt = fakeRuntime("es-ES");
		const seen: string[] = [];
		function Probe() {
			seen.push(useLocale(rt));
			return null;
		}
		act(() => root.render(<Probe />));
		expect(seen[seen.length - 1]).toBe("es-ES");
	});

	it("re-renders with the new tag when the runtime emits a change", () => {
		const rt = fakeRuntime("en");
		const seen: string[] = [];
		function Probe() {
			seen.push(useLocale(rt));
			return null;
		}
		act(() => root.render(<Probe />));
		act(() => rt.emit("de-DE"));
		expect(seen[seen.length - 1]).toBe("de-DE");
	});

	it("ignores an empty / non-string emission", () => {
		const rt = fakeRuntime("fr");
		const seen: string[] = [];
		function Probe() {
			seen.push(useLocale(rt));
			return null;
		}
		act(() => root.render(<Probe />));
		act(() => rt.emit(""));
		expect(seen[seen.length - 1]).toBe("fr");
	});

	it("falls back to DEFAULT_LOCALE on a null runtime (non-shell host)", () => {
		const seen: string[] = [];
		function Probe() {
			seen.push(useLocale(null));
			return null;
		}
		act(() => root.render(<Probe />));
		expect(seen[seen.length - 1]).toBe("en");
	});

	it("reads the ambient window.brainstorm when no runtime is passed", () => {
		(globalThis as { brainstorm?: LocaleRuntime }).brainstorm = fakeRuntime("ja");
		const seen: string[] = [];
		function Probe() {
			seen.push(useLocale());
			return null;
		}
		act(() => root.render(<Probe />));
		expect(seen[seen.length - 1]).toBe("ja");
	});
});

describe("useT (12.15)", () => {
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

	const MANIFEST: Record<string, string> = { greeting: "Hello", count: "{n} items" };
	const OVERRIDES = {
		"es-ES": { greeting: "Hola" },
		de: { greeting: "Hallo", count: "{n} Elemente" },
	};

	it("returns English defaults when the locale has no overlay", () => {
		const rt = fakeRuntime("en");
		let out = "";
		function Probe() {
			const t = useT(MANIFEST, OVERRIDES, rt);
			out = t("greeting");
			return null;
		}
		act(() => root.render(<Probe />));
		expect(out).toBe("Hello");
	});

	it("applies the exact-locale overlay", () => {
		const rt = fakeRuntime("es-ES");
		let out = "";
		function Probe() {
			out = useT(MANIFEST, OVERRIDES, rt)("greeting");
			return null;
		}
		act(() => root.render(<Probe />));
		expect(out).toBe("Hola");
	});

	it("re-derives t() reactively when the locale changes", () => {
		const rt = fakeRuntime("en");
		const greetings: string[] = [];
		function Probe() {
			greetings.push(useT(MANIFEST, OVERRIDES, rt)("greeting"));
			return null;
		}
		act(() => root.render(<Probe />));
		expect(greetings[greetings.length - 1]).toBe("Hello");
		act(() => rt.emit("de"));
		expect(greetings[greetings.length - 1]).toBe("Hallo");
	});

	it("keeps {name} interpolation through the overlay", () => {
		const rt = fakeRuntime("de");
		let out = "";
		function Probe() {
			out = useT(MANIFEST, OVERRIDES, rt)("count", { n: 3 });
			return null;
		}
		act(() => root.render(<Probe />));
		expect(out).toBe("3 Elemente");
	});
});

describe("useLocalePackT (12.15 15c)", () => {
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

	const MANIFEST = { greeting: "Hello", count: "{n} items" };
	type M = typeof MANIFEST;
	const importers: LocalePackImporters<M> = {
		es: async () => ({ default: { greeting: "Hola" } }),
		de: async () => ({ default: { greeting: "Hallo", count: "{n} Elemente" } }),
	};

	/** Flush the async pack import + the state-update re-render. */
	async function flush() {
		await act(async () => {
			await Promise.resolve();
		});
	}

	it("renders English on the first frame, before any pack resolves", () => {
		const rt = fakeRuntime("es");
		let out = "";
		function Probe() {
			out = useLocalePackT(MANIFEST, importers, rt)("greeting");
			return null;
		}
		act(() => root.render(<Probe />));
		expect(out).toBe("Hello");
	});

	it("applies the lazily-loaded overlay once it resolves", async () => {
		const rt = fakeRuntime("es");
		let out = "";
		function Probe() {
			out = useLocalePackT(MANIFEST, importers, rt)("greeting");
			return null;
		}
		act(() => root.render(<Probe />));
		await flush();
		expect(out).toBe("Hola");
	});

	it("re-loads the pack reactively when the locale changes", async () => {
		const rt = fakeRuntime("es");
		let out = "";
		function Probe() {
			out = useLocalePackT(MANIFEST, importers, rt)("greeting");
			return null;
		}
		act(() => root.render(<Probe />));
		await flush();
		expect(out).toBe("Hola");
		act(() => rt.emit("de"));
		await flush();
		expect(out).toBe("Hallo");
	});

	it("stays English for the source language (no pack imported)", async () => {
		const rt = fakeRuntime("en");
		let out = "";
		function Probe() {
			out = useLocalePackT(MANIFEST, importers, rt)("count", { n: 2 });
			return null;
		}
		act(() => root.render(<Probe />));
		await flush();
		expect(out).toBe("2 items");
	});

	it("stays English when no importers are supplied", async () => {
		const rt = fakeRuntime("de");
		let out = "";
		function Probe() {
			out = useLocalePackT(MANIFEST, undefined, rt)("greeting");
			return null;
		}
		act(() => root.render(<Probe />));
		await flush();
		expect(out).toBe("Hello");
	});
});

/** A controllable fake of the runtime's format surface (mirrors what the preload
 *  exposes: a snapshot `format` + an `onFormatChange` the host drives). */
function fakeFormatRuntime(
	initial: FormatContext,
): FormatRuntime & { emit: (format: FormatContext) => void } {
	const listeners = new Set<(format: FormatContext) => void>();
	return {
		format: initial,
		onFormatChange(handler) {
			listeners.add(handler);
			return { unsubscribe: () => listeners.delete(handler) };
		},
		emit(format: FormatContext) {
			for (const fn of listeners) fn(format);
		},
	};
}

describe("useFormatContext / useFormatDate / useFormatNumber (12.15 15f)", () => {
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
		(globalThis as { brainstorm?: unknown }).brainstorm = undefined;
	});

	it("seeds from the runtime's launch format", () => {
		const rt = fakeFormatRuntime({ locale: "de", hour12: false });
		let seen: FormatContext = {};
		function Probe() {
			seen = useFormatContext(rt);
			return null;
		}
		act(() => root.render(<Probe />));
		expect(seen).toEqual({ locale: "de", hour12: false });
	});

	it("re-renders when the runtime emits a new format", () => {
		const rt = fakeFormatRuntime({ locale: "en" });
		let seen: FormatContext = {};
		function Probe() {
			seen = useFormatContext(rt);
			return null;
		}
		act(() => root.render(<Probe />));
		act(() => rt.emit({ locale: "es", timeZone: "Europe/Madrid" }));
		expect(seen).toEqual({ locale: "es", timeZone: "Europe/Madrid" });
	});

	it("falls back to an empty context on a null runtime", () => {
		let seen: FormatContext = { locale: "x" };
		function Probe() {
			seen = useFormatContext(null);
			return null;
		}
		act(() => root.render(<Probe />));
		expect(seen).toEqual({});
	});

	it("useFormatDate formats in the context locale + zone and re-renders on change", () => {
		// 2021-03-05T12:00:00Z — day ≠ month so the locale order is observable;
		// pin the zone so the calendar date is deterministic.
		const epoch = Date.UTC(2021, 2, 5, 12, 0, 0);
		const rt = fakeFormatRuntime({ locale: "en-GB", timeZone: "UTC" });
		let out = "";
		function Probe() {
			out = useFormatDate(rt)(epoch, { year: "numeric", month: "2-digit", day: "2-digit" });
			return null;
		}
		act(() => root.render(<Probe />));
		// en-GB renders day/month/year.
		expect(out).toBe("05/03/2021");
		act(() => rt.emit({ locale: "en-US", timeZone: "UTC" }));
		// en-US renders month/day/year.
		expect(out).toBe("03/05/2021");
	});

	it("useFormatNumber formats in the context locale", () => {
		const rt = fakeFormatRuntime({ locale: "de-DE" });
		let out = "";
		function Probe() {
			out = useFormatNumber(rt)(1234.5);
			return null;
		}
		act(() => root.render(<Probe />));
		// de-DE uses "." for thousands and "," for the decimal.
		expect(out).toBe("1.234,5");
	});
});
