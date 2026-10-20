/**
 * Change-type preview (9.12.33): before a property's type changes, show what
 * every bound value becomes, list the rows that would lose their value, and
 * only commit on an explicit confirm. Same `<dialog>` chrome as the import
 * preview (`db-import-modal`), so the two modal flows read alike.
 */

import { plural, t } from "../i18n";
import { ConversionOutcome, type RowConversion, type TypeChangePlan } from "../logic/change-type";

const PREVIEW_LIMIT = 20;
const LOST_LIMIT = 50;

export type ChangeTypeModalOptions = {
	plan: TypeChangePlan;
	propertyName: string;
	typeLabel: string;
	titleOf: (entityId: string) => string;
	display: (value: unknown) => string;
};

function listOf(
	rows: ReadonlyArray<RowConversion>,
	limit: number,
	line: (row: RowConversion) => string,
	testid: string,
): HTMLElement {
	const ul = document.createElement("ul");
	ul.className = "db-change-type__list";
	ul.dataset.testid = testid;
	for (const row of rows.slice(0, limit)) {
		const li = document.createElement("li");
		li.textContent = line(row);
		ul.appendChild(li);
	}
	if (rows.length > limit) {
		const more = document.createElement("li");
		more.className = "db-change-type__more";
		more.textContent = t("brainstorm.database.changeType.more", { count: rows.length - limit });
		ul.appendChild(more);
	}
	return ul;
}

/** Resolves `true` on confirm, `false` on Cancel / Escape / backdrop. */
export function openChangeTypeModal(opts: ChangeTypeModalOptions): Promise<boolean> {
	return new Promise((resolve) => {
		const { plan } = opts;
		const dialog = document.createElement("dialog");
		dialog.className = "db-import-modal db-change-type";
		dialog.dataset.testid = "db-change-type-modal";

		const title = document.createElement("h2");
		title.className = "db-import-modal__title";
		title.textContent = t("brainstorm.database.changeType.title", {
			name: opts.propertyName,
			type: opts.typeLabel,
		});

		const summary = document.createElement("p");
		summary.className = "db-import-modal__summary";
		summary.dataset.testid = "db-change-type-summary";
		const parts = [
			plural(
				plan.converted,
				"brainstorm.database.changeType.converted.one",
				"brainstorm.database.changeType.converted.other",
				{ count: plan.converted },
			),
		];
		if (plan.lost > 0) {
			parts.push(
				plural(
					plan.lost,
					"brainstorm.database.changeType.lost.one",
					"brainstorm.database.changeType.lost.other",
					{ count: plan.lost },
				),
			);
		}
		if (plan.locked > 0) {
			parts.push(
				plural(
					plan.locked,
					"brainstorm.database.changeType.locked.one",
					"brainstorm.database.changeType.locked.other",
					{ count: plan.locked },
				),
			);
		}
		summary.textContent = parts.join(" · ");

		dialog.append(title, summary);

		const lostRows = plan.rows.filter((r) => r.outcome === ConversionOutcome.Lost);
		if (lostRows.length > 0) {
			const heading = document.createElement("h3");
			heading.className = "db-change-type__heading";
			heading.textContent = t("brainstorm.database.changeType.lostHeading");
			dialog.append(
				heading,
				listOf(
					lostRows,
					LOST_LIMIT,
					(r) => `${opts.titleOf(r.id)} — ${opts.display(r.before)}`,
					"db-change-type-lost",
				),
			);
		}

		const converted = plan.rows.filter((r) => r.outcome === ConversionOutcome.Converted);
		if (converted.length > 0) {
			const heading = document.createElement("h3");
			heading.className = "db-change-type__heading";
			heading.textContent = t("brainstorm.database.changeType.previewHeading");
			dialog.append(
				heading,
				listOf(
					converted,
					PREVIEW_LIMIT,
					(r) => `${opts.titleOf(r.id)}: ${opts.display(r.before)} → ${opts.display(r.after)}`,
					"db-change-type-preview",
				),
			);
		}

		const actions = document.createElement("div");
		actions.className = "db-import-modal__actions";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "db-import-modal__cancel";
		cancel.textContent = t("brainstorm.database.import.cancel");
		const confirm = document.createElement("button");
		confirm.type = "button";
		confirm.className = "db-import-modal__import bs-filled";
		confirm.dataset.testid = "db-change-type-confirm";
		confirm.textContent = t("brainstorm.database.changeType.confirm");
		actions.append(cancel, confirm);
		dialog.append(actions);
		document.body.appendChild(dialog);

		let settled = false;
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			try {
				dialog.close();
			} catch {
				// jsdom has no dialog.close before showModal; removal is what matters.
			}
			dialog.remove();
			resolve(ok);
		};
		cancel.addEventListener("click", () => finish(false));
		confirm.addEventListener("click", () => finish(true));
		dialog.addEventListener("click", (event) => {
			if (event.target === dialog) finish(false);
		});
		dialog.addEventListener("close", () => finish(false));
		try {
			dialog.showModal();
		} catch {
			// jsdom: no showModal — the dialog is still in the document.
		}
		cancel.focus();
	});
}
