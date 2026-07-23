/**
 * Form Designer (React, Stage 8.10). A *form* is a named, ordered set of
 * property fields persisted as a `brainstorm/Layout/v1` entity
 * (`LayoutMode.Stacked`, any-context) that, in **Fill** mode, creates a
 * new vault entity of a chosen target type.
 *
 * Two modes in one window:
 *   - **Builder** — name the form, pick the target entity type, add
 *     fields from the vault property catalog, reorder + relabel + remove
 *     them, and Save (create / update the Layout entity).
 *   - **Fill** — render the saved fields as editable shared property
 *     cells, collect values, and Create the target entity.
 *
 * Reactivity: the saved-forms sidebar derives from the live whole-vault
 * snapshot read through the ONE shared stack — `@brainstorm-os/react-yjs`
 * `useVaultEntities` — never a hand-rolled `onChange → list → setState`.
 *
 * Outside the shell there is no entities/properties service, so the app
 * runs read-only against an empty catalog per the preview-drop pattern.
 */

import { useVaultEntities } from "@brainstorm-os/react-yjs";
import {
	LAYOUT_TYPE_URL,
	type PropertiesService,
	type PropertyDef,
	type PropertyPredicate,
	ValueType,
	defaultViewFor,
} from "@brainstorm-os/sdk-types";
import { Orientation, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { MenuAlign } from "@brainstorm-os/sdk/menus";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { Popover } from "@brainstorm-os/sdk/popover";
import { PropertiesProvider, getCell } from "@brainstorm-os/sdk/property-ui";
import { useResizable } from "@brainstorm-os/sdk/resizable";
import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n";
import { useFormDesignerT } from "./i18n-hooks";
import { toCellValue, toDbValue } from "./logic/cell-bridge";
import {
	type ConditionClause,
	ConditionOp,
	clauseToPredicate,
	opNeedsValue,
	predicateToClause,
} from "./logic/condition-model";
import {
	DEFAULT_TARGET_TYPE,
	type FormField,
	type FormProperties,
	buildFormProperties,
	cellsToFields,
	moveField as moveField_,
	readFormProperties,
} from "./logic/form-model";
import { INVOICE_TYPE, invoiceFromProperties } from "./logic/invoice";
import {
	requiredEmptyFields,
	visibleFields,
	visibleFillProperties,
} from "./logic/visibility-rules";
import { type EntitiesService, getBrainstorm } from "./storage/runtime";
import { type InvoiceEntity, InvoicesSurface } from "./ui/invoices";

/** Top-level Designer surface: form templates (Forms) or billing documents
 *  (Documents — invoices today). Forms keep their Builder/Fill modes within. */
enum DesignerSurface {
	Forms = "forms",
	Documents = "documents",
}

/** Builder vs Fill — the one window's two modes. */
enum FormMode {
	Builder = "builder",
	Fill = "fill",
}

/** A target type the user can pick without typing a URL — the generic
 *  `Object/v1` plus common first-party types registered in the vault. */
const KNOWN_TARGET_TYPES: ReadonlyArray<{ url: string; label: string }> = [
	{ url: DEFAULT_TARGET_TYPE, label: "Object" },
	{ url: "brainstorm/Task/v1", label: "Task" },
	{ url: "brainstorm/Event/v1", label: "Event" },
	{ url: "io.brainstorm.notes/Note/v1", label: "Note" },
	{ url: "io.brainstorm.contacts/Person/v1", label: "Person" },
	{ url: "io.brainstorm.bookmarks/Bookmark/v1", label: "Bookmark" },
];

const CUSTOM_TYPE_SENTINEL = "__custom__";

/** Drag payload MIME for field-card reorder — carries the dragged
 *  field's stable `property` key (never an index) so the move survives
 *  any re-render that happens mid-drag. */
const FIELD_DND_MIME = "application/x-bs-form-field";

const EMPTY_FIELDS: FormField[] = [];

type SavedForm = {
	id: string;
	name: string;
	props: FormProperties;
};

function entitiesService(): EntitiesService | null {
	return getBrainstorm()?.services?.entities ?? null;
}

function propertiesService(): PropertiesService | null {
	return getBrainstorm()?.services?.properties ?? null;
}

/** Project the live vault snapshot to the saved forms (Layout entities). */
function formsFromSnapshot(
	entities: ReadonlyArray<{ id: string; properties: Record<string, unknown> }>,
): SavedForm[] {
	return entities.map((entity) => {
		const props = readFormProperties(entity.properties);
		return { id: entity.id, name: props.name, props };
	});
}

export function FormDesignerApp(): ReactElement {
	useFormDesignerT();
	const [ready, setReady] = useState(false);
	const [surface, setSurface] = useState<DesignerSurface>(DesignerSurface.Forms);
	const [mode, setMode] = useState<FormMode>(FormMode.Builder);
	const [formId, setFormId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [targetType, setTargetType] = useState<string>(DEFAULT_TARGET_TYPE);
	const [customType, setCustomType] = useState(false);
	const [fields, setFields] = useState<FormField[]>(EMPTY_FIELDS);
	const [catalog, setCatalog] = useState<Readonly<Record<string, PropertyDef>>>({});
	const [fillValues, setFillValues] = useState<Record<string, unknown>>({});
	const [invalidFields, setInvalidFields] = useState<ReadonlySet<string>>(() => new Set());
	const [status, setStatus] = useState<string>(() => t("status.newForm"));
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	// Horizontal tablist keyboard model (←/→/Home/End move + select, roving
	// tabindex, aria-selected) for the surface + mode tab rows — roles flow
	// through the hook, not literals.
	const surfaceTabs = [DesignerSurface.Forms, DesignerSurface.Documents] as const;
	const selectSurface = (index: number) => setSurface(surfaceTabs[index] ?? DesignerSurface.Forms);
	const surfaceKeyboard = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: surfaceTabs.length,
		activeIndex: Math.max(0, surfaceTabs.indexOf(surface)),
		onActiveIndexChange: selectSurface,
		onActivate: selectSurface,
		role: "tablist",
		itemRole: "tab",
	});
	const modeTabs = [FormMode.Builder, FormMode.Fill] as const;
	const selectMode = (index: number) => {
		if (index === 0) setInvalidFields(new Set());
		setMode(modeTabs[index] ?? FormMode.Builder);
	};
	const modeKeyboard = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		count: modeTabs.length,
		activeIndex: Math.max(0, modeTabs.indexOf(mode)),
		onActiveIndexChange: selectMode,
		onActivate: selectMode,
		role: "tablist",
		itemRole: "tab",
	});

	const moreButtonRef = useRef<HTMLButtonElement>(null);
	const addFieldRef = useRef<HTMLButtonElement>(null);
	const fillRowRefs = useRef<Map<string, HTMLLIElement | null>>(new Map());

	const { handleProps, width: sidebarWidth } = useResizable({
		side: "left",
		defaultWidth: 248,
		min: 200,
		max: 420,
		storageKey: "form-designer:sidebar-width",
	});

	// Reactivity: the saved-forms list reads off the live whole-vault
	// snapshot through the ONE shared stack — `useVaultEntities`.
	const vault = useVaultEntities(ready ? (getBrainstorm()?.services?.vaultEntities ?? null) : null);
	const forms = useMemo(() => {
		const layouts = vault.entities.filter((e) => e.type === LAYOUT_TYPE_URL);
		return formsFromSnapshot(layouts);
	}, [vault]);
	const invoices = useMemo<InvoiceEntity[]>(
		() =>
			vault.entities
				.filter((e) => e.type === INVOICE_TYPE)
				.map((e) => ({ id: e.id, doc: invoiceFromProperties(e.properties) })),
		[vault],
	);
	const confirmDeleteForm = confirmDeleteId
		? (forms.find((form) => form.id === confirmDeleteId) ?? null)
		: null;

	// Boot: gate the live bindings on the lifecycle `ready` handshake, then
	// hydrate the property catalog once.
	useEffect(() => {
		const boot = (): void => {
			setReady(true);
			const svc = propertiesService();
			if (svc) {
				void svc
					.list()
					.then((snap) => setCatalog(snap.properties))
					.catch(() => undefined);
			}
		};
		const bs = getBrainstorm();
		if (bs?.on) {
			const sub = bs.on("ready", boot);
			return () => sub?.unsubscribe();
		}
		boot();
		return undefined;
	}, []);

	const startNewForm = useCallback((): void => {
		setFormId(null);
		setName("");
		setTargetType(DEFAULT_TARGET_TYPE);
		setCustomType(false);
		setFields(EMPTY_FIELDS);
		setFillValues({});
		setInvalidFields(new Set());
		setMode(FormMode.Builder);
		setStatus(t("status.newForm"));
	}, []);

	const loadForm = useCallback((form: SavedForm): void => {
		setFormId(form.id);
		setName(form.props.name);
		setTargetType(form.props.targetType);
		setCustomType(!KNOWN_TARGET_TYPES.some((known) => known.url === form.props.targetType));
		setFields(cellsToFields(form.props.cells));
		setFillValues({});
		setInvalidFields(new Set());
		setStatus(t("status.loaded"));
	}, []);

	// Editing a field clears its own validation mark — the error message is
	// transient feedback, not a sticky state. A mark also clears when its
	// field goes hidden (a now-unmet condition can't leave a stale error),
	// so this recomputes against the currently-required-and-empty set.
	const onFillValues = useCallback(
		(next: Record<string, unknown>): void => {
			setFillValues(next);
			setInvalidFields((prev) => {
				if (prev.size === 0) return prev;
				const stillRequired = new Set(requiredEmptyFields(fields, next).map((f) => f.property));
				const remaining = new Set([...prev].filter((key) => stillRequired.has(key)));
				return remaining.size === prev.size ? prev : remaining;
			});
		},
		[fields],
	);

	const propertyDefs = useMemo(
		() => Object.values(catalog).sort((a, b) => (a.name ?? a.key).localeCompare(b.name ?? b.key)),
		[catalog],
	);

	const addField = useCallback((propertyKey: string): void => {
		setFields((prev) =>
			prev.some((f) => f.property === propertyKey) ? prev : [...prev, { property: propertyKey }],
		);
	}, []);

	const openAddFieldMenu = useCallback((): void => {
		const anchor = addFieldRef.current;
		if (!anchor) return;
		const rect = anchor.getBoundingClientRect();
		const taken = new Set(fields.map((f) => f.property));
		const items: AnchoredMenuItem[] = propertyDefs
			.filter((def) => !taken.has(def.key))
			.map((def) => ({
				label: def.name ?? def.key,
				onSelect: () => addField(def.key),
			}));
		if (items.length === 0) {
			items.push({
				label: t("builder.noProperties"),
				onSelect: () => undefined,
				disabled: true,
			});
		}
		openAnchoredMenu({ x: rect.left, y: rect.bottom }, items, {
			menuLabel: t("builder.addFieldHint"),
			anchor,
			align: MenuAlign.Start,
		});
	}, [propertyDefs, fields, addField]);

	const moveField = useCallback((index: number, delta: number): void => {
		setFields((prev) => moveField_(prev, index, index + delta));
	}, []);

	// Drag-to-reorder commits ONLY here (on drop), keyed by the dragged
	// field's stable `property` — never by an index captured in a drag
	// closure — so a mid-drag re-render can't desync the move. Both the
	// keyboard up/down path and this path go through the same pure
	// `moveField` ordering rule.
	const reorderFieldByProperty = useCallback(
		(draggedProperty: string, beforeIndex: number): void => {
			setFields((prev) => {
				const from = prev.findIndex((f) => f.property === draggedProperty);
				if (from < 0) return prev;
				const to = from < beforeIndex ? beforeIndex - 1 : beforeIndex;
				return moveField_(prev, from, to);
			});
		},
		[],
	);

	const removeField = useCallback((index: number): void => {
		setFields((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const relabelField = useCallback((index: number, label: string): void => {
		setFields((prev) =>
			prev.map((field, i) =>
				i === index ? (label.trim() ? { ...field, label } : { property: field.property }) : field,
			),
		);
	}, []);

	// Set / clear a field's conditional-visibility rule (8.10.4). An
	// `undefined` predicate drops the key so an unconditional field
	// round-trips as `{ property }` (no empty `condition`).
	const setFieldCondition = useCallback(
		(index: number, condition: PropertyPredicate | undefined): void => {
			setFields((prev) =>
				prev.map((field, i) => {
					if (i !== index) return field;
					if (!condition) {
						const { condition: _drop, ...rest } = field;
						return rest;
					}
					return { ...field, condition };
				}),
			);
		},
		[],
	);

	const onSave = useCallback(async (): Promise<void> => {
		const entities = entitiesService();
		if (!entities) {
			setStatus(t("status.offline"));
			return;
		}
		if (name.trim().length === 0) {
			setStatus(t("status.needsName"));
			return;
		}
		if (fields.length === 0) {
			setStatus(t("status.needsFields"));
			return;
		}
		setStatus(t("status.saving"));
		try {
			const props = buildFormProperties({ name, targetType, fields });
			if (formId) {
				await entities.update(formId, props as unknown as Record<string, unknown>);
			} else {
				const created = await entities.create(
					LAYOUT_TYPE_URL,
					props as unknown as Record<string, unknown>,
				);
				setFormId(created.id);
			}
			setStatus(t("status.saved"));
		} catch {
			setStatus(t("status.saveFailed"));
		}
	}, [name, targetType, fields, formId]);

	const focusFillRow = useCallback((property: string): void => {
		const row = fillRowRefs.current.get(property);
		const focusable = row?.querySelector<HTMLElement>(
			"input, textarea, select, button, [tabindex]:not([tabindex='-1'])",
		);
		focusable?.focus();
	}, []);

	const onCreateEntity = useCallback(async (): Promise<void> => {
		const entities = entitiesService();
		if (!entities) {
			setStatus(t("status.offline"));
			return;
		}
		const empties = requiredEmptyFields(fields, fillValues);
		if (empties.length > 0) {
			setInvalidFields(new Set(empties.map((field) => field.property)));
			setStatus(t("status.needsFill"));
			const first = empties[0];
			if (first) focusFillRow(first.property);
			return;
		}
		setInvalidFields(new Set());
		setStatus(t("fill.creating"));
		try {
			const properties = visibleFillProperties({
				fields,
				values: fillValues,
				fallbackName: name.trim() || t("sidebar.untitled"),
			});
			await entities.create(targetType, properties);
			setFillValues({});
			setStatus(t("status.created", { type: targetTypeLabel(targetType) }));
		} catch {
			setStatus(t("status.createFailed"));
		}
	}, [fields, fillValues, name, targetType, focusFillRow]);

	const openMore = useCallback((): void => {
		const anchor = moreButtonRef.current;
		if (!anchor) return;
		const rect = anchor.getBoundingClientRect();
		openAnchoredMenu(
			{ x: rect.right, y: rect.bottom },
			[{ label: t("sidebar.newForm"), onSelect: startNewForm }],
			{ menuLabel: t("app.title"), anchor, align: MenuAlign.End },
		);
	}, [startNewForm]);

	const deleteForm = useCallback(
		async (id: string): Promise<void> => {
			const entities = entitiesService();
			if (!entities) {
				setStatus(t("status.offline"));
				return;
			}
			try {
				await entities.delete(id);
				// Editing the deleted form? Reset to a blank builder so the editor
				// doesn't keep pointing at a now-gone Layout entity.
				if (formId === id) startNewForm();
				setStatus(t("status.deleted"));
			} catch {
				setStatus(t("status.deleteFailed"));
			}
		},
		[formId, startNewForm],
	);

	const openFormItemMenu = useCallback(
		(form: SavedForm, point: { x: number; y: number }, anchor?: HTMLElement): void => {
			const items: AnchoredMenuItem[] = [
				{
					label: t("sidebar.delete"),
					destructive: true,
					onSelect: () => setConfirmDeleteId(form.id),
				},
			];
			openAnchoredMenu(point, items, {
				menuLabel: t("sidebar.itemActions"),
				align: MenuAlign.Start,
				...(anchor ? { anchor } : {}),
			});
		},
		[],
	);

	const onSelectTargetType = useCallback((value: string): void => {
		if (value === CUSTOM_TYPE_SENTINEL) {
			setCustomType(true);
			return;
		}
		setCustomType(false);
		setTargetType(value);
	}, []);

	const targetSelectOptions = useMemo(
		() => [
			...KNOWN_TARGET_TYPES.map((known) => ({ value: known.url, label: known.label })),
			{ value: CUSTOM_TYPE_SENTINEL, label: t("builder.targetCustom") },
		],
		[],
	);
	const targetSelectValue = customType
		? CUSTOM_TYPE_SENTINEL
		: (KNOWN_TARGET_TYPES.find((k) => k.url === targetType)?.url ?? CUSTOM_TYPE_SENTINEL);

	return (
		<>
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<h1 className="app-header__title">{t("app.title")}</h1>
				</div>
				<div className="app-header__right">
					<div
						className="bs-segmented"
						{...surfaceKeyboard.containerProps}
						aria-label={t("surface.region")}
					>
						<button
							type="button"
							{...surfaceKeyboard.getItemProps(0)}
							className={
								surface === DesignerSurface.Forms ? "bs-segmented__tab is-active" : "bs-segmented__tab"
							}
							onClick={() => setSurface(DesignerSurface.Forms)}
						>
							{t("surface.forms")}
						</button>
						<button
							type="button"
							{...surfaceKeyboard.getItemProps(1)}
							className={
								surface === DesignerSurface.Documents ? "bs-segmented__tab is-active" : "bs-segmented__tab"
							}
							onClick={() => setSurface(DesignerSurface.Documents)}
						>
							{t("surface.documents")}
						</button>
					</div>
					{surface === DesignerSurface.Forms && (
						<div className="bs-segmented" {...modeKeyboard.containerProps} aria-label={t("mode.region")}>
							<button
								type="button"
								{...modeKeyboard.getItemProps(0)}
								className={mode === FormMode.Builder ? "bs-segmented__tab is-active" : "bs-segmented__tab"}
								onClick={() => {
									setInvalidFields(new Set());
									setMode(FormMode.Builder);
								}}
							>
								{t("mode.builder")}
							</button>
							<button
								type="button"
								{...modeKeyboard.getItemProps(1)}
								className={mode === FormMode.Fill ? "bs-segmented__tab is-active" : "bs-segmented__tab"}
								onClick={() => setMode(FormMode.Fill)}
							>
								{t("mode.fill")}
							</button>
						</div>
					)}
					<button
						ref={moreButtonRef}
						type="button"
						className="bs-object-menu__more"
						aria-haspopup="menu"
						aria-label={t("app.moreActions")}
						data-bs-tooltip={t("app.moreActions")}
						onClick={openMore}
					>
						<span className="bs-object-menu__more-dot" />
						<span className="bs-object-menu__more-dot" />
						<span className="bs-object-menu__more-dot" />
					</button>
				</div>
			</header>
			{surface === DesignerSurface.Documents ? (
				<main id="app-root" className="fd-layout fd-layout--documents">
					<InvoicesSurface
						invoices={invoices}
						entities={entitiesService()}
						exportSvc={getBrainstorm()?.services?.export ?? null}
						files={getBrainstorm()?.services?.files ?? null}
						locale={navigator.language}
						todayIso={new Date().toISOString().slice(0, 10)}
						onStatus={setStatus}
					/>
				</main>
			) : (
				<main
					id="app-root"
					className="fd-layout"
					style={{ ["--fd-sidebar-width" as string]: `${sidebarWidth}px` }}
				>
					<aside className="fd-sidebar" aria-label={t("sidebar.region")}>
						<div className="fd-sidebar__header">
							<button type="button" className="bs-btn" onClick={startNewForm}>
								<span>{t("sidebar.newForm")}</span>
							</button>
						</div>
						<ul className="fd-sidebar__list">
							{forms.length === 0 ? (
								<li className="fd-sidebar__empty">{t("sidebar.empty")}</li>
							) : (
								forms.map((form) => (
									<li
										key={form.id}
										className="fd-sidebar__row"
										onContextMenu={(event) => {
											event.preventDefault();
											openFormItemMenu(form, { x: event.clientX, y: event.clientY });
										}}
									>
										<button
											type="button"
											className={
												form.id === formId ? "fd-sidebar__item fd-sidebar__item--active" : "fd-sidebar__item"
											}
											onClick={() => loadForm(form)}
										>
											{form.name.trim() || t("sidebar.untitled")}
										</button>
										<button
											type="button"
											className="bs-object-menu__more fd-sidebar__item-more"
											aria-haspopup="menu"
											aria-label={t("sidebar.itemActions")}
											data-bs-tooltip={t("sidebar.itemActions")}
											onClick={(event) => {
												const rect = event.currentTarget.getBoundingClientRect();
												openFormItemMenu(form, { x: rect.right, y: rect.bottom }, event.currentTarget);
											}}
										>
											<span className="bs-object-menu__more-dot" />
											<span className="bs-object-menu__more-dot" />
											<span className="bs-object-menu__more-dot" />
										</button>
									</li>
								))
							)}
						</ul>
					</aside>
					<div className="fd-resize" aria-label={t("sidebar.resize")} {...handleProps} />

					<section className="fd-main">
						{mode === FormMode.Builder ? (
							<BuilderPane
								name={name}
								onName={setName}
								targetType={targetType}
								customType={customType}
								targetSelectValue={targetSelectValue}
								targetSelectOptions={targetSelectOptions}
								onSelectTargetType={onSelectTargetType}
								onCustomType={setTargetType}
								fields={fields}
								catalog={catalog}
								addFieldRef={addFieldRef}
								onOpenAddField={openAddFieldMenu}
								onMove={moveField}
								onReorder={reorderFieldByProperty}
								onRemove={removeField}
								onRelabel={relabelField}
								onCondition={setFieldCondition}
								onSave={() => void onSave()}
							/>
						) : (
							<FillPane
								formId={formId}
								name={name}
								targetType={targetType}
								fields={fields}
								catalog={catalog}
								values={fillValues}
								onValues={onFillValues}
								invalidFields={invalidFields}
								rowRefs={fillRowRefs}
								onCreate={() => void onCreateEntity()}
							/>
						)}
						<p className="fd-status" role="status">
							{status}
						</p>
					</section>
				</main>
			)}
			{confirmDeleteForm && (
				<Popover
					title={t("delete.confirm.title")}
					onClose={() => setConfirmDeleteId(null)}
					footer={
						<div className="fd-confirm__actions">
							<button
								type="button"
								// biome-ignore lint/a11y/noAutofocus: focusing the safe default is the fail-safe-dialog contract
								autoFocus
								className="bs-btn bs-btn--neutral"
								onClick={() => setConfirmDeleteId(null)}
							>
								{t("delete.confirm.cancel")}
							</button>
							<button
								type="button"
								className="bs-btn bs-btn--danger"
								onClick={() => {
									const id = confirmDeleteForm.id;
									setConfirmDeleteId(null);
									void deleteForm(id);
								}}
							>
								{t("delete.confirm.confirm")}
							</button>
						</div>
					}
				>
					<p className="fd-confirm__body">
						{t("delete.confirm.body", {
							name: confirmDeleteForm.name.trim() || t("sidebar.untitled"),
						})}
					</p>
				</Popover>
			)}
		</>
	);
}

function targetTypeLabel(url: string): string {
	return KNOWN_TARGET_TYPES.find((k) => k.url === url)?.label ?? url;
}

function fieldDisplayName(
	field: FormField,
	catalog: Readonly<Record<string, PropertyDef>>,
): string {
	if (field.label?.trim()) return field.label.trim();
	return catalog[field.property]?.name ?? field.property;
}

function BuilderPane(props: {
	name: string;
	onName: (value: string) => void;
	targetType: string;
	customType: boolean;
	targetSelectValue: string;
	targetSelectOptions: ReadonlyArray<{ value: string; label: string }>;
	onSelectTargetType: (value: string) => void;
	onCustomType: (value: string) => void;
	fields: FormField[];
	catalog: Readonly<Record<string, PropertyDef>>;
	addFieldRef: React.RefObject<HTMLButtonElement | null>;
	onOpenAddField: () => void;
	onMove: (index: number, delta: number) => void;
	onReorder: (draggedProperty: string, beforeIndex: number) => void;
	onRemove: (index: number) => void;
	onRelabel: (index: number, label: string) => void;
	onCondition: (index: number, condition: PropertyPredicate | undefined) => void;
	onSave: () => void;
}): ReactElement {
	return (
		<div className="fd-builder">
			<div className="fd-builder__top">
				<label className="fd-field-row">
					<span className="fd-label">{t("builder.nameLabel")}</span>
					<input
						type="text"
						className="fd-input bs-input"
						value={props.name}
						placeholder={t("builder.namePlaceholder")}
						aria-label={t("builder.nameLabel")}
						onChange={(e) => props.onName(e.target.value)}
					/>
				</label>
				<div className="fd-field-row">
					<span className="fd-label">{t("builder.targetLabel")}</span>
					<SelectMenu
						value={props.targetSelectValue}
						options={props.targetSelectOptions}
						onChange={props.onSelectTargetType}
						ariaLabel={t("builder.targetSelectLabel")}
						className="fd-select"
					/>
				</div>
				{props.customType ? (
					<input
						type="text"
						className="fd-input bs-input"
						value={props.targetType}
						placeholder={t("builder.targetPlaceholder")}
						aria-label={t("builder.targetPlaceholder")}
						onChange={(e) => props.onCustomType(e.target.value)}
					/>
				) : null}
			</div>

			<div className="fd-fields" aria-label={t("builder.fieldsLegend")}>
				<div className="fd-fields__header">
					<span className="fd-section-label">{t("builder.fieldsLegend")}</span>
					<button
						ref={props.addFieldRef}
						type="button"
						className="bs-btn bs-btn--sm"
						aria-haspopup="menu"
						onClick={props.onOpenAddField}
					>
						<span>{t("builder.addField")}</span>
					</button>
				</div>
				{props.fields.length === 0 ? (
					<p className="fd-fields__empty">{t("builder.fieldsEmpty")}</p>
				) : (
					<ul className="fd-fields__list">
						{props.fields.map((field, index) => (
							<FieldCard
								key={field.property}
								field={field}
								index={index}
								count={props.fields.length}
								siblings={props.fields}
								catalog={props.catalog}
								onMove={props.onMove}
								onReorder={props.onReorder}
								onRemove={props.onRemove}
								onRelabel={props.onRelabel}
								onCondition={props.onCondition}
							/>
						))}
					</ul>
				)}
			</div>

			<div className="fd-builder__footer">
				<button type="button" className="bs-btn" data-bs-primary onClick={props.onSave}>
					<span>{t("action.save")}</span>
				</button>
			</div>
		</div>
	);
}

function FieldCard(props: {
	field: FormField;
	index: number;
	count: number;
	siblings: readonly FormField[];
	catalog: Readonly<Record<string, PropertyDef>>;
	onMove: (index: number, delta: number) => void;
	onReorder: (draggedProperty: string, beforeIndex: number) => void;
	onRemove: (index: number) => void;
	onRelabel: (index: number, label: string) => void;
	onCondition: (index: number, condition: PropertyPredicate | undefined) => void;
}): ReactElement {
	const { field, index, count } = props;
	const [dropEdge, setDropEdge] = useState<"before" | "after" | null>(null);
	const [showCondition, setShowCondition] = useState<boolean>(() => field.condition !== undefined);
	const display = fieldDisplayName(field, props.catalog);
	const propName = props.catalog[field.property]?.name ?? field.property;

	const toggleCondition = useCallback((): void => {
		setShowCondition((prev) => {
			// Collapsing an active condition drops it — the panel is the only
			// place it lives, so hiding it clears the rule.
			if (prev && field.condition !== undefined) props.onCondition(index, undefined);
			return !prev;
		});
	}, [field.condition, index, props.onCondition]);

	const onDragStart = useCallback(
		(event: React.DragEvent<HTMLLIElement>): void => {
			event.dataTransfer.setData(FIELD_DND_MIME, field.property);
			event.dataTransfer.effectAllowed = "move";
		},
		[field.property],
	);

	const onDragOver = useCallback((event: React.DragEvent<HTMLLIElement>): void => {
		if (!event.dataTransfer.types.includes(FIELD_DND_MIME)) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		const rect = event.currentTarget.getBoundingClientRect();
		setDropEdge(event.clientY < rect.top + rect.height / 2 ? "before" : "after");
	}, []);

	const onDragLeave = useCallback((): void => setDropEdge(null), []);

	const onDrop = useCallback(
		(event: React.DragEvent<HTMLLIElement>): void => {
			const dragged = event.dataTransfer.getData(FIELD_DND_MIME);
			setDropEdge(null);
			if (!dragged || dragged === field.property) return;
			event.preventDefault();
			const before =
				event.clientY <
				event.currentTarget.getBoundingClientRect().top +
					event.currentTarget.getBoundingClientRect().height / 2;
			props.onReorder(dragged, before ? index : index + 1);
		},
		[field.property, index, props.onReorder],
	);

	const otherFields = props.siblings.filter((sibling) => sibling.property !== field.property);
	const className = dropEdge
		? `fd-field-card fd-field-card--drop-${dropEdge}`
		: showCondition
			? "fd-field-card fd-field-card--open"
			: "fd-field-card";

	return (
		<li
			className={className}
			draggable
			onDragStart={onDragStart}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			<div className="fd-field-card__row">
				<span
					className="fd-field-card__grip"
					aria-hidden="true"
					title={t("builder.dragHint", { name: display })}
				>
					<Icon name={IconName.DragHandle} />
				</span>
				<div className="fd-field-card__main">
					<span className="fd-field-card__name">{propName}</span>
					<input
						type="text"
						className="fd-input bs-input bs-input--sm"
						value={field.label ?? ""}
						placeholder={t("builder.fieldLabelPlaceholder")}
						aria-label={t("builder.fieldLabelAria", { name: propName })}
						onChange={(e) => props.onRelabel(index, e.target.value)}
					/>
				</div>
				<div className="fd-field-card__actions">
					<button
						type="button"
						className={
							showCondition
								? "bs-btn bs-btn--icon bs-btn--ghost is-active"
								: "bs-btn bs-btn--icon bs-btn--ghost"
						}
						aria-pressed={showCondition}
						aria-label={t("builder.condition.toggle", { name: display })}
						data-bs-tooltip={t("builder.condition.toggle", { name: display })}
						onClick={toggleCondition}
					>
						<Icon name={IconName.View} />
					</button>
					<button
						type="button"
						className="bs-btn bs-btn--icon bs-btn--ghost"
						aria-label={t("builder.moveUp", { name: display })}
						disabled={index === 0}
						onClick={() => props.onMove(index, -1)}
					>
						<Icon name={IconName.CaretUp} />
					</button>
					<button
						type="button"
						className="bs-btn bs-btn--icon bs-btn--ghost"
						aria-label={t("builder.moveDown", { name: display })}
						disabled={index === count - 1}
						onClick={() => props.onMove(index, 1)}
					>
						<Icon name={IconName.CaretDown} />
					</button>
					<button
						type="button"
						className="bs-btn bs-btn--icon bs-btn--ghost bs-btn--danger"
						aria-label={t("builder.removeField", { name: display })}
						onClick={() => props.onRemove(index)}
					>
						<Icon name={IconName.Close} />
					</button>
				</div>
			</div>
			{showCondition ? (
				<ConditionEditor
					condition={field.condition}
					otherFields={otherFields}
					catalog={props.catalog}
					onCommit={(next) => props.onCondition(index, next)}
				/>
			) : null}
		</li>
	);
}

/** Single-clause conditional-visibility editor (8.10.4) — "only show this
 *  field when <field> <operator> <value>". The clause is derived from the
 *  field's persisted `condition` each render (controlled); a predicate the
 *  simple editor can't represent shows a read-only advanced state. */
function ConditionEditor(props: {
	condition: PropertyPredicate | undefined;
	otherFields: readonly FormField[];
	catalog: Readonly<Record<string, PropertyDef>>;
	onCommit: (condition: PropertyPredicate | undefined) => void;
}): ReactElement {
	const parsed = predicateToClause(props.condition);
	const advanced = props.condition !== undefined && parsed === null;

	if (props.otherFields.length === 0) {
		return (
			<div className="fd-cond">
				<p className="fd-cond__hint">{t("builder.condition.noFields")}</p>
			</div>
		);
	}
	if (advanced) {
		return (
			<div className="fd-cond">
				<p className="fd-cond__hint">{t("builder.condition.advanced")}</p>
				<button
					type="button"
					className="bs-btn bs-btn--sm bs-btn--ghost"
					onClick={() => props.onCommit(undefined)}
				>
					<span>{t("builder.condition.clear")}</span>
				</button>
			</div>
		);
	}

	const firstOther = props.otherFields[0]?.property ?? "";
	const clause: ConditionClause = parsed ?? { when: firstOther, op: ConditionOp.Is, value: "" };
	const refDef = clause.when ? (props.catalog[clause.when] ?? null) : null;
	const emit = (next: ConditionClause): void => props.onCommit(clauseToPredicate(next));

	const whenOptions = props.otherFields.map((f) => ({
		value: f.property,
		label: fieldDisplayName(f, props.catalog),
	}));
	const opOptions = [
		{ value: ConditionOp.Is, label: t("builder.condition.op.is") },
		{ value: ConditionOp.IsNot, label: t("builder.condition.op.isNot") },
		{ value: ConditionOp.IsSet, label: t("builder.condition.op.isSet") },
		{ value: ConditionOp.IsEmpty, label: t("builder.condition.op.isEmpty") },
	];

	return (
		<div className="fd-cond">
			<span className="fd-cond__label">{t("builder.condition.prefix")}</span>
			<SelectMenu
				value={clause.when}
				options={whenOptions}
				onChange={(value) => emit({ ...clause, when: value })}
				ariaLabel={t("builder.condition.whenLabel")}
				className="fd-cond__select"
			/>
			<SelectMenu
				value={clause.op}
				options={opOptions}
				onChange={(value) => emit({ ...clause, op: value as ConditionOp })}
				ariaLabel={t("builder.condition.opLabel")}
				className="fd-cond__select"
			/>
			{opNeedsValue(clause.op) ? (
				refDef?.valueType === ValueType.Boolean ? (
					<SelectMenu
						value={clause.value === true ? "true" : "false"}
						options={[
							{ value: "true", label: t("builder.condition.checked") },
							{ value: "false", label: t("builder.condition.unchecked") },
						]}
						onChange={(value) => emit({ ...clause, value: value === "true" })}
						ariaLabel={t("builder.condition.valueLabel")}
						className="fd-cond__select"
					/>
				) : (
					<input
						type={refDef?.valueType === ValueType.Number ? "number" : "text"}
						className="fd-input bs-input bs-input--sm fd-cond__value"
						value={clause.value === null || clause.value === undefined ? "" : String(clause.value)}
						placeholder={t("builder.condition.valuePlaceholder")}
						aria-label={t("builder.condition.valueLabel")}
						onChange={(e) =>
							emit({
								...clause,
								value:
									refDef?.valueType === ValueType.Number
										? e.target.value === ""
											? null
											: Number(e.target.value)
										: e.target.value,
							})
						}
					/>
				)
			) : null}
		</div>
	);
}

function FillPane(props: {
	formId: string | null;
	name: string;
	targetType: string;
	fields: FormField[];
	catalog: Readonly<Record<string, PropertyDef>>;
	values: Record<string, unknown>;
	onValues: (next: Record<string, unknown>) => void;
	invalidFields: ReadonlySet<string>;
	rowRefs: React.RefObject<Map<string, HTMLLIElement | null>>;
	onCreate: () => void;
}): ReactElement {
	if (props.fields.length === 0) {
		return (
			<div className="fd-fill">
				<p className="fd-fill__empty">{props.formId ? t("fill.empty") : t("fill.selectForm")}</p>
			</div>
		);
	}

	const setValue = (key: string, value: unknown): void => {
		props.onValues({ ...props.values, [key]: value });
	};

	// Only currently-visible fields render (8.10.4) — a field whose
	// condition is unmet against the in-progress values is hidden, and (in
	// `onCreateEntity`) neither validated nor persisted.
	const shown = visibleFields(props.fields, props.values);

	const body = (
		<div className="fd-fill">
			<h2 className="fd-fill__heading">
				{t("fill.heading", { name: props.name.trim() || t("sidebar.untitled") })}
			</h2>
			<ul className="fd-fill__list">
				{shown.map((field) => {
					const def = props.catalog[field.property] ?? null;
					const label = fieldDisplayName(field, props.catalog);
					const Cell = def ? getCell(def.valueType, defaultViewFor(def)) : undefined;
					const invalid = props.invalidFields.has(field.property);
					const errorId = `form-fill-error-${field.property}`;
					return (
						<li
							key={field.property}
							ref={(el) => {
								props.rowRefs.current?.set(field.property, el);
							}}
							className={invalid ? "fd-fill__row fd-fill__row--invalid" : "fd-fill__row"}
						>
							<span className="fd-label">
								{label}{" "}
								<span className="fd-required" aria-hidden="true">
									*
								</span>
								<span className="fd-visually-hidden"> {t("fill.required")}</span>
							</span>
							{def && Cell ? (
								<Cell
									property={def}
									value={toCellValue(def, props.values[field.property])}
									onChange={(next) => setValue(field.property, toDbValue(def, next))}
									readOnly={false}
									noteId={`form-fill-${field.property}`}
								/>
							) : (
								<input
									type="text"
									className="fd-input bs-input"
									aria-label={label}
									aria-invalid={invalid || undefined}
									aria-describedby={invalid ? errorId : undefined}
									value={
										typeof props.values[field.property] === "string"
											? (props.values[field.property] as string)
											: ""
									}
									onChange={(e) => setValue(field.property, e.target.value)}
								/>
							)}
							{invalid ? (
								<span id={errorId} className="fd-fill__error" role="alert">
									{t("fill.fieldRequired", { name: label })}
								</span>
							) : null}
						</li>
					);
				})}
			</ul>
			<div className="fd-fill__footer">
				<button type="button" className="bs-btn" data-bs-primary onClick={props.onCreate}>
					<span>{t("fill.create")}</span>
				</button>
			</div>
		</div>
	);

	const svc = propertiesService();
	if (!svc) return body;
	return <PropertiesProvider runtime={{ services: { properties: svc } }}>{body}</PropertiesProvider>;
}
