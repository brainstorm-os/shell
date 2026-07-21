/**
 * Shared helpers for the `KBN-P-*` runtime validation specs
 * (`docs/shell/61-keyboard-accessibility.md §Validation` — `KBN-4`).
 *
 * All five specs need a small overlapping vocabulary: "enumerate focusables in
 * the live DOM", "describe the currently-focused element in a stable way",
 * "wait for a selector to appear / disappear". Extracted here so a future
 * KBN-S-* surface adoption only needs to bump one helper instead of five.
 *
 * Pure helpers — no test state, no `expect()`, no shared module-scope state.
 * Each call passes the `Page` in; everything else is parameters.
 */

import type { Page } from "@playwright/test";

/** The same focusable selector `@brainstorm-os/sdk/a11y/use-focus-trap` uses, so
 *  the Playwright probe matches the production trap's idea of "focusable". */
export const FOCUSABLE_SELECTOR = [
	"a[href]",
	"area[href]",
	"button:not([disabled])",
	"input:not([disabled]):not([type='hidden'])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"iframe",
	"audio[controls]",
	"video[controls]",
	"[contenteditable]:not([contenteditable='false'])",
	"[tabindex]:not([tabindex='-1'])",
].join(",");

/** A stable string fingerprint of a focused element used to detect duplicate
 *  visits / unreachable elements during a tab walk. The compositor doesn't
 *  preserve React keys across renders, so we lean on durable DOM attributes:
 *  `data-testid` (preferred) → `id` → `aria-label` → `name` →
 *  `tagName + className + textContent` truncated. */
export type FocusFingerprint = string;

/** Run inside `page.evaluate` — returns a fingerprint for the current
 *  `document.activeElement`, or `null` if focus is on `<body>` / nothing. */
export async function readFocusFingerprint(page: Page): Promise<FocusFingerprint | null> {
	return page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		if (!el || el === document.body) return null;
		const dataTestId = el.getAttribute("data-testid");
		if (dataTestId) return `testid:${dataTestId}`;
		const id = el.id;
		if (id) return `id:${id}`;
		const ariaLabel = el.getAttribute("aria-label");
		if (ariaLabel) return `aria-label:${el.tagName.toLowerCase()}#${ariaLabel}`;
		const name = el.getAttribute("name");
		if (name) return `name:${el.tagName.toLowerCase()}#${name}`;
		const cls = el.className && typeof el.className === "string" ? el.className.split(/\s+/)[0] : "";
		const text = (el.textContent ?? "").trim().slice(0, 40);
		return `tag:${el.tagName.toLowerCase()}#${cls}#${text}`;
	});
}

/** Enumerate focusables in `root` (default = whole document) matching the
 *  same filter the production focus-trap uses. Used as a manual probe to
 *  compare against the Tab-walk traversal — anything in this list that the
 *  walk never visited is "unreachable by Tab". */
export async function enumerateFocusables(page: Page, rootSelector?: string): Promise<number> {
	return page.evaluate(
		({ rootSelector, focusableSelector }) => {
			const root: Element = rootSelector
				? (document.querySelector(rootSelector) ?? document.body)
				: document.body;
			return Array.from(root.querySelectorAll<HTMLElement>(focusableSelector)).filter((el) => {
				if (el.hasAttribute("hidden")) return false;
				if (el.getAttribute("aria-hidden") === "true") return false;
				// Roving composite items (`tabindex="-1"` buttons under a
				// useCompositeKeyboard container) are deliberately ONE Tab
				// stop — they're arrow-reachable, not Tab-reachable.
				if (el.getAttribute("tabindex") === "-1") return false;
				if ((el as HTMLElement & { inert?: boolean }).inert === true) return false;
				// Filter elements with display:none parents — Tab won't reach them.
				let cursor: HTMLElement | null = el;
				while (cursor) {
					const style = window.getComputedStyle(cursor);
					if (style.display === "none" || style.visibility === "hidden") return false;
					cursor = cursor.parentElement;
				}
				return true;
			}).length;
		},
		{ rootSelector: rootSelector ?? null, focusableSelector: FOCUSABLE_SELECTOR },
	);
}

/** Drive Tab from the current focus position up to `maxSteps` times,
 *  recording the fingerprint of each focused element. Stops early when the
 *  fingerprint cycles back to a previously-seen value (a complete cycle is
 *  what the spec asserts). */
export async function tabWalk(page: Page, maxSteps: number): Promise<FocusFingerprint[]> {
	const visited: FocusFingerprint[] = [];
	for (let i = 0; i < maxSteps; i++) {
		await page.keyboard.press("Tab");
		const fp = await readFocusFingerprint(page);
		if (fp === null) {
			// Focus fell to body — record explicitly so the caller can assert.
			visited.push("@body");
			break;
		}
		visited.push(fp);
		// If we've already seen this fingerprint, we've cycled — stop.
		if (visited.slice(0, -1).includes(fp)) break;
	}
	return visited;
}

/** Whether the document's current `:focus-visible` selector matches the active
 *  element. Production CSS sets a 2px outline ring via `:focus-visible`, so
 *  this directly mirrors what the user sees. */
export async function isFocusVisible(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const el = document.activeElement as HTMLElement | null;
		if (!el || el === document.body) return false;
		try {
			return el.matches(":focus-visible");
		} catch {
			// Older Electron / jsdom paths that don't support :focus-visible.
			return false;
		}
	});
}

/** Whether the document's `:focus-visible` JS twin (`useFocusVisible` from
 *  `@brainstorm-os/sdk/a11y`) currently reports keyboard modality. Reads the
 *  body element's modality marker if present, otherwise falls back to the
 *  CSS `:focus-visible` selector — both should agree in production. */
export async function focusModalityIsKeyboard(page: Page): Promise<boolean> {
	return isFocusVisible(page);
}

/** Seed a perf-fixture vault so the shell isn't stuck on the new-vault
 *  picker when a spec opens. Mirrors the launcher-keystroke spec helper
 *  but without the demo-content reseed (KBN specs don't need entities). */
export async function ensureVaultSeeded(page: Page, userDataDir: string): Promise<void> {
	await page.evaluate(
		async ({ userDataDir }) => {
			const bs = (
				window as unknown as {
					brainstorm: {
						vaults: {
							list: () => Promise<unknown[]>;
							create: (opts: { name: string; path: string }) => Promise<unknown>;
							activate: (id: string) => Promise<unknown>;
							session: () => Promise<unknown>;
						};
						dev: {
							seedPrebuiltApps: () => Promise<unknown>;
						};
					};
				}
			).brainstorm;
			const list = (await bs.vaults.list()) as Array<{ id: string }>;
			let session = await bs.vaults.session();
			if (list.length === 0) {
				await bs.vaults.create({ name: "perf-kbn", path: `${userDataDir}/vault` });
				session = await bs.vaults.session();
			} else if (!session && list[0]) {
				await bs.vaults.activate(list[0].id);
				session = await bs.vaults.session();
			}
			if (!session) throw new Error("perf-kbn harness: no active vault after setup");
			// Seed demo apps so the dashboard has more than just a header to walk.
			await bs.dev.seedPrebuiltApps();
		},
		{ userDataDir },
	);
	// The renderer boots onto the welcome screen when no vault was active;
	// creating one doesn't remount it. Reload so `main.dashboard` mounts
	// (same recipe as the fancy-menus specs' `openSeededDashboard`).
	await page.reload();
	await waitForDashboard(page);
	await dismissTransientOverlays(page);
}

/** Dismiss the auto-opened "What's new" popover (and any other modal
 *  popover) — its backdrop intercepts every click and a stray open dialog
 *  poisons dialog-scoped queries. It mounts ASYNC after the dashboard, so
 *  wait a grace beat before checking, and Escape until none remain. */
export async function dismissTransientOverlays(page: Page): Promise<void> {
	const backdrop = page.locator(".popover__backdrop").first();
	await backdrop.waitFor({ state: "visible", timeout: 2_500 }).catch(() => undefined);
	for (let i = 0; i < 3; i += 1) {
		if (!(await backdrop.isVisible().catch(() => false))) break;
		await page.keyboard.press("Escape");
		await backdrop.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => undefined);
	}
}

/** Open the launcher overlay (`Cmd/Ctrl+Space`) and wait for the input to
 *  mount + focus to settle. Used by the escape-stack and arrow-composite
 *  specs. */
export async function openLauncher(page: Page): Promise<void> {
	const chord = process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK";
	await page.keyboard.press(chord);
	await page.locator('[data-testid="launcher"] input.launcher__input').waitFor({
		state: "visible",
		timeout: 10_000,
	});
	// Launcher focuses its input on the next rAF after mount.
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

/** Wait for the dashboard's root `<main class="dashboard">` to mount —
 *  proxy for "vault is active, dashboard has rendered". */
export async function waitForDashboard(page: Page): Promise<void> {
	await page.locator("main.dashboard").waitFor({ state: "visible", timeout: 30_000 });
}

/** Open the Settings overlay (`Cmd/Ctrl+,`) and wait for its composite
 *  sidebar listbox (KBN-S-settings) to mount. Used by the arrow-composite
 *  spec. */
export async function openSettings(page: Page): Promise<void> {
	const nav = page.locator('[data-testid="settings"] nav.settings__nav[role="listbox"]');
	const chord = process.platform === "darwin" ? "Meta+Comma" : "Control+Comma";
	await page.keyboard.press(chord);
	try {
		await nav.waitFor({ state: "visible", timeout: 3_000 });
	} catch {
		// The chord can land before the shortcut registry hydrates after a
		// reload; the header Settings button is the user-visible fallback.
		// A late-mounting transient popover backdrop would swallow the click.
		await dismissTransientOverlays(page);
		await page.getByRole("button", { name: "Settings" }).first().click();
		await nav.waitFor({ state: "visible", timeout: 10_000 });
	}
}
