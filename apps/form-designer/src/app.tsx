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
	ChromeKind,
	LAYOUT_TYPE_URL,
	type LayoutCell,
	LayoutCellKind,
	type PropertiesService,
	type PropertyDef,
	type PropertyPredicate,
	ValueType,
	defaultViewFor,
} from "@brainstorm-os/sdk-types";
import { Orientation, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import type { EntityRow } from "@brainstorm-os/sdk/in-memory-entities";
import { chromeSeam } from "@brainstorm-os/sdk/layout-chrome";
import "@brainstorm-os/sdk/layout-chrome.css";
import { LayoutView, createLayoutValueSource } from "@brainstorm-os/sdk/layout-view";
import { MenuAlign } from "@brainstorm-os/sdk/menus";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { Popover } from "@brainstorm-os/sdk/popover";
import { PropertiesProvider, getCell } from "@brainstorm-os/sdk/property-ui";
import { useResizable } from "@brainstorm-os/sdk/resizable";
import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n";
import { useFormDesignerT } from "./i18n-hooks";
import "@brainstorm-os/sdk/layout-view.css";
import { toDbValue } from "./logic/cell-bridge";
import {
	type ConditionClause,
	ConditionOp,
	clauseToPredicate,
	opNeedsValue,
	predicateToClause,
} from "./logic/condition-model";
import {
	type FormGroup,
	type FormItem,
	FormItemKind,
	cellsToItems,
	chromeItem,
	fieldItem,
	groupItem,
	itemFields,
	itemsContainProperty,
	moveFieldIntoGroup,
	moveFieldOutOfGroup,
	moveItem,
	newItemId,
} from "./logic/form-items";
import {
	DEFAULT_TARGET_TYPE,
	type FormField,
	type FormProperties,
	MAX_GRID_COLUMNS,
	MIN_GRID_COLUMNS,
	buildFormProperties,
	formLayoutIssues,
	gridColumns,
	moveField as moveField_,
	readFormProperties,
	toLayoutDef,
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

const EMPTY_ITEMS: FormItem[] = [];

/** The curated chrome kinds a form can place (OQ-90 (a) — the set is
 *  shell-owned and closed, so this palette is the whole of it). */
const CHROME_PALETTE: readonly ChromeKind[] = [
	ChromeKind.EntityHeader,
	ChromeKind.ActionBar,
	ChromeKind.Breadcrumb,
	ChromeKind.Meta,
	ChromeKind.Tabs,
	ChromeKind.WindowControls,
];

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
	const [items, setItems] = useState<FormItem[]>(EMPTY_ITEMS);
	// Fill, validation and the create path all work on the flat leaf list —
	// a group is presentation, not a data boundary (8.10.3).
	const fields = useMemo(() => itemFields(items), [items]);
	// 0 ⇒ stacked; ≥2 ⇒ grid with that many tracks (8.10.2).
	const [columns, setColumns] = useState(0);
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
		setColumns(0);
		setItems(EMPTY_ITEMS);
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
		setItems(cellsToItems(form.props.cells));
		setColumns(gridColumns(form.props.columns) ?? 0);
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
		setItems((prev) =>
			itemsContainProperty(prev, propertyKey) ? prev : [...prev, fieldItem({ property: propertyKey })],
		);
	}, []);

	const addGroup = useCallback((): void => {
		setItems((prev) => [...prev, groupItem({ id: newItemId(FormItemKind.Group), fields: [] })]);
	}, []);

	const addChrome = useCallback((chrome: ChromeKind): void => {
		setItems((prev) => [...prev, chromeItem({ id: newItemId(FormItemKind.Chrome), chrome })]);
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
		// A form is a layout, so the same "add" gesture places the other two
		// authorable cell kinds — a section (group) and a shell-rendered page
		// element (chrome, 8.4) — rather than hiding them behind a second
		// control the user has to find.
		items.push({ divider: true });
		items.push({ label: t("builder.addGroup"), onSelect: () => addGroup() });
		items.push({
			label: t("builder.addChrome"),
			submenu: CHROME_PALETTE.map((kind) => ({
				label: chromeLabel(kind),
				onSelect: () => addChrome(kind),
			})),
		});
		openAnchoredMenu({ x: rect.left, y: rect.bottom }, items, {
			menuLabel: t("builder.addFieldHint"),
			anchor,
			align: MenuAlign.Start,
		});
	}, [propertyDefs, fields, addField, addGroup, addChrome]);

	const moveField = useCallback((index: number, delta: number): void => {
		setItems((prev) => moveItem(prev, index, index + delta));
	}, []);

	/** Move a top-level field into the group directly above it, or lift a
	 *  grouped field back out — the two directions of one gesture. */
	const nestField = useCallback((index: number, groupIndex: number): void => {
		setItems((prev) => moveFieldIntoGroup(prev, index, groupIndex));
	}, []);

	const unnestField = useCallback((groupIndex: number, fieldIndex: number): void => {
		setItems((prev) => moveFieldOutOfGroup(prev, groupIndex, fieldIndex));
	}, []);

	const relabelGroup = useCallback((index: number, label: string): void => {
		setItems((prev) =>
			prev.map((item, i) => {
				if (i !== index || item.kind !== FormItemKind.Group) return item;
				const trimmed = label.trim();
				const { label: _drop, ...rest } = item.group;
				return groupItem(trimmed ? { ...rest, label: trimmed } : rest);
			}),
		);
	}, []);

	// Drag-to-reorder commits ONLY here (on drop), keyed by the dragged
	// field's stable `property` — never by an index captured in a drag
	// closure — so a mid-drag re-render can't desync the move. Both the
	// keyboard up/down path and this path go through the same pure
	// `moveField` ordering rule.
	const reorderFieldByProperty = useCallback(
		(draggedProperty: string, beforeIndex: number): void => {
			setItems((prev) => {
				const from = prev.findIndex(
					(item) => item.kind === FormItemKind.Field && item.field.property === draggedProperty,
				);
				if (from < 0) return prev;
				const to = from < beforeIndex ? beforeIndex - 1 : beforeIndex;
				return moveItem(prev, from, to);
			});
		},
		[],
	);

	const removeField = useCallback((index: number): void => {
		setItems((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const relabelField = useCallback((index: number, label: string): void => {
		setItems((prev) =>
			prev.map((item, i) => {
				if (i !== index || item.kind !== FormItemKind.Field) return item;
				const field = item.field;
				return fieldItem(label.trim() ? { ...field, label } : { property: field.property });
			}),
		);
	}, []);

	// Set / clear a field's conditional-visibility rule (8.10.4). An
	// `undefined` predicate drops the key so an unconditional field
	// round-trips as `{ property }` (no empty `condition`).
	const setFieldCondition = useCallback(
		(index: number, condition: PropertyPredicate | undefined): void => {
			setItems((prev) =>
				prev.map((item, i) => {
					if (i !== index || item.kind !== FormItemKind.Field) return item;
					if (!condition) {
						const { condition: _drop, ...rest } = item.field;
						return fieldItem(rest);
					}
					return fieldItem({ ...item.field, condition });
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
			const props = buildFormProperties({ name, targetType, items, columns });
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
	}, [name, targetType, items, fields.length, formId, columns]);

	// Apply-to-type (8.10.5): promote the form to be the default `Layout/v1`
	// for its target type. It runs the layout through the SAME frozen
	// `validateAppLayouts` contract the shell enforces on app-shipped default
	// layouts at install (form-model `formLayoutIssues`), so a designer can
	// never publish a default the installer would reject; on pass it persists
	// the type-scoped layout (the resolver then returns it for that type). The
	// visible render of that default is gated on the 8.3 pipeline.
	const onApplyToType = useCallback(async (): Promise<void> => {
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
		const props = buildFormProperties({ name, targetType, items, columns });
		if (formLayoutIssues(props).length > 0) {
			setStatus(t("status.applyInvalid"));
			return;
		}
		setStatus(t("status.applying"));
		try {
			const payload = props as unknown as Record<string, unknown>;
			if (formId) {
				await entities.update(formId, payload);
			} else {
				const created = await entities.create(LAYOUT_TYPE_URL, payload);
				setFormId(created.id);
			}
			setStatus(t("status.appliedToType", { type: targetTypeLabel(targetType) }));
		} catch {
			setStatus(t("status.applyFailed"));
		}
	}, [name, targetType, items, fields.length, formId, columns]);

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
								items={items}
								fields={fields}
								onNest={nestField}
								onUnnest={unnestField}
								onRelabelGroup={relabelGroup}
								catalog={catalog}
								addFieldRef={addFieldRef}
								onOpenAddField={openAddFieldMenu}
								onMove={moveField}
								onReorder={reorderFieldByProperty}
								onRemove={removeField}
								onRelabel={relabelField}
								onCondition={setFieldCondition}
								columns={columns}
								onColumns={setColumns}
								onSave={() => void onSave()}
								onApplyToType={() => void onApplyToType()}
							/>
						) : (
							<FillPane
								formId={formId}
								name={name}
								targetType={targetType}
								fields={fields}
								columns={columns}
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

/** Stacked, or a grid of N tracks. The form persists the track count and
 *  derives each cell's `{col,row}` from it (8.10.2); `LayoutDef` itself
 *  has no notion of "the form's columns". */
function LAYOUT_OPTIONS(): ReadonlyArray<{ value: string; label: string }> {
	const options = [{ value: "0", label: t("builder.layoutStacked") }];
	for (let tracks = MIN_GRID_COLUMNS; tracks <= MAX_GRID_COLUMNS; tracks++) {
		options.push({
			value: String(tracks),
			label: t("builder.layoutGrid", { count: String(tracks) }),
		});
	}
	return options;
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
	items: FormItem[];
	fields: FormField[];
	catalog: Readonly<Record<string, PropertyDef>>;
	addFieldRef: React.RefObject<HTMLButtonElement | null>;
	onNest: (index: number, groupIndex: number) => void;
	onUnnest: (groupIndex: number, fieldIndex: number) => void;
	onRelabelGroup: (index: number, label: string) => void;
	onOpenAddField: () => void;
	onMove: (index: number, delta: number) => void;
	onReorder: (draggedProperty: string, beforeIndex: number) => void;
	onRemove: (index: number) => void;
	onRelabel: (index: number, label: string) => void;
	onCondition: (index: number, condition: PropertyPredicate | undefined) => void;
	columns: number;
	onColumns: (next: number) => void;
	onSave: () => void;
	onApplyToType: () => void;
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
				<div className="fd-field-row">
					<span className="fd-label">{t("builder.layoutLabel")}</span>
					<SelectMenu
						value={String(props.columns)}
						options={LAYOUT_OPTIONS()}
						onChange={(value) => props.onColumns(Number(value))}
						ariaLabel={t("builder.layoutLabel")}
						className="fd-select"
					/>
				</div>
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
				{props.items.length === 0 ? (
					<p className="fd-fields__empty">{t("builder.fieldsEmpty")}</p>
				) : (
					<ul className="fd-fields__list">
						{props.items.map((item, index) => {
							if (item.kind === FormItemKind.Group) {
								return (
									<GroupCard
										key={item.group.id}
										group={item.group}
										index={index}
										count={props.items.length}
										catalog={props.catalog}
										onMove={props.onMove}
										onRemove={props.onRemove}
										onRelabelGroup={props.onRelabelGroup}
										onUnnest={props.onUnnest}
									/>
								);
							}
							if (item.kind === FormItemKind.Chrome) {
								return (
									<ChromeCard
										key={item.chrome.id}
										chrome={item.chrome.chrome}
										index={index}
										count={props.items.length}
										onMove={props.onMove}
										onRemove={props.onRemove}
									/>
								);
							}
							// The group a field can drop into is the one directly above
							// it — a single unambiguous target keeps the gesture a
							// button rather than a drag-into-tree interaction.
							const above = props.items[index - 1];
							const groupAbove = above?.kind === FormItemKind.Group ? index - 1 : null;
							return (
								<FieldCard
									key={item.field.property}
									field={item.field}
									index={index}
									count={props.items.length}
									siblings={props.fields}
									catalog={props.catalog}
									groupAbove={groupAbove}
									onNest={props.onNest}
									onMove={props.onMove}
									onReorder={props.onReorder}
									onRemove={props.onRemove}
									onRelabel={props.onRelabel}
									onCondition={props.onCondition}
								/>
							);
						})}
					</ul>
				)}
			</div>

			<div className="fd-builder__footer">
				<button
					type="button"
					className="bs-btn bs-btn--neutral"
					data-bs-tooltip={t("action.applyToTypeHint", { type: targetTypeLabel(props.targetType) })}
					onClick={props.onApplyToType}
				>
					<span>{t("action.applyToType")}</span>
				</button>
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
	/** Index of the group directly above, if any — the one target this
	 *  field can be nested into. `null` ⇒ no nest affordance. */
	groupAbove: number | null;
	onNest: (index: number, groupIndex: number) => void;
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
					{props.groupAbove !== null ? (
						<button
							type="button"
							className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
							aria-label={t("builder.nestField")}
							data-bs-tooltip={t("builder.nestField")}
							data-nest-field={field.property}
							onClick={() => props.onNest(index, props.groupAbove as number)}
						>
							<Icon name={IconName.CaretRight} size={14} />
						</button>
					) : null}
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
/** A labelled section (doc 27 `group` cell). Its fields are shown
 *  read-only here with a "lift out" control — nesting is edited from the
 *  field side (one gesture, one direction each), never in two places. */
function GroupCard(props: {
	group: FormGroup;
	index: number;
	count: number;
	catalog: Readonly<Record<string, PropertyDef>>;
	onMove: (index: number, delta: number) => void;
	onRemove: (index: number) => void;
	onRelabelGroup: (index: number, label: string) => void;
	onUnnest: (groupIndex: number, fieldIndex: number) => void;
}): ReactElement {
	const { group, index, count } = props;
	return (
		<li className="fd-field-card fd-group-card" data-group-index={index}>
			<div className="fd-field-card__head">
				<input
					type="text"
					className="fd-input bs-input bs-input--sm"
					value={group.label ?? ""}
					placeholder={t("builder.groupLabelPlaceholder")}
					aria-label={t("builder.groupLabel")}
					onChange={(e) => props.onRelabelGroup(index, e.target.value)}
				/>
				<div className="fd-field-card__actions">
					<button
						type="button"
						className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
						aria-label={t("builder.moveUp")}
						disabled={index === 0}
						onClick={() => props.onMove(index, -1)}
					>
						<Icon name={IconName.CaretUp} size={14} />
					</button>
					<button
						type="button"
						className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
						aria-label={t("builder.moveDown")}
						disabled={index === count - 1}
						onClick={() => props.onMove(index, 1)}
					>
						<Icon name={IconName.CaretDown} size={14} />
					</button>
					<button
						type="button"
						className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
						aria-label={t("builder.removeGroup")}
						onClick={() => props.onRemove(index)}
					>
						<Icon name={IconName.Close} size={14} />
					</button>
				</div>
			</div>
			{group.fields.length === 0 ? (
				<p className="fd-group-card__empty">{t("builder.groupEmpty")}</p>
			) : (
				<ul className="fd-group-card__fields">
					{group.fields.map((field, fieldIndex) => (
						<li key={field.property} className="fd-group-card__field">
							<span className="fd-group-card__field-name">{fieldDisplayName(field, props.catalog)}</span>
							<button
								type="button"
								className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
								aria-label={t("builder.unnestField")}
								data-bs-tooltip={t("builder.unnestField")}
								data-unnest-field={field.property}
								onClick={() => props.onUnnest(index, fieldIndex)}
							>
								<Icon name={IconName.CaretLeft} size={14} />
							</button>
						</li>
					))}
				</ul>
			)}
		</li>
	);
}

/** A shell-rendered chrome cell (8.4). The designer places it; what it
 *  draws is the shell's business, so the card is a name + placement
 *  controls, with no options surface to drift from the registry. */
function ChromeCard(props: {
	chrome: ChromeKind;
	index: number;
	count: number;
	onMove: (index: number, delta: number) => void;
	onRemove: (index: number) => void;
}): ReactElement {
	const { chrome, index, count } = props;
	return (
		<li className="fd-field-card fd-chrome-card" data-chrome-kind={chrome}>
			<div className="fd-field-card__head">
				<span className="fd-chrome-card__name">{chromeLabel(chrome)}</span>
				<div className="fd-field-card__actions">
					<button
						type="button"
						className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
						aria-label={t("builder.moveUp")}
						disabled={index === 0}
						onClick={() => props.onMove(index, -1)}
					>
						<Icon name={IconName.CaretUp} size={14} />
					</button>
					<button
						type="button"
						className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
						aria-label={t("builder.moveDown")}
						disabled={index === count - 1}
						onClick={() => props.onMove(index, 1)}
					>
						<Icon name={IconName.CaretDown} size={14} />
					</button>
					<button
						type="button"
						className="bs-btn bs-btn--sm bs-btn--ghost bs-btn--icon"
						aria-label={t("builder.removeChrome")}
						onClick={() => props.onRemove(index)}
					>
						<Icon name={IconName.Close} size={14} />
					</button>
				</div>
			</div>
		</li>
	);
}

/** The curated chrome kinds, labelled. Closed set per OQ-90 (a), so this
 *  map is exhaustive by construction. */
function chromeLabel(kind: ChromeKind): string {
	switch (kind) {
		case ChromeKind.ActionBar:
			return t("chrome.actionBar");
		case ChromeKind.Breadcrumb:
			return t("chrome.breadcrumb");
		case ChromeKind.Meta:
			return t("chrome.meta");
		case ChromeKind.WindowControls:
			return t("chrome.windowControls");
		case ChromeKind.EntityHeader:
			return t("chrome.entityHeader");
		default:
			return t("chrome.tabs");
	}
}

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
	columns: number;
	catalog: Readonly<Record<string, PropertyDef>>;
	values: Record<string, unknown>;
	onValues: (next: Record<string, unknown>) => void;
	invalidFields: ReadonlySet<string>;
	rowRefs: React.RefObject<Map<string, HTMLLIElement | null>>;
	onCreate: () => void;
}): ReactElement {
	// The fill surface renders through the SHARED 8.3 pipeline rather than
	// its own field loop: the form IS a `Layout/v1`, so `<LayoutView>` is
	// what draws it, and each field cell subscribes to its own key — a
	// keystroke in one field repaints that field, not the form. The
	// designer keeps only what a *form* adds around a cell (label,
	// required marker, validation message), through the `renderCell` seam.
	const layout = useMemo(
		() =>
			toLayoutDef(
				buildFormProperties({
					name: props.name,
					targetType: props.targetType,
					fields: props.fields,
					columns: props.columns,
				}),
			),
		[props.name, props.targetType, props.fields, props.columns],
	);

	// One stable store for the whole fill, mutated per key — a per-render
	// source would resubscribe every cell on every keystroke, which is the
	// opposite of what the per-cell subscription is for. Switching forms
	// needs no new store: `loadForm` clears the values, and the reset below
	// notifies exactly the keys that changed.
	const source = useMemo(() => createLayoutValueSource({}), []);
	const valuesRef = useRef(props.values);
	valuesRef.current = props.values;
	useEffect(() => {
		source.reset(props.values);
	}, [source, props.values]);

	const onChange = useCallback(
		(property: string, next: unknown): void => {
			const def = props.catalog[property];
			props.onValues({
				...valuesRef.current,
				[property]: def ? toDbValue(def, next) : next,
			});
		},
		[props.catalog, props.onValues],
	);

	const fieldByProperty = useMemo(
		() => new Map(props.fields.map((field) => [field.property, field])),
		[props.fields],
	);
	const fieldByPropertyRef = useRef(fieldByProperty);
	fieldByPropertyRef.current = fieldByProperty;

	// A form must stay fillable even when the property catalog can't draw
	// the field — an app with no properties service, or a value type whose
	// view has no registered cell. The pipeline's own placeholder is
	// visible but not editable, which for a form means a field the user
	// cannot complete, so the designer supplies a plain text input.
	const renderMissingCell = useCallback(
		(cell: { property: string }): React.ReactNode => {
			const field = fieldByPropertyRef.current.get(cell.property) ?? {
				property: cell.property,
			};
			const label = fieldDisplayName(field, props.catalog);
			const invalid = props.invalidFields.has(cell.property);
			return (
				<input
					type="text"
					className="fd-input bs-input"
					aria-label={label}
					aria-invalid={invalid || undefined}
					aria-describedby={invalid ? `form-fill-error-${cell.property}` : undefined}
					value={
						typeof valuesRef.current[cell.property] === "string"
							? (valuesRef.current[cell.property] as string)
							: ""
					}
					onChange={(e) => onChange(cell.property, e.target.value)}
				/>
			);
		},
		[props.catalog, props.invalidFields, onChange],
	);

	// Chrome cells draw through the shared 8.4 registry — the designer
	// places them, the shell owns what they look like. The fill surface is
	// a preview of a not-yet-created entity, so the host data is what a
	// draft actually has: its title, and nothing that needs an id.
	const renderChrome = useMemo(
		() =>
			chromeSeam({
				entity: {
					id: `form-fill-${props.formId ?? "new"}`,
					type: props.targetType,
					properties: props.values,
					createdAt: 0,
					updatedAt: 0,
					deletedAt: null,
				},
				title: props.name.trim() || t("sidebar.untitled"),
			}),
		[props.formId, props.targetType, props.values, props.name],
	);

	const renderCell = useCallback(
		(cell: LayoutCell, body: React.ReactNode): React.ReactNode => {
			if (cell.kind !== LayoutCellKind.Property) return body;
			const field = fieldByProperty.get(cell.property) ?? { property: cell.property };
			const label = fieldDisplayName(field, props.catalog);
			const invalid = props.invalidFields.has(cell.property);
			const errorId = `form-fill-error-${cell.property}`;
			return (
				<div
					className={invalid ? "fd-fill__row fd-fill__row--invalid" : "fd-fill__row"}
					data-field={cell.property}
					ref={(el) => {
						props.rowRefs.current?.set(cell.property, el as HTMLLIElement | null);
					}}
				>
					<span className="fd-label">
						{label}{" "}
						<span className="fd-required" aria-hidden="true">
							*
						</span>
						<span className="fd-visually-hidden"> {t("fill.required")}</span>
					</span>
					{body}
					{invalid ? (
						<span id={errorId} className="fd-fill__error" role="alert">
							{t("fill.fieldRequired", { name: label })}
						</span>
					) : null}
				</div>
			);
		},
		[fieldByProperty, props.catalog, props.invalidFields, props.rowRefs],
	);

	if (props.fields.length === 0) {
		return (
			<div className="fd-fill">
				<p className="fd-fill__empty">{props.formId ? t("fill.empty") : t("fill.selectForm")}</p>
			</div>
		);
	}

	// `condition` is evaluated by the pipeline against this entity's
	// properties — the in-progress fill values ARE the entity here (8.10.4).
	const draft: EntityRow = {
		id: `form-fill-${props.formId ?? "new"}`,
		type: props.targetType,
		properties: props.values,
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};

	const body = (
		<div className="fd-fill">
			<h2 className="fd-fill__heading">
				{t("fill.heading", { name: props.name.trim() || t("sidebar.untitled") })}
			</h2>
			<LayoutView
				className="fd-fill__layout"
				layout={layout}
				entity={draft}
				propertyDef={(key) => props.catalog[key]}
				values={source}
				onChange={onChange}
				seams={{ renderCell, renderMissingCell, renderChrome }}
			/>
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
