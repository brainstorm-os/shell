/**
 * `<AiPanel>` (11.9) — SSR-rendered smoke test. The key + settings state loads
 * in a mount effect (`window.brainstorm.aiSettings`), so static render exercises
 * the idle layout: the section heading, the provider tile grid (one tile per
 * cloud provider), and the always-present routing picker, all resolving through
 * `t()`. The credential field lives in a popover opened on a tile click, and the
 * usage + per-app budget rows are data-driven (rendered only once usage/budgets
 * load), so both are covered by the `ai-settings-store` + handler tests rather
 * than this static render. The set/clear round-trip lives in those tests too.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiPanel } from "./ai-panel";
import { SettingsSection } from "./sections";

describe("AiPanel", () => {
	it("renders a provider tile per cloud provider", () => {
		const html = renderToStaticMarkup(<AiPanel />);
		expect(html).toContain('data-testid="ai-providers"');
		for (const id of ["anthropic", "openai", "glm", "mistral", "gemini"]) {
			expect(html).toContain(`data-testid="ai-provider-${id}"`);
		}
		// Tile face drops the parenthetical so it fits the fixed-width face (F-416);
		// the full "Anthropic (Claude)" name stays on title= (hover) + dialog title.
		expect(html).toMatch(
			/<span class="settings__ai-tile-name">Anthropic<\/span>/,
		);
		expect(html).not.toMatch(
			/<span class="settings__ai-tile-name">Anthropic \(Claude\)<\/span>/,
		);
		expect(html).toContain('title="Anthropic (Claude)"');
		expect(html).toContain("z.ai (GLM)");
		// Strings resolved, not raw t() keys.
		expect(html).not.toContain("shell.settings.ai");
	});

	it("renders the routing picker defaulting to Automatic (11.9)", () => {
		const html = renderToStaticMarkup(<AiPanel />);
		expect(html).toContain('data-testid="ai-routing"');
		expect(html).toContain("Default provider");
		expect(html).toContain("Automatic (local model)");
	});

	it("registers a stable section enum value", () => {
		expect(SettingsSection.Ai).toBe("ai");
	});
});
