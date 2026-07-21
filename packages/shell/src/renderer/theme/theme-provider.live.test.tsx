// @vitest-environment jsdom
/**
 * Live-reactivity guard for the shell theme. Reproduces the dogfood report
 * "light/dark works in the apps and gets saved, but the shell doesn't change
 * immediately": drives the REAL <ThemeProvider> against a mock
 * `window.brainstorm.dashboard` and asserts `document.documentElement.dataset.theme`
 * follows both delivery paths without a remount —
 *   1. the snapshot stream (`on`) — appearance mode flips, and
 *   2. the synchronous fast-path push (`onTheme`), the fix for the shell lag.
 */

import { AppearanceMode, type AppearanceState } from "@brainstorm-os/protocol/appearance";
import { ThemeName } from "@brainstorm-os/tokens";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "./theme-provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// hasVault=true so effectiveTheme resolves from appearance, not the welcome pin.
vi.mock("../vault-context", () => ({
	useVaultMaybe: () => ({ current: { id: "v1", name: "V", path: "/v" } }),
}));

type Listener<T> = (value: T) => void;

function appearance(mode: AppearanceMode, light: ThemeName, dark: ThemeName): AppearanceState {
	const wp = { kind: "solid" as const, value: "#000" };
	return { mode, light: { theme: light, wallpaper: wp }, dark: { theme: dark, wallpaper: wp } };
}

function makeDashboardMock() {
	let appearanceState = appearance(AppearanceMode.Light, ThemeName.Sepia, ThemeName.Midnight);
	let snapListener: Listener<unknown> | null = null;
	let themeListener: Listener<ThemeName> | null = null;
	const snap = () => ({ appearance: appearanceState });
	return {
		setMode(mode: AppearanceMode) {
			appearanceState = { ...appearanceState, mode };
			snapListener?.(snap());
		},
		pushTheme(theme: ThemeName) {
			themeListener?.(theme);
		},
		snapshot: vi.fn(() => Promise.resolve(snap())),
		on: vi.fn((l: Listener<unknown>) => {
			snapListener = l;
			return () => {
				snapListener = null;
			};
		}),
		onTheme: vi.fn((l: Listener<ThemeName>) => {
			themeListener = l;
			return () => {
				themeListener = null;
			};
		}),
	};
}

describe("ThemeProvider — live shell repaint on a light/dark toggle", () => {
	let host: HTMLDivElement;
	let root: Root;
	let dashboard: ReturnType<typeof makeDashboardMock>;

	beforeEach(async () => {
		dashboard = makeDashboardMock();
		(window as unknown as { brainstorm: unknown }).brainstorm = { dashboard, vaults: {} };
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root.render(
				<ThemeProvider>
					<div />
				</ThemeProvider>,
			);
		});
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	it("starts on the Light slot's theme", () => {
		expect(document.documentElement.dataset.theme).toBe(ThemeName.Sepia);
	});

	it("flips when the enriched snapshot arrives with the new mode", async () => {
		await act(async () => {
			dashboard.setMode(AppearanceMode.Dark);
		});
		expect(document.documentElement.dataset.theme).toBe(ThemeName.Midnight);
	});

	it("flips on the synchronous fast-path push before any snapshot (the shell-lag fix)", async () => {
		expect(document.documentElement.dataset.theme).toBe(ThemeName.Sepia);
		// The main process pushes the resolved theme on `app:theme-changed` the
		// instant the toggle commits — the shell must repaint now, not wait on the
		// entity-pin-enriched snapshot.
		await act(async () => {
			dashboard.pushTheme(ThemeName.Midnight);
		});
		expect(document.documentElement.dataset.theme).toBe(ThemeName.Midnight);
	});
});
