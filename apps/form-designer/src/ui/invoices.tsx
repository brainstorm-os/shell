/**
 * Invoices surface (Designer iteration 1 — DT-2). The first **document** output
 * target: edit an `Invoice/v1` entity (parties, line items, tax, status) with a
 * live preview that IS the PDF (rendered through the shared `renderInvoiceHtml`),
 * and export it via the existing `export.printToPdf` + `requestSaveBytes` path.
 *
 * Reactive list comes from the parent's `useVaultEntities` snapshot; the open
 * invoice is edited locally (a `draft`) and debounce-persisted, so an incoming
 * snapshot from our own write never clobbers in-flight typing.
 */

import type { ExportService } from "@brainstorm/sdk-types";
import {
	SaveDispositionKind,
	type SaveFileService,
	requestSaveBytes,
} from "@brainstorm/sdk/export-file";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { SelectMenu } from "@brainstorm/sdk/select-menu";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import {
	INVOICE_STATUSES,
	type InvoiceDoc,
	type InvoiceStatus,
	computeInvoiceTotals,
	emptyInvoice,
	formatMoney,
	invoiceToProperties,
	renderInvoiceHtml,
} from "../logic/invoice";
import type { EntitiesService } from "../storage/runtime";

export type InvoiceEntity = { id: string; doc: InvoiceDoc };

type InvoicesSurfaceProps = {
	invoices: readonly InvoiceEntity[];
	entities: EntitiesService | null;
	exportSvc: ExportService | null;
	files: SaveFileService | null;
	locale: string | undefined;
	/** Today as ISO `YYYY-MM-DD` — the app supplies it (the logic module is time-pure). */
	todayIso: string;
	onStatus: (message: string) => void;
};

const CURRENCIES: readonly string[] = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"];

const PERSIST_DEBOUNCE_MS = 600;

function renderLabels() {
	return {
		invoice: t("invoice.documentTitle"),
		from: t("invoice.from"),
		billTo: t("invoice.billTo"),
		issued: t("invoice.issueDate"),
		due: t("invoice.dueDate"),
		description: t("invoice.item.description"),
		qty: t("invoice.item.qty"),
		unitPrice: t("invoice.item.unitPrice"),
		amount: t("invoice.item.amount"),
		subtotal: t("invoice.subtotal"),
		tax: t("invoice.tax"),
		total: t("invoice.total"),
		notes: t("invoice.notes"),
	};
}

function nextInvoiceNumber(existing: readonly InvoiceEntity[]): string {
	let max = 0;
	for (const { doc } of existing) {
		const match = /(\d+)\s*$/.exec(doc.number);
		if (match) max = Math.max(max, Number.parseInt(match[1] ?? "0", 10));
	}
	return `INV-${String(max + 1).padStart(3, "0")}`;
}

export function InvoicesSurface(props: InvoicesSurfaceProps): ReactElement {
	const { invoices, entities, exportSvc, files, locale, todayIso, onStatus } = props;

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [draft, setDraft] = useState<InvoiceDoc | null>(null);
	const [exporting, setExporting] = useState(false);

	const loadedFor = useRef<string | null>(null);
	const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Keep a selection: default to the first invoice once the list lands.
	useEffect(() => {
		if (selectedId && invoices.some((i) => i.id === selectedId)) return;
		setSelectedId(invoices[0]?.id ?? null);
	}, [invoices, selectedId]);

	// Load the selected entity into the editable draft ONCE per selection change
	// (not on every snapshot) so our own debounced writes don't clobber typing.
	useEffect(() => {
		if (selectedId === null) {
			setDraft(null);
			loadedFor.current = null;
			return;
		}
		if (loadedFor.current === selectedId) return;
		const found = invoices.find((i) => i.id === selectedId);
		if (found) {
			setDraft(found.doc);
			loadedFor.current = selectedId;
		}
	}, [selectedId, invoices]);

	const persist = useCallback(
		(id: string, next: InvoiceDoc) => {
			if (!entities) return;
			if (persistTimer.current) clearTimeout(persistTimer.current);
			persistTimer.current = setTimeout(() => {
				void entities.update(id, invoiceToProperties(next)).catch(() => undefined);
			}, PERSIST_DEBOUNCE_MS);
		},
		[entities],
	);

	const edit = useCallback(
		(mutate: (doc: InvoiceDoc) => InvoiceDoc) => {
			setDraft((current) => {
				if (!current || selectedId === null) return current;
				const next = mutate(current);
				persist(selectedId, next);
				return next;
			});
		},
		[selectedId, persist],
	);

	useEffect(() => {
		return () => {
			if (persistTimer.current) clearTimeout(persistTimer.current);
		};
	}, []);

	const onNew = useCallback(async () => {
		if (!entities) {
			onStatus(t("invoice.status.offline"));
			return;
		}
		const fresh = emptyInvoice(todayIso, nextInvoiceNumber(invoices));
		const created = await entities.create(
			"io.brainstorm.form-designer/Invoice/v1",
			invoiceToProperties(fresh),
		);
		loadedFor.current = created.id;
		setDraft(fresh);
		setSelectedId(created.id);
		onStatus(t("invoice.status.created"));
	}, [entities, invoices, todayIso, onStatus]);

	const totals = useMemo(() => (draft ? computeInvoiceTotals(draft) : null), [draft]);
	const previewHtml = useMemo(
		() => (draft ? renderInvoiceHtml(draft, renderLabels(), locale) : ""),
		[draft, locale],
	);

	const onExport = useCallback(async () => {
		if (!draft) return;
		if (!exportSvc || !files) {
			onStatus(t("invoice.status.offline"));
			return;
		}
		setExporting(true);
		try {
			const html = renderInvoiceHtml(draft, renderLabels(), locale);
			const disposition = await requestSaveBytes(files, {
				title: t("invoice.exportPdf"),
				suggestedName: `${draft.number}.pdf`,
				filters: [{ name: t("invoice.exportFilter"), extensions: ["pdf"] }],
				encode: () => exportSvc.printToPdf({ html }),
			});
			if (disposition.kind === SaveDispositionKind.Saved) {
				onStatus(t("invoice.status.exported", { name: disposition.handle.displayName }));
			} else if (disposition.kind === SaveDispositionKind.Cancelled) {
				onStatus(t("invoice.status.exportCancelled"));
			} else {
				onStatus(t("invoice.status.exportFailed"));
			}
		} catch {
			onStatus(t("invoice.status.exportFailed"));
		} finally {
			setExporting(false);
		}
	}, [draft, exportSvc, files, locale, onStatus]);

	const statusOptions = INVOICE_STATUSES.map((s) => ({
		value: s,
		label: t(`invoice.status.${s}` as Parameters<typeof t>[0]),
	}));
	const currencyOptions = CURRENCIES.map((c) => ({ value: c, label: c }));
	const money = (n: number) => (draft ? formatMoney(n, draft.currency, locale) : "");

	return (
		<div className="invoices">
			<aside className="invoices__list" aria-label={t("invoices.region")}>
				<div className="invoices__list-head">
					<span className="invoices__list-title">{t("invoices.title")}</span>
					<button type="button" className="invoices__new" onClick={() => void onNew()}>
						<Icon name={IconName.Plus} />
						<span>{t("invoices.new")}</span>
					</button>
				</div>
				{invoices.length === 0 ? (
					<p className="invoices__empty">{t("invoices.empty")}</p>
				) : (
					<ul className="invoices__items">
						{invoices.map(({ id, doc }) => (
							<li key={id}>
								<button
									type="button"
									className={`invoices__item${id === selectedId ? " invoices__item--active" : ""}`}
									onClick={() => setSelectedId(id)}
								>
									<span className="invoices__item-number">{doc.number}</span>
									<span className="invoices__item-meta">
										<span className="invoices__item-party">{doc.billTo.name || t("invoice.billTo")}</span>
										<span className={`invoices__badge invoices__badge--${doc.status}`}>
											{t(`invoice.status.${doc.status}` as Parameters<typeof t>[0])}
										</span>
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</aside>

			{draft && totals ? (
				<>
					<div className="invoices__editor">
						<div className="invoices__row">
							<label className="invoices__field">
								<span className="invoices__label">{t("invoice.numberLabel")}</span>
								<input
									className="bs-input"
									value={draft.number}
									onChange={(e) => edit((d) => ({ ...d, number: e.target.value }))}
								/>
							</label>
							<div className="invoices__field">
								<span className="invoices__label">{t("invoice.status")}</span>
								<SelectMenu
									value={draft.status}
									options={statusOptions}
									onChange={(next) => edit((d) => ({ ...d, status: next as InvoiceStatus }))}
									ariaLabel={t("invoice.status")}
									className="invoices__select"
								/>
							</div>
						</div>

						<div className="invoices__row">
							<label className="invoices__field">
								<span className="invoices__label">{t("invoice.issueDate")}</span>
								<input
									type="date"
									className="bs-input"
									value={draft.issueDate}
									onChange={(e) => edit((d) => ({ ...d, issueDate: e.target.value }))}
								/>
							</label>
							<label className="invoices__field">
								<span className="invoices__label">{t("invoice.dueDate")}</span>
								<input
									type="date"
									className="bs-input"
									value={draft.dueDate ?? ""}
									onChange={(e) => edit((d) => ({ ...d, dueDate: e.target.value || null }))}
								/>
							</label>
							<div className="invoices__field invoices__field--narrow">
								<span className="invoices__label">{t("invoice.currency")}</span>
								<SelectMenu
									value={draft.currency}
									options={currencyOptions}
									onChange={(next) => edit((d) => ({ ...d, currency: next }))}
									ariaLabel={t("invoice.currency")}
									className="invoices__select"
								/>
							</div>
						</div>

						<div className="invoices__parties">
							<PartyEditor
								legend={t("invoice.from")}
								party={draft.from}
								onEdit={(p) => edit((d) => ({ ...d, from: p }))}
							/>
							<PartyEditor
								legend={t("invoice.billTo")}
								party={draft.billTo}
								onEdit={(p) => edit((d) => ({ ...d, billTo: p }))}
							/>
						</div>

						<fieldset className="invoices__items-edit">
							<legend className="invoices__legend">{t("invoice.lineItems")}</legend>
							<div className="invoices__item-head">
								<span>{t("invoice.item.description")}</span>
								<span className="invoices__num-col">{t("invoice.item.qty")}</span>
								<span className="invoices__num-col">{t("invoice.item.unitPrice")}</span>
								<span className="invoices__num-col">{t("invoice.item.amount")}</span>
								<span className="invoices__item-remove-col" />
							</div>
							{draft.lineItems.map((item, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: line rows are positional; no stable id in the array model
								<div className="invoices__item-edit" key={i}>
									<input
										className="bs-input"
										placeholder={t("invoice.item.descriptionPlaceholder")}
										value={item.description}
										onChange={(e) =>
											edit((d) => ({
												...d,
												lineItems: d.lineItems.map((it, j) =>
													j === i ? { ...it, description: e.target.value } : it,
												),
											}))
										}
									/>
									<input
										type="number"
										className="bs-input invoices__num-col"
										aria-label={t("invoice.item.qty")}
										value={item.quantity}
										min={0}
										onChange={(e) =>
											edit((d) => ({
												...d,
												lineItems: d.lineItems.map((it, j) =>
													j === i ? { ...it, quantity: Number(e.target.value) } : it,
												),
											}))
										}
									/>
									<input
										type="number"
										className="bs-input invoices__num-col"
										aria-label={t("invoice.item.unitPrice")}
										value={item.unitPrice}
										min={0}
										step="0.01"
										onChange={(e) =>
											edit((d) => ({
												...d,
												lineItems: d.lineItems.map((it, j) =>
													j === i ? { ...it, unitPrice: Number(e.target.value) } : it,
												),
											}))
										}
									/>
									<span className="invoices__num-col invoices__amount">
										{money(totals.lineAmounts[i] ?? 0)}
									</span>
									<button
										type="button"
										className="invoices__item-remove"
										aria-label={t("invoice.item.remove")}
										data-bs-tooltip={t("invoice.item.remove")}
										onClick={() => edit((d) => ({ ...d, lineItems: d.lineItems.filter((_, j) => j !== i) }))}
									>
										<Icon name={IconName.Trash} />
									</button>
								</div>
							))}
							<button
								type="button"
								className="invoices__add-line"
								onClick={() =>
									edit((d) => ({
										...d,
										lineItems: [...d.lineItems, { description: "", quantity: 1, unitPrice: 0 }],
									}))
								}
							>
								<Icon name={IconName.Plus} />
								<span>{t("invoice.item.add")}</span>
							</button>
						</fieldset>

						<div className="invoices__row">
							<label className="invoices__field invoices__field--narrow">
								<span className="invoices__label">{t("invoice.tax")}</span>
								<input
									type="number"
									className="bs-input"
									value={draft.taxRatePct}
									min={0}
									max={100}
									step="0.1"
									onChange={(e) => edit((d) => ({ ...d, taxRatePct: Number(e.target.value) }))}
								/>
							</label>
							<div className="invoices__totals-mini">
								<span>{t("invoice.subtotal")}</span>
								<span>{money(totals.subtotal)}</span>
								<span className="invoices__totals-grand">{t("invoice.total")}</span>
								<span className="invoices__totals-grand">{money(totals.total)}</span>
							</div>
						</div>

						<label className="invoices__field">
							<span className="invoices__label">{t("invoice.notes")}</span>
							<textarea
								className="bs-input invoices__textarea"
								placeholder={t("invoice.notesPlaceholder")}
								value={draft.notes}
								onChange={(e) => edit((d) => ({ ...d, notes: e.target.value }))}
							/>
						</label>
					</div>

					<div className="invoices__preview-pane">
						<div className="invoices__preview-head">
							<span className="invoices__label">{t("invoice.preview")}</span>
							<button
								type="button"
								className="invoices__export"
								onClick={() => void onExport()}
								disabled={exporting || !exportSvc}
							>
								<Icon name={IconName.Download} />
								<span>{t("invoice.exportPdf")}</span>
							</button>
						</div>
						{/* renderInvoiceHtml escapes all user content (unit-tested), so this is safe. */}
						<div
							className="invoices__paper"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: invoice HTML is built from escaped fields by renderInvoiceHtml (tested)
							dangerouslySetInnerHTML={{ __html: previewHtml }}
						/>
					</div>
				</>
			) : (
				<div className="invoices__empty-main">{t("invoices.empty")}</div>
			)}
		</div>
	);
}

function PartyEditor(props: {
	legend: string;
	party: InvoiceDoc["from"];
	onEdit: (p: InvoiceDoc["from"]) => void;
}): ReactElement {
	const { legend, party, onEdit } = props;
	return (
		<fieldset className="invoices__party">
			<legend className="invoices__legend">{legend}</legend>
			<input
				className="bs-input"
				placeholder={t("invoice.party.name")}
				value={party.name}
				onChange={(e) => onEdit({ ...party, name: e.target.value })}
			/>
			<textarea
				className="bs-input invoices__party-address"
				placeholder={t("invoice.party.address")}
				value={party.addressLines.join("\n")}
				onChange={(e) => onEdit({ ...party, addressLines: e.target.value.split("\n") })}
			/>
			<input
				className="bs-input"
				placeholder={t("invoice.party.email")}
				value={party.email}
				onChange={(e) => onEdit({ ...party, email: e.target.value })}
			/>
		</fieldset>
	);
}
