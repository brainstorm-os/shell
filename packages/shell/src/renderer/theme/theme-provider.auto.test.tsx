// @vitest-environment jsdom
/**
 * F-495 — the torn shell on the AUTO path.
 *
 * Probe 940 measured it against the real hidden shell, 3 runs of 3: with
 * `mode=auto` and main reporting `nativeTheme.shouldUseDarkColors=true`, every
 * app window and tab strip went dark while the DASHBOARD stayed light —
 * `rgb(247,247,247)`, `[data-theme=default-light]` — and never converged across
 * a 10s poll. 20 of the 24 stale surfaces were the dashboard and its widget
 * iframes (the widgets re-push from a MutationObserver on `:root[data-theme]`,
 * which never changed).
 *
 * The cause is TWO AUTHORITIES for one decision. Main resolves the Auto slot
 * from `nativeTheme.shouldUseDarkColors`; the dashboard renderer resolved it
 * from its OWN `matchMedia("(prefers-color-scheme: dark)")`. Probe 940 caught
 * them disagreeing in the live shell — `renderer matchMedia dark=false` in the
 * same breath as `main shouldUseDarkColors=true`, and again while the dashboard
 * was painted `[data-theme=default-dark]`. While they disagree the dashboard
 * paints the wrong slot, and main's push is diffed away as redundant (it only
 * broadcasts when the EFFECTIVE theme changes), so nothing ever corrects it —
 * a torn state, not a lagging one.
 *
 * These cases pin the fix: the renderer resolves Auto from the reading main put
 * IN THE SNAPSHOT, so there is one authority. `matchMedia` survives only as the
 * pre-first-snapshot fallback.
 *
 * Every case here keeps `matchMedia` pinned to LIGHT — the state the real shell
 * was measured in — so a test that passes by accident (because jsdom happens to
 * agree) is impossible.
 */

import { AppearanceMode, type AppearanceState } from "@brainstorm-os/protocol/appearance";
import { ThemeName } from "@brainstorm-os/tokens";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "./theme-provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../vault-context", () => ({
	useVaultMaybe: () => ({ current: { id: "v1", name: "V", path: "/v" } }),
}));

type Listener<T> = (value: T) => void;

function appearance(mode: AppearanceMode): AppearanceState {
	const wp = { kind: "solid" as const, value: "#000" };
	return {
		mode,
		light: { theme: ThemeName.DefaultLight, wallpaper: wp },
		dark: { theme: ThemeName.DefaultDark, wallpaper: wp },
	};
}

/** jsdom has no `matchMedia`; the shell's watcher then reads `false` (light).
 *  Install an explicit stub so the reading is a deliberate part of the case
 *  rather than an absence, and so a listener can be fired if a case needs it. */
function stubMatchMedia(prefersDark: boolean) {
	const listeners = new Set<(e: MediaQueryListEvent) => void>();
	window.matchMedia = ((query: string) => ({
		matches: query.includes("dark") ? prefersDark : !prefersDark,
		media: query,
		addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
		removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
	})) as unknown as typeof window.matchMedia;
	return listeners;
}

/** A `window.brainstorm.dashboard` that behaves like the real bridge: the
 *  snapshot stream carries main's OS reading, and `onTheme` is the separate
 *  synchronous fast path. Cases drive them independently, because in the
 *  measured failure the fast path was diffed away and only the snapshot
 *  arrived. */
function makeDashboardMock(systemPrefersDark: boolean | undefined) {
	let state = appearance(AppearanceMode.Light);
	let osDark = systemPrefersDark;
	let snapListener: Listener<unknown> | null = null;
	let themeListener: Listener<ThemeName> | null = null;
	const snap = () =>
		osDark === undefined ? { appearance: state } : { appearance: state, systemPrefersDark: osDark };
	return {
		/** Push a snapshot the way main does on every `nativeTheme.updated` —
		 *  WITHOUT the `app:theme-changed` fast path, which main suppresses when
		 *  the effective theme it computed did not change. */
		push(next: { mode?: AppearanceMode; systemPrefersDark?: boolean }) {
			if (next.mode) state = { ...state, mode: next.mode };
			if (next.systemPrefersDark !== undefined) osDark = next.systemPrefersDark;
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

describe("ThemeProvider — mode=auto follows MAIN's OS reading, not the renderer's", () => {
	let host: HTMLDivElement;
	let root: Root;
	let dashboard: ReturnType<typeof makeDashboardMock>;

	const mount = async (systemPrefersDark: boolean | undefined) => {
		dashboard = makeDashboardMock(systemPrefersDark);
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
	};

	beforeEach(() => {
		stubMatchMedia(false);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	it("paints the DARK slot when main says the OS is dark and the renderer's matchMedia says light", async () => {
		await mount(false);
		expect(document.documentElement.dataset.theme).toBe(ThemeName.DefaultLight);

		// The exact measured state: mode=auto, main `shouldUseDarkColors=true`,
		// renderer `matchMedia(prefers-color-scheme: dark) = false`. Main pushes
		// only the snapshot — this is the case where its fast-path broadcast was
		// diffed away, and the dashboard was left painting light forever.
		await act(async () => {
			dashboard.push({ mode: AppearanceMode.Auto, systemPrefersDark: true });
		});
		expect(document.documentElement.dataset.theme).toBe(ThemeName.DefaultDark);
	});

	it("follows a later OS flip back to light without any fast-path push", async () => {
		await mount(true);
		await act(async () => {
			dashboard.push({ mode: AppearanceMode.Auto, systemPrefersDark: true });
		});
		expect(document.documentElement.dataset.theme).toBe(ThemeName.DefaultDark);
		await act(async () => {
			dashboard.push({ systemPrefersDark: false });
		});
		expect(document.documentElement.dataset.theme).toBe(ThemeName.DefaultLight);
	});

	it("does not revert a fast-path push when the snapshot that follows says the same thing", async () => {
		// The two deliveries must AGREE. Before the fix they could not: the push
		// carried main's reading and the snapshot-derived render carried the
		// renderer's, so whichever landed last won.
		await mount(false);
		await act(async () => {
			dashboard.push({ mode: AppearanceMode.Auto, systemPrefersDark: true });
			dashboard.pushTheme(ThemeName.DefaultDark);
		});
		await act(async () => {
			dashboard.push({ systemPrefersDark: true });
		});
		expect(document.documentElement.dataset.theme).toBe(ThemeName.DefaultDark);
	});

	it("moves `:root[data-theme]`, which is what the widget iframes are driven off", async () => {
		// The 8 stale widget iframes in probe 940 were a CONSEQUENCE, not a second
		// bug: `widgets-layer` re-pushes theme CSS from a MutationObserver with
		// exactly this filter, and reads the theme back out of `dataset.theme`.
		// While the dashboard never moved that attribute the widgets could not
		// follow. Pin the coupling rather than assume it.
		await mount(false);
		const seen: string[] = [];
		const observer = new MutationObserver(() => {
			seen.push(document.documentElement.dataset.theme ?? "(unset)");
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
		await act(async () => {
			dashboard.push({ mode: AppearanceMode.Auto, systemPrefersDark: true });
		});
		observer.disconnect();
		expect(seen).toContain(ThemeName.DefaultDark);
	});

	it("falls back to matchMedia only while main has sent no reading (pre-first-snapshot / older main)", async () => {
		stubMatchMedia(true);
		await mount(undefined);
		await act(async () => {
			dashboard.push({ mode: AppearanceMode.Auto });
		});
		expect(document.documentElement.dataset.theme).toBe(ThemeName.DefaultDark);
	});
});
