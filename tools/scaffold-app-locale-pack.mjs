#!/usr/bin/env node
/**
 * Scaffold 12.15 slice 15d locale-pack adoption for an app with `src/i18n.ts`.
 *
 * Usage:
 *   node tools/scaffold-app-locale-pack.mjs <appId> <CONST> <Prefix> <KeyType>
 *
 * Example:
 *   node tools/scaffold-app-locale-pack.mjs chat CHAT_I18N Chat ChatMessageId
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [appId, constName, prefix, keyType] = process.argv.slice(2);
if (!appId || !constName || !prefix || !keyType) {
	console.error("usage: node tools/scaffold-app-locale-pack.mjs <appId> <CONST> <Prefix> <KeyType>");
	process.exit(1);
}

const appDir = join(ROOT, "apps", appId);
const i18nPath = join(appDir, "src", "i18n.ts");
if (!existsSync(i18nPath)) {
	console.error(`${i18nPath} not found`);
	process.exit(1);
}

const src = readFileSync(i18nPath, "utf8");
const match = src.match(new RegExp(`export const ${constName} = (\\{[\\s\\S]*?\\}) as const`));
if (!match) {
	console.error(`could not find export const ${constName}`);
	process.exit(1);
}

const manifest = Function(`"use strict"; return (${match[1]});`)();
const i18nDir = join(appDir, "src", "i18n");
mkdirSync(i18nDir, { recursive: true });
writeFileSync(join(i18nDir, "en.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const pluralBlock = src.includes("params?: TParams")
	? `export const plural = (
	count: number,
	oneKey: ${keyType},
	otherKey: ${keyType},
	params?: TParams,
): string => sdkPlural(activeT, count, oneKey, otherKey, params);`
	: `export function plural(count: number, one: ${keyType}, other: ${keyType}): string {
	return sdkPlural(activeT, count, one, other);
}`;

const header = src.match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? "";

writeFileSync(
	join(appDir, "src", "i18n.ts"),
	`${header}

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "./i18n/en.json";

export const ${constName} = enCatalog as typeof enCatalog;

export type ${keyType} = keyof typeof ${constName};

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof ${constName}> = {
	es: () => import("./i18n/es.json"),
};

let activeT: TFunction<typeof ${constName}> = createT(${constName});

/** Imperative surfaces read the latest reactive \`t\`. */
export function syncActiveTranslator(next: TFunction<typeof ${constName}>): void {
	activeT = next;
}

export function t(key: ${keyType}, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(${constName});

${pluralBlock}
`,
);

writeFileSync(
	join(appDir, "src", "i18n-hooks.tsx"),
	`import { type TFunction, type TParams, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { ${constName}, type ${keyType}, LOCALE_PACK_IMPORTERS } from "./i18n";

export function use${prefix}T(runtime?: LocaleRuntime | null): TFunction<typeof ${constName}> {
	return useLocalePackT(${constName}, LOCALE_PACK_IMPORTERS, runtime);
}

export function use${prefix}Plural(runtime?: LocaleRuntime | null) {
	const translate = use${prefix}T(runtime);
	return (
		count: number,
		oneKey: ${keyType},
		otherKey: ${keyType},
		params?: TParams,
	): string => sdkPlural(translate, count, oneKey, otherKey, params);
}
`,
);

writeFileSync(
	join(appDir, "src", "i18n-provider.tsx"),
	`import { type ReactElement, type ReactNode, useEffect } from "react";
import { syncActiveTranslator } from "./i18n";
import { use${prefix}T } from "./i18n-hooks";

export function ${prefix}I18nProvider({ children }: { children: ReactNode }): ReactElement {
	const t = use${prefix}T();
	useEffect(() => {
		syncActiveTranslator(t);
	}, [t]);
	return <>{children}</>;
}
`,
);

const sampleKey = Object.keys(manifest)[0];
const sampleKey2 = Object.keys(manifest)[1] ?? sampleKey;
writeFileSync(
	join(appDir, "src", "i18n-locale.test.tsx"),
	`/**
 * @vitest-environment jsdom
 */
import { type LocaleRuntime, useLocalePackT } from "@brainstorm-os/sdk/i18n-react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ${constName} } from "./i18n";

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

describe("${appId} locale packs (12.15)", () => {
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
		es: async () => ({
			default: { "${sampleKey}": "ES:${manifest[sampleKey]}", "${sampleKey2}": "ES:${manifest[sampleKey2]}" },
		}),
	};

	it("applies the Spanish overlay once the pack resolves", async () => {
		const rt = fakeRuntime("es");
		let out = "";
		function Probe() {
			out = useLocalePackT(${constName}, importers, rt)("${sampleKey}");
			return null;
		}
		act(() => root.render(<Probe />));
		await flush();
		expect(out).toBe("ES:${manifest[sampleKey]}");
	});

	it("re-derives when the runtime locale changes", async () => {
		const rt = fakeRuntime("en");
		let out = "";
		function Probe() {
			out = useLocalePackT(${constName}, importers, rt)("${sampleKey2}");
			return null;
		}
		act(() => root.render(<Probe />));
		expect(out).toBe(${JSON.stringify(manifest[sampleKey2])});
		await act(async () => {
			rt.emit("es");
			await Promise.resolve();
		});
		await flush();
		expect(out).toBe("ES:${manifest[sampleKey2]}");
	});
});
`,
);

const manifestPath = join(appDir, "manifest.json");
const manifestJson = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!manifestJson.i18n) {
	manifestJson.i18n = { source: "en", locales: ["en", "es"] };
	manifestJson.i18n = { source: "en", locales: ["en", "es"] };
	writeFileSync(manifestPath, `${JSON.stringify(manifestJson, null, 2)}\n`);
}

console.log(`scaffolded ${appId}: ${Object.keys(manifest).length} keys in src/i18n/en.json`);
