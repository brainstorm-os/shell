/**
 * Diagnostics problem list (9.7.6). Renders the built-in linter's findings
 * for the open file as a compact list in the inspector. Display-first: each
 * row shows severity · line · message; activating a row asks the host to
 * reveal that line. Pure DOM builder (no app state) so it's jsdom-testable.
 *
 * The list is a long-lived handle that RECONCILES in place rather than a
 * one-shot builder: it owns its element across updates and only writes the
 * fields that actually changed. Rebuilding the subtree per update tore down
 * and re-created every row on every keystroke, which is what the inspector's
 * blink was made of at the paint level. A row whose data is unchanged is not
 * touched at all.
 */

import {
	type Diagnostic,
	DiagnosticCode,
	DiagnosticSeverity,
	countBySeverity,
} from "../logic/diagnostics";

/** Catalog key per diagnostic kind. The message text lives in the i18n
 *  manifest (localised, `{ch}`-interpolated) — never baked at construction. */
const MESSAGE_KEY: Record<DiagnosticCode, string> = {
	[DiagnosticCode.TrailingWhitespace]: "diagnostics.msg.trailingWhitespace",
	[DiagnosticCode.MixedIndent]: "diagnostics.msg.mixedIndent",
	[DiagnosticCode.UnmatchedBracket]: "diagnostics.msg.unmatchedBracket",
	[DiagnosticCode.UnclosedBracket]: "diagnostics.msg.unclosedBracket",
};

function diagnosticMessage(
	d: Diagnostic,
	t: (key: string, params?: Record<string, string>) => string,
): string {
	return t(MESSAGE_KEY[d.code], d.params);
}

/** The app's `plural` helper, widened to the generic key domain this pure
 *  builder speaks. Count selection lives in `@brainstorm-os/sdk/i18n` — never
 *  here, and never as a `count === 1` branch in component code. */
export type DiagnosticsPlural = (
	count: number,
	oneKey: string,
	otherKey: string,
	params?: Record<string, string>,
) => string;

export type DiagnosticsListOptions = {
	t: (key: string, params?: Record<string, string>) => string;
	plural: DiagnosticsPlural;
	/** Reveal a 1-based line in the editor (best-effort host hook). */
	onReveal(line: number): void;
};

export interface DiagnosticsListHandle {
	/** The mounted section element — stable for the handle's lifetime. */
	readonly element: HTMLElement;
	/** Reconcile the rendered rows onto `diagnostics`. Idempotent: an
	 *  identical set writes nothing to the DOM. */
	update(diagnostics: readonly Diagnostic[]): void;
}

/** One rendered row plus the text it currently shows, so an update can skip
 *  a row whose fields are unchanged without re-reading the DOM. */
interface RowRecord {
	li: HTMLLIElement;
	button: HTMLButtonElement;
	loc: HTMLSpanElement;
	msg: HTMLSpanElement;
	line: number;
	/** `null` until the first apply, so a row always writes its class once. */
	severity: DiagnosticSeverity | null;
	locText: string;
	msgText: string;
	title: string;
}

function setText(el: HTMLElement, next: string, current: string): boolean {
	if (next === current) return false;
	el.textContent = next;
	return true;
}

export function createDiagnosticsList(opts: DiagnosticsListOptions): DiagnosticsListHandle {
	const { t, plural, onReveal } = opts;

	const section = document.createElement("div");
	section.className = "editor__diagnostics";
	const head = document.createElement("div");
	head.className = "editor__diagnostics-head";
	section.appendChild(head);

	const list = document.createElement("ul");
	list.className = "editor__diagnostics-list";
	list.setAttribute("aria-label", t("diagnostics.region"));

	const rows: RowRecord[] = [];
	let headText: string | null = null;
	let listMounted = false;

	function createRow(): RowRecord {
		const li = document.createElement("li");
		const button = document.createElement("button");
		button.type = "button";
		const loc = document.createElement("span");
		loc.className = "editor__diagnostic-loc";
		const msg = document.createElement("span");
		msg.className = "editor__diagnostic-msg";
		button.append(loc, msg);
		li.appendChild(button);
		const record: RowRecord = {
			li,
			button,
			loc,
			msg,
			line: 0,
			severity: null,
			locText: "",
			msgText: "",
			title: "",
		};
		// The listener is bound once and reads the row's CURRENT line, so a
		// reused row reveals the right place without re-binding.
		button.addEventListener("click", () => onReveal(record.line));
		return record;
	}

	function applyRow(record: RowRecord, d: Diagnostic): void {
		if (record.severity !== d.severity) {
			record.severity = d.severity;
			const severe = d.severity === DiagnosticSeverity.Error;
			record.button.className = `editor__diagnostic editor__diagnostic--${severe ? "error" : "warning"}`;
		}
		record.line = d.line;
		const title = t("diagnostics.reveal", { line: String(d.line) });
		if (title !== record.title) {
			record.title = title;
			record.button.title = title;
		}
		const locText = t("diagnostics.lineLabel", { line: String(d.line) });
		if (setText(record.loc, locText, record.locText)) record.locText = locText;
		const msgText = diagnosticMessage(d, t);
		if (setText(record.msg, msgText, record.msgText)) record.msgText = msgText;
	}

	function update(diagnostics: readonly Diagnostic[]): void {
		const { errors, warnings } = countBySeverity(diagnostics);
		// Each half is pluralised on its own count ("1 error · 2 warnings"); the
		// separator stays in the catalog so a locale can move or replace it.
		const nextHead =
			diagnostics.length === 0
				? t("diagnostics.clean")
				: t("diagnostics.summary", {
						errors: plural(errors, "diagnostics.errors.one", "diagnostics.errors.other"),
						warnings: plural(warnings, "diagnostics.warnings.one", "diagnostics.warnings.other"),
					});
		if (nextHead !== headText) {
			headText = nextHead;
			head.textContent = nextHead;
		}

		for (let i = 0; i < diagnostics.length; i++) {
			const d = diagnostics[i];
			if (!d) continue;
			let record = rows[i];
			if (!record) {
				record = createRow();
				rows.push(record);
				list.appendChild(record.li);
			}
			applyRow(record, d);
		}
		for (const extra of rows.splice(diagnostics.length)) extra.li.remove();

		const shouldMount = diagnostics.length > 0;
		if (shouldMount !== listMounted) {
			listMounted = shouldMount;
			if (shouldMount) section.appendChild(list);
			else list.remove();
		}
	}

	return { element: section, update };
}
