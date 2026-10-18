/**
 * spellcheck-handlers (B11.31) — the dashboard's set-languages path. Electron
 * is mocked; the per-device file lands in a temp userData dir.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();
const state = vi.hoisted(() => ({
	userData: "",
	active: ["en-US"] as string[],
	setLanguages: [] as string[][],
}));

vi.mock("electron", () => {
	const session = {
		availableSpellCheckerLanguages: ["en-US", "de", "fr"],
		setSpellCheckerEnabled: () => {},
		setSpellCheckerLanguages: (langs: string[]) => {
			state.active = langs;
			state.setLanguages.push(langs);
		},
		getSpellCheckerLanguages: () => state.active,
		removeWordFromSpellCheckerDictionary: () => {},
	};
	return {
		app: {
			getPath: () => state.userData,
			getPreferredSystemLanguages: () => ["en-US"],
		},
		session: { defaultSession: session },
		ipcMain: {
			on: () => {},
			handle: (channel: string, fn: IpcHandler) => {
				handlers.set(channel, fn);
			},
		},
	};
});

import {
	SPELLCHECK_LANGUAGES_CHANNEL,
	SPELLCHECK_SET_LANGUAGES_CHANNEL,
	type SpellcheckLanguagesInfo,
	registerSpellcheckHandlers,
	validateLanguageChoice,
} from "./spellcheck-handlers";

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
	Promise.resolve(handlers.get(channel)?.({}, ...args) as T);

describe("validateLanguageChoice", () => {
	const available = ["en-US", "de", "fr"];
	it("accepts null and ordered subsets of what's available", () => {
		expect(validateLanguageChoice(null, available)).toBeNull();
		expect(validateLanguageChoice(["fr", "de"], available)).toEqual(["fr", "de"]);
	});
	it("rejects unknown, duplicate, empty, non-list and oversized input", () => {
		expect(validateLanguageChoice(["xx"], available)).toBeUndefined();
		expect(validateLanguageChoice(["de", "de"], available)).toBeUndefined();
		expect(validateLanguageChoice([], available)).toBeUndefined();
		expect(validateLanguageChoice("de", available)).toBeUndefined();
		expect(validateLanguageChoice(Array(9).fill("de"), available)).toBeUndefined();
	});
});

describe("spellcheck:set-languages", () => {
	beforeEach(async () => {
		state.userData = await mkdtemp(join(tmpdir(), "bs-spell-ipc-"));
		state.active = ["en-US"];
		state.setLanguages = [];
		handlers.clear();
		registerSpellcheckHandlers();
	});
	afterEach(async () => {
		await rm(state.userData, { recursive: true, force: true });
	});

	it("persists the choice per device and applies it to the session", async () => {
		const info = await invoke<SpellcheckLanguagesInfo>(SPELLCHECK_SET_LANGUAGES_CHANNEL, [
			"fr",
			"de",
		]);
		expect(info.chosen).toEqual(["fr", "de"]);
		expect(info.active).toEqual(["fr", "de"]);
		const file = JSON.parse(
			await readFile(join(state.userData, "spellcheck-languages.json"), "utf8"),
		);
		expect(file).toEqual(["fr", "de"]);
		const read = await invoke<SpellcheckLanguagesInfo>(SPELLCHECK_LANGUAGES_CHANNEL);
		expect(read.chosen).toEqual(["fr", "de"]);
	});

	it("ignores an invalid choice and reports the unchanged state", async () => {
		const info = await invoke<SpellcheckLanguagesInfo>(SPELLCHECK_SET_LANGUAGES_CHANNEL, ["xx"]);
		expect(info.active).toEqual(["en-US"]);
		expect(state.setLanguages).toEqual([]);
	});

	it("null goes back to the OS order", async () => {
		await invoke(SPELLCHECK_SET_LANGUAGES_CHANNEL, ["de"]);
		const info = await invoke<SpellcheckLanguagesInfo>(SPELLCHECK_SET_LANGUAGES_CHANNEL, null);
		expect(info.chosen).toBeNull();
		expect(info.active).toEqual(["en-US"]);
	});
});
