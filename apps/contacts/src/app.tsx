/**
 * Contacts — a standalone convenience surface over the shared `Person/v1`
 * entity space (OQ-CT-1). Live people come ONLY through the one sanctioned
 * reactivity stack (`useVaultEntities`, never a hand-rolled `onChange` loop);
 * edits go through the entities service; the company / related-people refs are
 * the typed `Person.company → Company/v1` / `Person.links` links resolved
 * against the same snapshot (OQ-CT-2). Outside the shell it runs on an
 * in-memory demo set.
 *
 * Layout is the standard two-pane shell: a persistent, resizable left sidebar
 * (search + grouped list) and a detail pane on the right, under ONE shared
 * `.app-header`. Creation goes through the compose popover — an entity is
 * only minted on submit, so there is no abandoned-empty ghost to clean up.
 */

import { YDocProvider, useVaultEntities } from "@brainstorm/react-yjs";
import type { VaultEntity } from "@brainstorm/sdk-types";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { recallLastViewed, rememberLastViewed } from "@brainstorm/sdk/last-viewed";
import { MenuAlign } from "@brainstorm/sdk/menus";
import { NavButtons, type NavHistory, createNavHistory } from "@brainstorm/sdk/nav-history";
import {
	type AnchoredMenuItem,
	type ObjectMenuExtraItem,
	ObjectMenuMoreButton,
	ObjectMenuTrigger,
	openAnchoredMenu,
} from "@brainstorm/sdk/object-menu";
import { readPanelOpen, writePanelOpen } from "@brainstorm/sdk/panel-state";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { Popover } from "@brainstorm/sdk/popover";
import type { EntityTitleSource } from "@brainstorm/sdk/property-ui";
import { useResizable } from "@brainstorm/sdk/resizable";
import { publishTabIdentity } from "@brainstorm/sdk/tab-identity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { plural, t } from "./i18n";
import { useContactsT } from "./i18n-hooks";
import { type ComposeDraft, buildCompanyNameIndex, planCompose } from "./logic/compose";
import { demoEntities } from "./logic/demo";
import { openEntityRef, resolveOpenTarget } from "./logic/open";
import { buildPersonEmailIndex, resolvePersonIdByEmails } from "./logic/person-resolver";
import {
	CONTACTS_GROUPINGS,
	CONTACTS_SORTINGS,
	ContactsGrouping,
	ContactsSorting,
	buildEntityNameIndex,
	personsFromEntities,
	resolveName,
} from "./logic/person-view";
import { type VCardContact, personToVCard } from "./logic/vcard";
import { getContactsResolver } from "./logic/ydoc-resolver";
import { getBrainstorm } from "./runtime";
import { COMPANY_TYPE, PERSON_TYPE, type Person, type VaultEntityLike } from "./types/person";
import { ComposeContact } from "./ui/compose-contact";
import { contactObjectMenuContext } from "./ui/contact-menu";
import { NoSelection } from "./ui/no-selection";
import { type Location, PersonDetail } from "./ui/person-detail";
import { PersonSidebar } from "./ui/person-list";
import { exportContactsToVCard, importContactsFromVCard } from "./ui/vcard-actions";

const SIDEBAR_OPEN_KEY = "contacts:sidebar-open";
const PROPS_OPEN_KEY = "contacts:props-open";
const GROUP_BY_KEY = "contacts:group-by";
const SORT_BY_KEY = "contacts:sort-by";

function locEquals(a: Location, b: Location): boolean {
	return a.id === b.id;
}

function readSidebarOpen(): boolean {
	try {
		return window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";
	} catch {
		return true;
	}
}

function readGroupingPref(): ContactsGrouping {
	try {
		const stored = window.localStorage.getItem(GROUP_BY_KEY);
		const hit = CONTACTS_GROUPINGS.find((g) => g === stored);
		if (hit) return hit;
	} catch {
		// localStorage unavailable — fall through to the default.
	}
	return ContactsGrouping.FirstLetter;
}

function writeGroupingPref(grouping: ContactsGrouping): void {
	try {
		window.localStorage.setItem(GROUP_BY_KEY, grouping);
	} catch {
		// localStorage unavailable (private mode) — the choice still holds for the session.
	}
}

function readSortingPref(): ContactsSorting {
	try {
		const stored = window.localStorage.getItem(SORT_BY_KEY);
		const hit = CONTACTS_SORTINGS.find((s) => s === stored);
		if (hit) return hit;
	} catch {
		// localStorage unavailable — fall through to the default.
	}
	return ContactsSorting.Name;
}

function writeSortingPref(sorting: ContactsSorting): void {
	try {
		window.localStorage.setItem(SORT_BY_KEY, sorting);
	} catch {
		// localStorage unavailable (private mode) — the choice still holds for the session.
	}
}

export function ContactsApp(): ReactElement {
	useContactsT();
	const rt = getBrainstorm();
	const vaultEntitiesSvc = rt?.services?.vaultEntities ?? null;
	const entitiesSvc = rt?.services?.entities ?? null;
	const propertiesSvc = rt?.services?.properties ?? null;
	const intentsSvc = rt?.services?.intents ?? null;
	const filesSvc = rt?.services?.files ?? null;
	const settingsSvc = rt?.services?.settings ?? null;
	const uiNotify = rt?.services?.ui?.notify;
	const notify = useMemo(
		() => (uiNotify ? (message: string) => void uiNotify({ title: message }) : undefined),
		[uiNotify],
	);
	const usingVault = Boolean(vaultEntitiesSvc && entitiesSvc);

	const { entities: vaultEntities } = useVaultEntities(vaultEntitiesSvc);
	const [demo, setDemo] = useState<VaultEntityLike[]>(() => demoEntities());
	// Optimistic overlay of just-created/edited entities (vault mode). A newly
	// created Person/Company is shown immediately rather than waiting for the
	// persisted entity to round-trip back through the live snapshot — a slow or
	// dropped broadcast otherwise makes "New contact" look like it did nothing.
	// Each overlay entry is pruned once the real snapshot carries that id.
	const [optimistic, setOptimistic] = useState<VaultEntityLike[]>([]);

	const base: VaultEntityLike[] = usingVault ? vaultEntities : demo;
	const allEntities = useMemo<VaultEntityLike[]>(() => {
		if (optimistic.length === 0) return base;
		const byId = new Map(base.map((e) => [e.id, e]));
		// Snapshot wins once it carries the id (it's authoritative); otherwise show
		// the optimistic entry.
		const extra = optimistic.filter((o) => !byId.has(o.id));
		return extra.length === 0 ? base : [...base, ...extra];
	}, [base, optimistic]);

	// Prune overlay entries the snapshot has caught up on.
	useEffect(() => {
		const ids = new Set(base.map((e) => e.id));
		setOptimistic((prev) => {
			const next = prev.filter((o) => !ids.has(o.id));
			return next.length === prev.length ? prev : next;
		});
	}, [base]);

	const persons = useMemo(() => personsFromEntities(allEntities), [allEntities]);
	// One `id → name` index per snapshot — the list resolves a company name for
	// every visible row, so an O(N) scan per row would be O(N²).
	const nameIndex = useMemo(() => buildEntityNameIndex(allEntities), [allEntities]);

	// Live title lookup the shared LinkCard picker reads to list + resolve the
	// company / related-people entity-ref candidates (scoped by `allowedTypes`).
	const titleSource = useMemo<EntityTitleSource>(() => {
		const list = allEntities.map(
			(e) =>
				({
					id: e.id,
					type: e.type,
					properties: e.properties,
					createdAt: 0,
					updatedAt: 0,
					deletedAt: (e as Partial<VaultEntity>).deletedAt ?? null,
					ownerAppId: "",
				}) satisfies VaultEntity,
		);
		const titleOf = (e: VaultEntity): string => {
			const name = e.properties.name;
			const title = e.properties.title;
			if (typeof name === "string" && name.trim()) return name.trim();
			if (typeof title === "string" && title.trim()) return title.trim();
			return e.id;
		};
		return {
			subscribe: () => () => undefined,
			snapshotTick: () => list.length,
			list: () => list,
			titleOf: (id) => resolveName(nameIndex, id) ?? undefined,
			displayTitle: titleOf,
		};
	}, [allEntities, nameIndex]);

	const navRef = useRef<NavHistory<Location> | null>(null);
	if (navRef.current === null) {
		navRef.current = createNavHistory<Location>({ initial: { id: null }, equals: locEquals });
	}
	const nav = navRef.current;
	const [location, setLocation] = useState<Location>({ id: null });
	const [query, setQuery] = useState("");
	// Window-scoped (sessionStorage) with a CLOSED default — the shared
	// right-panel convention: a fresh Contacts window opens on the page, not
	// with the inspector already covering it.
	const [showProperties, setShowPropertiesState] = useState<boolean>(() =>
		readPanelOpen(PROPS_OPEN_KEY, false),
	);
	const setShowProperties = useCallback((update: (open: boolean) => boolean) => {
		setShowPropertiesState((open) => {
			const next = update(open);
			writePanelOpen(PROPS_OPEN_KEY, next);
			return next;
		});
	}, []);
	const [sidebarOpen, setSidebarOpen] = useState<boolean>(readSidebarOpen);
	const [grouping, setGrouping] = useState<ContactsGrouping>(readGroupingPref);
	const [sorting, setSorting] = useState<ContactsSorting>(readSortingPref);
	const [composeOpen, setComposeOpen] = useState(false);
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	// When the shell launches Contacts to open a Company (a company link from
	// any app routes here, since Contacts owns the `Company/v1` opener), we land
	// on that company's people rather than the bare list.
	const [companyFilterId, setCompanyFilterId] = useState<string | null>(() => {
		const launch = rt?.launch;
		return launch?.reason === "open-entity" && launch.entityId ? launch.entityId : null;
	});

	const { handleProps, width } = useResizable({
		side: "left",
		defaultWidth: 280,
		min: 220,
		max: 420,
		storageKey: "contacts:sidebar-width",
	});

	const toggleSidebar = useCallback(() => {
		setSidebarOpen((open) => {
			const next = !open;
			try {
				window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(next));
			} catch {
				// localStorage unavailable (private mode) — the toggle still works for the session.
			}
			return next;
		});
	}, []);

	const setGroupingPref = useCallback((next: ContactsGrouping) => {
		writeGroupingPref(next);
		setGrouping(next);
	}, []);

	const setSortingPref = useCallback((next: ContactsSorting) => {
		writeSortingPref(next);
		setSorting(next);
	}, []);

	// `now` is captured once per mount — stable enough for the relative-birthday
	// copy without re-rendering on a timer.
	const now = useRef(Date.now()).current;

	const select = useCallback(
		(id: string) => {
			const loc: Location = { id };
			nav.push(loc);
			setLocation(loc);
		},
		[nav],
	);

	// Resolve the launch target's type once it appears in the snapshot. A
	// Company stays as the people filter; a Person (the shell may also route a
	// Person open through this same app) selects directly and drops the filter.
	useEffect(() => {
		if (!companyFilterId) return;
		const target = allEntities.find((e) => e.id === companyFilterId);
		if (target && target.type === PERSON_TYPE) {
			setCompanyFilterId(null);
			select(companyFilterId);
		}
	}, [companyFilterId, allEntities, select]);

	// Running-window intent push (F-242) — a company / person link dispatches
	// `open` while Contacts is already focused. The launcher focuses the
	// existing window rather than re-mounting, so `rt.launch` does not update;
	// the shell re-emits the open on the `intent` channel, which we resolve
	// here exactly like the launch target. Without this, clicking a company
	// chip from the running app did nothing (the open routed back to a window
	// that ignored it).
	useEffect(() => {
		if (!rt?.on) return;
		const sub = rt.on("intent", (event) => {
			if (event.type !== "intent" || event.intent.verb !== "open") return;
			const entityId = event.intent.payload?.entityId;
			if (typeof entityId !== "string" || entityId === "") return;
			const action = resolveOpenTarget(entityId, allEntities);
			if (action.kind === "select") {
				setCompanyFilterId(null);
				select(action.id);
			} else {
				// A Company (or a target not yet in the snapshot) lands on its
				// people view; clear any open person so the detail pane doesn't
				// mask the landing. The resolver effect above still converts a
				// Person id that materialises late.
				setLocation({ id: null });
				setCompanyFilterId(action.id);
			}
		});
		return () => sub.unsubscribe();
	}, [rt, allEntities, select]);

	// Reopen the contact the user was last viewing when Contacts launches
	// without an explicit target. The id is recalled once (device-local,
	// per-vault), then applied as soon as it resolves to a Person in the live
	// snapshot — so a slow broadcast doesn't lose the restore, and a
	// since-deleted contact (never appears) is dropped silently.
	const pendingRestoreRef = useRef<string | null>(null);
	const restoreRequestedRef = useRef(false);
	useEffect(() => {
		if (restoreRequestedRef.current) return;
		restoreRequestedRef.current = true;
		if (!usingVault || rt?.launch?.reason === "open-entity") return;
		void recallLastViewed(settingsSvc ?? undefined).then((id) => {
			if (id) pendingRestoreRef.current = id;
		});
	}, [usingVault, settingsSvc, rt]);

	useEffect(() => {
		const id = pendingRestoreRef.current;
		if (!id) return;
		if (location.id !== null) {
			pendingRestoreRef.current = null;
			return;
		}
		const target = allEntities.find((e) => e.id === id);
		if (target && target.type === PERSON_TYPE) {
			pendingRestoreRef.current = null;
			select(id);
		}
	}, [allEntities, location.id, select]);

	// Remember the open contact so the next launch lands back here (clearing on
	// the bare list is intentional — that's a location too).
	useEffect(() => {
		if (!usingVault) return;
		void rememberLastViewed(settingsSvc ?? undefined, location.id);
	}, [usingVault, location.id, settingsSvc]);

	const companyFilter = useMemo(() => {
		if (!companyFilterId) return null;
		const target = allEntities.find((e) => e.id === companyFilterId);
		if (!target || target.type !== COMPANY_TYPE) return null;
		const name = resolveName(nameIndex, companyFilterId);
		return { id: companyFilterId, name: name ?? t("company.untitled") };
	}, [companyFilterId, allEntities, nameIndex]);

	const visiblePersons = useMemo(
		() => (companyFilter ? persons.filter((p) => p.companyId === companyFilter.id) : persons),
		[companyFilter, persons],
	);

	const clearCompanyFilter = useCallback(() => setCompanyFilterId(null), []);

	// Create from the compose popover — the entity is minted only on submit,
	// with everything the user entered. A typed company name links an existing
	// Company (case-insensitive) or mints a fresh one, like the vCard path.
	const createContact = useCallback(
		async (draft: ComposeDraft) => {
			const plan = planCompose(draft);
			if (!plan) return;
			const { props, companyName } = plan;
			setComposeOpen(false);
			const existingCompanyId = companyName
				? (buildCompanyNameIndex(allEntities).get(companyName.toLocaleLowerCase()) ?? null)
				: null;
			if (usingVault && entitiesSvc) {
				let companyId = existingCompanyId;
				const overlay: VaultEntityLike[] = [];
				if (!companyId && companyName) {
					const company = await entitiesSvc.create(COMPANY_TYPE, { name: companyName });
					companyId = company.id;
					overlay.push({ id: company.id, type: COMPANY_TYPE, properties: { name: companyName } });
				}
				if (companyId) props.company = companyId;
				const created = await entitiesSvc.create(PERSON_TYPE, props);
				overlay.push({ id: created.id, type: PERSON_TYPE, properties: props });
				// Show the new contact immediately, even if the snapshot broadcast lags.
				setOptimistic((prev) => [...prev, ...overlay]);
				select(created.id);
			} else {
				const id = `demo_${Date.now()}`;
				const additions: VaultEntityLike[] = [];
				let companyId = existingCompanyId;
				if (!companyId && companyName) {
					companyId = `demo_co_${Date.now()}`;
					additions.push({ id: companyId, type: COMPANY_TYPE, properties: { name: companyName } });
				}
				if (companyId) props.company = companyId;
				additions.push({ id, type: PERSON_TYPE, properties: props });
				setDemo((prev) => [...prev, ...additions]);
				select(id);
			}
		},
		[usingVault, entitiesSvc, allEntities, select],
	);

	// Create a brand-new Company and link it to the person in one step — the
	// shared ref picker can only pick EXISTING entities, and nothing else in the
	// founder's toolset mints a Company, so Contacts owns this (write cap added
	// to the manifest). Returns the new id so the caller can reflect it.
	const createCompanyFor = useCallback(
		async (personId: string, rawName: string) => {
			const name = rawName.trim();
			if (!name) return;
			if (usingVault && entitiesSvc) {
				const company = await entitiesSvc.create(COMPANY_TYPE, { name });
				await entitiesSvc.update(personId, { company: company.id });
				setOptimistic((prev) => [
					...prev.map((e) =>
						e.id === personId ? { ...e, properties: { ...e.properties, company: company.id } } : e,
					),
					{ id: company.id, type: COMPANY_TYPE, properties: { name } },
				]);
			} else {
				const id = `demo_co_${Date.now()}`;
				setDemo((prev) => [
					...prev.map((e) =>
						e.id === personId ? { ...e, properties: { ...e.properties, company: id } } : e,
					),
					{ id, type: COMPANY_TYPE, properties: { name } },
				]);
			}
		},
		[usingVault, entitiesSvc],
	);

	const patchPerson = useCallback(
		async (id: string, patch: Record<string, unknown>) => {
			if (usingVault && entitiesSvc) {
				await entitiesSvc.update(id, patch);
				// Reflect the edit on a still-optimistic (not-yet-broadcast) entity.
				setOptimistic((prev) =>
					prev.map((e) => (e.id === id ? { ...e, properties: { ...e.properties, ...patch } } : e)),
				);
			} else {
				setDemo((prev) =>
					prev.map((e) => (e.id === id ? { ...e, properties: { ...e.properties, ...patch } } : e)),
				);
			}
		},
		[usingVault, entitiesSvc],
	);

	const deletePerson = useCallback(
		async (id: string) => {
			if (usingVault && entitiesSvc) {
				await entitiesSvc.delete(id);
				// Drop it from the overlay too, else a not-yet-broadcast contact
				// reappears after delete (the snapshot never carried it to prune it).
				setOptimistic((prev) => prev.filter((e) => e.id !== id));
			} else {
				setDemo((prev) => prev.filter((e) => e.id !== id));
			}
			// Only leave the detail pane if the deleted contact was the open one.
			setLocation((loc) => {
				if (loc.id !== id) return loc;
				nav.reset({ id: null });
				return { id: null };
			});
		},
		[usingVault, entitiesSvc, nav],
	);

	const companyNameOf = useCallback((id: string | null) => resolveName(nameIndex, id), [nameIndex]);

	// Export every visible person as a vCard document (company id → resolved name).
	const exportVCard = useCallback(() => {
		if (!filesSvc) return;
		const contacts: VCardContact[] = persons.map((p) =>
			personToVCard(p, resolveName(nameIndex, p.companyId)),
		);
		void exportContactsToVCard(filesSvc, contacts, notify);
	}, [filesSvc, persons, nameIndex, notify]);

	// Import parsed vCards as Person rows. A card's ORG name is resolved to an
	// existing Company (case-insensitive) or a fresh one is minted — deduped
	// within the batch and against the live snapshot. A card whose email already
	// belongs to a contact is LINKED, not duplicated: OQ-MB-6's resolved
	// position (link-to-existing, never auto-create) applied to the vCard path,
	// so re-importing the same address book is idempotent.
	const importVCard = useCallback(() => {
		if (!filesSvc || !entitiesSvc) return;
		const onImport = async (contacts: VCardContact[]): Promise<void> => {
			const companyByName = buildCompanyNameIndex(allEntities);
			// Email → existing-person index over the live snapshot; grows as this
			// batch creates people so two cards sharing an address don't both land.
			const emailIndex = new Map(buildPersonEmailIndex(allEntities));
			const created: VaultEntityLike[] = [];
			for (const c of contacts) {
				if (resolvePersonIdByEmails(emailIndex, c.emails)) continue;
				let companyId: string | null = null;
				if (c.org) {
					const key = c.org.toLocaleLowerCase();
					companyId = companyByName.get(key) ?? null;
					if (!companyId) {
						const company = await entitiesSvc.create(COMPANY_TYPE, { name: c.org });
						companyId = company.id;
						companyByName.set(key, companyId);
						created.push({ id: company.id, type: COMPANY_TYPE, properties: { name: c.org } });
					}
				}
				const props: Record<string, unknown> = { name: c.name };
				if (c.emails.length > 0) props.email = c.emails;
				if (c.phones.length > 0) props.phone = c.phones;
				if (c.role) props.role = c.role;
				if (c.birthday !== null) props.birthday = c.birthday;
				if (c.anniversary !== null) props.anniversary = c.anniversary;
				if (c.note) props.bio = c.note;
				if (companyId) props.company = companyId;
				const person = await entitiesSvc.create(PERSON_TYPE, props);
				created.push({ id: person.id, type: PERSON_TYPE, properties: props });
				for (const email of c.emails) {
					const emailKey = email.trim().toLowerCase();
					if (emailKey && !emailIndex.has(emailKey)) emailIndex.set(emailKey, person.id);
				}
			}
			if (created.length > 0) setOptimistic((prev) => [...prev, ...created]);
		};
		void importContactsFromVCard(filesSvc, onImport, notify);
	}, [filesSvc, entitiesSvc, allEntities, notify]);

	const activePerson = useMemo(
		() => (location.id ? (persons.find((p) => p.id === location.id) ?? null) : null),
		[location, persons],
	);

	// Label the tab + OS window with the open object's name (the shared
	// tab-identity contract every app follows).
	useEffect(() => {
		publishTabIdentity({
			title: activePerson ? activePerson.name || t("row.noName") : t("app.title"),
		});
	}, [activePerson]);

	const canImportExport = Boolean(filesSvc && entitiesSvc);

	// vCard import / export ride the ⋯ overflow — as the shared object menu's
	// extra items when a contact is open, or a plain anchored menu otherwise.
	const vcardItems = useMemo<ObjectMenuExtraItem[]>(() => {
		if (!canImportExport) return [];
		const noneToExport = persons.length === 0;
		return [
			{ id: "vcard-import", label: t("vcard.import"), icon: IconName.Inbox, run: importVCard },
			{
				id: "vcard-export",
				label: t("vcard.export"),
				icon: IconName.Download,
				run: exportVCard,
				disabled: noneToExport,
				...(noneToExport ? { hint: t("vcard.exportEmpty") } : {}),
			},
		];
	}, [canImportExport, persons.length, importVCard, exportVCard]);

	const menuContextFor = useCallback(
		(person: Person) =>
			contactObjectMenuContext({
				person,
				runtime: rt,
				onRemove: () => setConfirmDeleteId(person.id),
				...(vcardItems.length > 0 ? { extraItems: vcardItems } : {}),
			}),
		[rt, vcardItems],
	);

	const moreRef = useRef<HTMLButtonElement>(null);
	const openListMore = useCallback(() => {
		const button = moreRef.current;
		if (!button) return;
		const items: AnchoredMenuItem[] = vcardItems.map((item) => ({
			label: item.label,
			onSelect: () => void item.run(),
			disabled: item.disabled ?? false,
			...(item.icon ? { icon: item.icon } : {}),
			...(item.hint ? { hint: item.hint } : {}),
		}));
		const r = button.getBoundingClientRect();
		openAnchoredMenu({ x: r.left, y: r.bottom + 4 }, items, {
			menuLabel: t("detail.menu.more"),
			anchor: button,
			align: MenuAlign.End,
		});
	}, [vcardItems]);

	const confirmDeletePerson = confirmDeleteId
		? (persons.find((p) => p.id === confirmDeleteId) ?? null)
		: null;

	const companyName = activePerson ? companyNameOf(activePerson.companyId) : null;

	return (
		<div className="contacts" data-nav-open={String(sidebarOpen)}>
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<NavButtons history={nav} onNavigate={setLocation} />
					{activePerson ? (
						<ObjectMenuTrigger
							className="contacts__header-title-menu"
							moreActionsLabel={t("detail.menu.more")}
							noMoreButton
							context={() => menuContextFor(activePerson)}
						>
							<h1 className="app-header__title">{activePerson.name || t("row.noName")}</h1>
						</ObjectMenuTrigger>
					) : (
						<h1 className="app-header__title">{t("app.title")}</h1>
					)}
				</div>
				<div className="app-header__right">
					<button
						type="button"
						className="contacts-icon-btn"
						data-testid="contacts-new"
						aria-label={t("list.new")}
						data-bs-tooltip={t("list.new")}
						onClick={() => setComposeOpen(true)}
					>
						<Icon name={IconName.Plus} size={18} />
					</button>
					<PanelToggleButton
						side={PanelSide.Left}
						open={sidebarOpen}
						onClick={toggleSidebar}
						labels={{ show: t("sidebar.show"), hide: t("sidebar.hide") }}
						controls="contacts-sidebar"
					/>
					<PanelToggleButton
						side={PanelSide.Right}
						open={showProperties && Boolean(activePerson)}
						onClick={() => setShowProperties((v) => !v)}
						labels={{ show: t("detail.properties.show"), hide: t("detail.properties.hide") }}
						controls="contacts-props"
						disabled={!activePerson}
						{...(activePerson ? {} : { hint: t("detail.properties.disabledHint") })}
					/>
					{activePerson ? (
						<ObjectMenuMoreButton
							moreActionsLabel={t("detail.menu.more")}
							context={() => menuContextFor(activePerson)}
						/>
					) : canImportExport ? (
						<button
							ref={moreRef}
							type="button"
							className="bs-object-menu__more"
							data-testid="contacts-more"
							aria-haspopup="menu"
							aria-label={t("detail.menu.more")}
							data-bs-tooltip={t("detail.menu.more")}
							onClick={openListMore}
						>
							<span className="bs-object-menu__more-dot" />
							<span className="bs-object-menu__more-dot" />
							<span className="bs-object-menu__more-dot" />
						</button>
					) : null}
				</div>
			</header>

			<div className="contacts__body" style={{ ["--contacts-sidebar-width" as string]: `${width}px` }}>
				<PersonSidebar
					persons={visiblePersons}
					query={query}
					now={now}
					demo={!usingVault}
					open={sidebarOpen}
					activeId={location.id}
					companyNameOf={companyNameOf}
					grouping={grouping}
					sorting={sorting}
					menuContextFor={menuContextFor}
					onQueryChange={setQuery}
					onSelect={select}
					onCreate={() => setComposeOpen(true)}
					onSetGrouping={setGroupingPref}
					onSetSorting={setSortingPref}
				/>
				{sidebarOpen && (
					<div className="contacts__resize" aria-label={t("sidebar.resize")} {...handleProps} />
				)}
				<main className="contacts__content">
					{activePerson ? (
						<YDocProvider resolver={getContactsResolver()}>
							<PersonDetail
								key={activePerson.id}
								person={activePerson}
								companyName={companyName}
								now={now}
								properties={propertiesSvc}
								entityTitleSource={titleSource}
								showProperties={showProperties}
								onToggleProperties={() => setShowProperties((v) => !v)}
								onRenamePerson={(name) => void patchPerson(activePerson.id, { name })}
								onPatch={(patch) => void patchPerson(activePerson.id, patch)}
								onCreateCompany={(name) => void createCompanyFor(activePerson.id, name)}
								onOpenCompany={() => {
									if (activePerson.companyId) {
										openEntityRef(intentsSvc, activePerson.companyId, COMPANY_TYPE);
									}
								}}
							/>
						</YDocProvider>
					) : companyFilter ? (
						<div className="contacts__company-landing">
							<button
								type="button"
								className="bs-btn bs-btn--ghost contacts__company-back"
								onClick={clearCompanyFilter}
							>
								<Icon name={IconName.CaretLeft} size={16} />
								<span>{t("company.backToAll")}</span>
							</button>
							<div className="contacts__company-landing-head">
								<div className="contacts__placeholder-avatar" aria-hidden="true">
									<Icon name={IconName.Entity} size={28} />
								</div>
								<h2 className="contacts__company-name">{companyFilter.name}</h2>
								<p className="contacts__company-count">
									{plural(visiblePersons.length, "company.members.one", "company.members.other", {
										count: visiblePersons.length,
									})}
								</p>
							</div>
							{visiblePersons.length === 0 && (
								<p className="contacts__placeholder-blurb">{t("company.empty")}</p>
							)}
						</div>
					) : (
						<NoSelection listOpen={sidebarOpen} onCreate={() => setComposeOpen(true)} />
					)}
				</main>
			</div>

			{composeOpen && (
				<ComposeContact
					onCreate={(draft) => void createContact(draft)}
					onClose={() => setComposeOpen(false)}
				/>
			)}

			{confirmDeletePerson && (
				<Popover
					title={t("delete.confirm.title")}
					onClose={() => setConfirmDeleteId(null)}
					footer={
						<div className="contacts-confirm__actions">
							{/* Fail-safe: the SAFE default (Cancel) takes focus, and there is
							 *  no Enter-to-confirm — a stray Enter must never delete. */}
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
									setConfirmDeleteId(null);
									void deletePerson(confirmDeletePerson.id);
								}}
							>
								{t("delete.confirm.confirm")}
							</button>
						</div>
					}
				>
					<p className="contacts-confirm__body">
						{t("delete.confirm.body", { name: confirmDeletePerson.name || t("row.noName") })}
					</p>
				</Popover>
			)}
		</div>
	);
}
