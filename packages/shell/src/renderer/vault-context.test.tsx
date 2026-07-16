/**
 * @vitest-environment jsdom
 *
 * `<VaultProvider>` — pins the fix for the stale-theme-on-vault-switch bug
 * (new-vault-onboarding e2e "switching vaults repaints"): a vault switch the
 * renderer did NOT initiate (a main-side activation, or a vault created/opened
 * through the raw preload bridge instead of the React methods) must still
 * refresh `current`, because the theme provider's `!hasVault` gate and the
 * welcome/dashboard routing both read it. Without the `vaults:active-changed`
 * subscription `current` only ever updated on mount + the React callbacks, so a
 * raw-IPC switch left the dashboard pinned to the welcome-screen Midnight.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultEntry } from "../preload";
import { VaultProvider, useVault, useVaultMaybe } from "./vault-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALPHA: VaultEntry = { id: "alpha", name: "Alpha", path: "/a" } as VaultEntry;

let container: HTMLDivElement;
let root: Root;
let activeVault: VaultEntry | null;
let activeChangedListener: (() => void) | undefined;

beforeEach(() => {
	activeVault = null;
	activeChangedListener = undefined;
	const vaults = {
		list: vi.fn(async () => (activeVault ? [activeVault] : [])),
		current: vi.fn(async () => activeVault),
		session: vi.fn(async () => (activeVault ? { vaultId: activeVault.id } : null)),
		onActiveChanged: vi.fn((listener: () => void) => {
			activeChangedListener = listener;
			return () => {
				activeChangedListener = undefined;
			};
		}),
	};
	(globalThis as unknown as { window: { brainstorm: unknown } }).window.brainstorm = { vaults };
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function Probe() {
	const { current } = useVault();
	return <span data-testid="current">{current?.id ?? "none"}</span>;
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("<VaultProvider>", () => {
	it("subscribes to vaults:active-changed", async () => {
		await act(async () => {
			root.render(
				<VaultProvider>
					<Probe />
				</VaultProvider>,
			);
		});
		await flush();
		expect(activeChangedListener).toBeTypeOf("function");
	});

	it("refreshes `current` when a vault is switched without a React call", async () => {
		await act(async () => {
			root.render(
				<VaultProvider>
					<Probe />
				</VaultProvider>,
			);
		});
		await flush();
		// Mount refresh saw no active vault.
		expect(container.querySelector('[data-testid="current"]')?.textContent).toBe("none");

		// A main-side / raw-IPC switch: the session becomes live, then the push
		// fires — exactly the path the e2e exercises (it bypasses VaultProvider's
		// own create()).
		activeVault = ALPHA;
		await act(async () => {
			activeChangedListener?.();
		});
		await flush();

		expect(container.querySelector('[data-testid="current"]')?.textContent).toBe("alpha");
	});
});

describe("useVaultMaybe", () => {
	/** Pins the ThemeProvider crash fix: chrome using the tolerant hook renders
	 *  (with null) outside the provider instead of throwing and taking the whole
	 *  shell down to the error boundary. */
	it("returns null outside <VaultProvider> without throwing", async () => {
		function MaybeProbe() {
			const vault = useVaultMaybe();
			return <span data-testid="maybe">{vault === null ? "null" : "value"}</span>;
		}
		await act(async () => {
			root.render(<MaybeProbe />);
		});
		expect(container.querySelector('[data-testid="maybe"]')?.textContent).toBe("null");
	});
});
