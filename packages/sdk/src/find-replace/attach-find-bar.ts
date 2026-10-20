/**
 * `attachFindBar` — the pure-DOM twin of `<FindBar>` (Journal and any
 * non-React text app), the `createNavButtons` precedent: builds the SAME
 * markup, drives the SAME controller, subscribes for live state. Returns
 * a disposer that unsubscribes and removes the bar.
 */

import { DEFAULT_FIND_LABELS, type FindLabels } from "../i18n/common-labels";
import { type FindController, FindStatus } from "./find-controller";
import { findCounterText } from "./find-counter";

export type AttachFindBarOptions = {
	mode?: "find" | "find-replace";
	labels?: Partial<FindLabels>;
	className?: string;
};

const OPTION_KEYS = [
	["caseSensitive", "Aa"],
	["wholeWord", "Ab"],
	["regex", ".*"],
	["inSelection", "Sel"],
] as const;

export function attachFindBar(
	host: HTMLElement,
	controller: FindController,
	options: AttachFindBarOptions = {},
): () => void {
	const labels: FindLabels = { ...DEFAULT_FIND_LABELS, ...options.labels };
	const mode = options.mode ?? "find";

	const root = document.createElement("div");
	root.className = options.className ? `bs-find-bar ${options.className}` : "bs-find-bar";
	root.setAttribute("role", "search");
	root.setAttribute("aria-label", labels.region);

	const term = document.createElement("input");
	term.type = "text";
	term.className = "bs-find-bar__input";
	term.dataset.testid = "find-term";
	term.setAttribute("aria-label", labels.term);
	term.placeholder = labels.term;
	term.addEventListener("input", () => controller.setTerm(term.value));
	term.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			e.shiftKey ? controller.previous() : controller.next();
		} else if (e.key === "Escape") {
			e.preventDefault();
			controller.close();
		}
	});

	const count = document.createElement("span");
	count.className = "bs-find-bar__count";
	count.dataset.testid = "find-count";
	count.setAttribute("aria-live", "polite");

	const btn = (testid: string, label: string, glyph: string, onClick: () => void) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "bs-find-bar__btn";
		b.dataset.testid = testid;
		b.setAttribute("aria-label", label);
		b.dataset.bsTooltip = label;
		b.textContent = glyph;
		b.addEventListener("click", onClick);
		return b;
	};
	const prev = btn("find-prev", labels.previous, "‹", () => controller.previous());
	const next = btn("find-next", labels.next, "›", () => controller.next());
	const close = btn("find-close", labels.close, "✕", () => controller.close());

	const toggles = OPTION_KEYS.map(([key, marker]) => {
		const t = document.createElement("button");
		t.type = "button";
		t.className = "bs-find-bar__toggle";
		t.dataset.testid = `find-opt-${key}`;
		t.setAttribute("aria-label", labels[key]);
		t.title = labels[key];
		t.textContent = marker;
		t.addEventListener("click", () =>
			controller.setOptions({ [key]: !controller.getState().options[key] }),
		);
		return [key, t] as const;
	});

	const row = document.createElement("div");
	row.className = "bs-find-bar__row";
	row.append(term, count, prev, next, ...toggles.map(([, el]) => el), close);
	root.append(row);

	let replacement = "";
	let replaceBtns: HTMLButtonElement[] = [];
	if (mode === "find-replace") {
		const rrow = document.createElement("div");
		rrow.className = "bs-find-bar__row bs-find-bar__row--replace";
		const rin = document.createElement("input");
		rin.type = "text";
		rin.className = "bs-find-bar__input";
		rin.dataset.testid = "find-replacement";
		rin.setAttribute("aria-label", labels.replacement);
		rin.placeholder = labels.replacement;
		rin.addEventListener("input", () => {
			replacement = rin.value;
		});
		const rep = document.createElement("button");
		rep.type = "button";
		rep.className = "bs-find-bar__action";
		rep.dataset.testid = "find-replace";
		rep.textContent = labels.replace;
		rep.addEventListener("click", () => controller.replace(replacement));
		const repAll = document.createElement("button");
		repAll.type = "button";
		repAll.className = "bs-find-bar__action";
		repAll.dataset.testid = "find-replace-all";
		repAll.textContent = labels.replaceAll;
		repAll.addEventListener("click", () => controller.replaceAll(replacement));
		replaceBtns = [rep, repAll];
		rrow.append(rin, rep, repAll);
		root.append(rrow);
	}

	let mounted = false;
	const sync = (): void => {
		const s = controller.getState();
		let opened = false;
		if (s.open && !mounted) {
			host.append(root);
			mounted = true;
			term.focus();
			opened = true;
		} else if (!s.open && mounted) {
			root.remove();
			mounted = false;
			return;
		}
		if (!mounted) return;
		if (term.value !== s.term) term.value = s.term;
		// A reopen retains the previous term — select it (after the value
		// sync above) so typing replaces it while bare Enter reuses it
		// (the standard editor/browser find behavior — F-214).
		if (opened) term.select();
		count.textContent = findCounterText(s, labels);
		const invalid = s.status === FindStatus.InvalidPattern;
		if (invalid) term.setAttribute("aria-invalid", "true");
		else term.removeAttribute("aria-invalid");
		count.toggleAttribute("data-invalid", invalid);
		const hasMatches = s.matchCount > 0;
		prev.disabled = !hasMatches;
		next.disabled = !hasMatches;
		for (const b of replaceBtns) b.disabled = !hasMatches;
		for (const [key, el] of toggles) {
			el.setAttribute("aria-pressed", String(s.options[key]));
		}
	};

	sync();
	const unsubscribe = controller.subscribe(sync);
	return () => {
		unsubscribe();
		root.remove();
	};
}
