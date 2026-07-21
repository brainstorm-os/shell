/**
 * @vitest-environment jsdom
 *
 * B9.3 Journal half — the wiring contract: the shared find controller
 * over `createDomTextSearchProvider` scoped to Journal's
 * `.journal__entry-body` (the rendered, read-only day projection). Proves
 * the selector target + find-only behaviour on Journal-shaped DOM without
 * importing the side-effectful `app.ts` (its module body calls
 * `bootstrap()`); the bar/chords themselves are covered by the SDK suite.
 */

import { createDomTextSearchProvider, createFindController } from "@brainstorm-os/sdk/find-replace";
import { beforeEach, describe, expect, it } from "vitest";

function mountJournal(bodyHtml: string): HTMLElement {
	document.body.innerHTML = `
		<div id="journal-root">
			<section class="journal__day">
				<div class="journal__entry-body">${bodyHtml}</div>
			</section>
		</div>`;
	return document.getElementById("journal-root") as HTMLElement;
}

describe("Journal find wiring (B9.3)", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("finds + reveals matches inside the entry body, scoped to it", () => {
		const root = mountJournal(
			'<p>Met Sam about the <strong>roadmap</strong>.</p><p class="journal__entry-meta">edited 2026-05-19</p>',
		);
		const provider = createDomTextSearchProvider(() =>
			root.querySelector<HTMLElement>(".journal__entry-body"),
		);
		const find = createFindController(provider, { persist: { key: "journal:find" } });

		find.open();
		find.setTerm("roadmap");
		expect(find.getState().matchCount).toBe(1);

		find.next();
		const mark = root.querySelector("mark[data-bs-find]");
		expect(mark?.textContent).toBe("roadmap");
		// the highlight lands inside the entry body, not the toolbar/header
		expect(mark?.closest(".journal__entry-body")).not.toBeNull();
	});

	it("closing clears the highlight (host wires close → provider.clear)", () => {
		const root = mountJournal("<p>alpha beta alpha</p>");
		const provider = createDomTextSearchProvider(() =>
			root.querySelector<HTMLElement>(".journal__entry-body"),
		);
		const find = createFindController(provider, { persist: { key: "journal:find" } });
		// the exact subscription setupFind() installs
		find.subscribe(() => {
			if (!find.getState().open) provider.clear();
		});

		find.open();
		find.setTerm("alpha");
		find.next();
		expect(root.querySelector("mark[data-bs-find]")).not.toBeNull();

		find.close();
		expect(root.querySelector("mark[data-bs-find]")).toBeNull();
		expect(root.querySelector(".journal__entry-body")?.textContent).toBe("alpha beta alpha");
	});

	it("is find-only (the day body is read-only — edits route to Notes)", () => {
		const root = mountJournal("<p>immutable journal text</p>");
		const provider = createDomTextSearchProvider(() =>
			root.querySelector<HTMLElement>(".journal__entry-body"),
		);
		expect(provider.selectionRange).toBeNull();
		const find = createFindController(provider, { persist: { key: "journal:find" } });
		find.open();
		find.setTerm("journal");
		expect(find.replaceAll("X")).toBe(0);
		expect(root.querySelector(".journal__entry-body")?.textContent).toBe("immutable journal text");
	});
});
