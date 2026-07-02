/**
 * Theme Editor (React, 9.9.7). You pick a **theme to edit** — fork one of
 * the built-in themes (Default Dark/Light, Midnight, Sepia, High Contrast,
 * Solar) or re-open one of your saved themes — then customise its tokens,
 * icon pack, and typography across four tabs. The edited theme renders into
 * a docked live-preview panel; the editor's own chrome stays on the shell's
 * current theme so the controls remain legible whatever is being edited.
 * Save persists the component entities + the composite `Theme/v1` and wires
 * the references.
 *
 * Outside the shell there is no entities service, so the editor falls back
 * to an in-memory default per the [[preview-drop-pattern]].
 *
 * Reactivity: the saved-theme + installed-icon-pack lists are derived from
 * the live whole-vault snapshot read through the ONE shared stack —
 * `@brainstorm/react-yjs` `useVaultEntities` (which owns the change
 * subscription + coalescing) — never a hand-rolled `onChange → list →
 * setState`.
 */

import { useVaultEntities } from "@brainstorm/react-yjs";
import { openEntity } from "@brainstorm/sdk";
import {
	EMPTY_STYLE_PACK,
	EMPTY_TOKEN_SET,
	type FontRole,
	SYSTEM_TYPOGRAPHY,
	type StylePackDef,
	type ThemeDef,
	ThemeRefKind,
	TokenSetAppearance,
	type TokenSetDef,
	type TypographyDef,
	type TypographyScale,
} from "@brainstorm/sdk-types";
import { setActiveIconPack } from "@brainstorm/sdk/icon";
import { MenuAlign } from "@brainstorm/sdk/menus";
import { openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import { SelectMenu, type SelectMenuOption } from "@brainstorm/sdk/select-menu";
import { typographyCssVars } from "@brainstorm/sdk/typography";
import { ThemeName } from "@brainstorm/tokens";
import {
	type ReactElement,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { type ThemeEditorI18nKey, t } from "./i18n";
import {
	appearanceOfTheme,
	baseVarsForTheme,
	builtinThemes,
	defaultThemeForScheme,
	detectThemeByBackground,
} from "./logic/base-theme";
import {
	type ThemeDependency,
	ThemeSlot,
	builtinFallbackRef,
	missingDependencies,
	themeEntityDependencies,
} from "./logic/dependencies";
import { type InstalledPack, iconPackChoices, selectedChoiceKey } from "./logic/icon-pack-options";
import { hasStylePackCss, setStylePackCss, setStylePackName } from "./logic/style-pack-edit";
import { groupTokens } from "./logic/token-rows";
import { clearOverride, composePreviewVars, setOverride } from "./logic/token-set-edit";
import {
	isSystemTypography,
	seedTypography,
	setFontStack,
	setScale,
	setTypographyName,
} from "./logic/typography-edit";
import { iconPacksFromSnapshot, loadIconPack } from "./storage/icon-pack-repository";
import { type EntitiesService, getBrainstorm } from "./storage/runtime";
import { loadStylePack, saveStylePack } from "./storage/style-pack-repository";
import {
	type SavedTheme,
	loadTheme,
	saveTheme,
	themesFromSnapshot,
} from "./storage/theme-repository";
import { loadTokenSet, saveTokenSet } from "./storage/token-set-repository";
import { loadTypography, saveTypography } from "./storage/typography-repository";
import { DependencyBanner } from "./ui/dependency-banner";
import { IconPackPicker } from "./ui/icon-pack-picker";
import { PreviewPanel } from "./ui/preview-panel";
import { StylePackEditor } from "./ui/style-pack-editor";
import { TokenGrid } from "./ui/token-grid";
import type { Translate } from "./ui/translate";
import { TypographyEditor } from "./ui/typography-editor";

/** Widening adapter — the generic panes take a `(string) => string`
 *  translator; the app's `t` has a narrower literal-key domain. */
const translate: Translate = (key, params) => t(key as ThemeEditorI18nKey, params);

const THEME_LABEL_KEY: Record<ThemeName, ThemeEditorI18nKey> = {
	[ThemeName.DefaultDark]: "theme.defaultDark",
	[ThemeName.DefaultLight]: "theme.defaultLight",
	[ThemeName.Midnight]: "theme.midnight",
	[ThemeName.Sepia]: "theme.sepia",
	[ThemeName.HighContrast]: "theme.highContrast",
	[ThemeName.Solar]: "theme.solar",
	[ThemeName.Forest]: "theme.forest",
	[ThemeName.Nord]: "theme.nord",
	[ThemeName.Aurora]: "theme.aurora",
	[ThemeName.Mint]: "theme.mint",
	[ThemeName.Rose]: "theme.rose",
	[ThemeName.Slate]: "theme.slate",
};

enum EditorTab {
	TokenSet = "token-set",
	IconPack = "icon-pack",
	Typography = "typography",
	StylePack = "style-pack",
}

const TABS: ReadonlyArray<{ tab: EditorTab; key: ThemeEditorI18nKey }> = [
	{ tab: EditorTab.TokenSet, key: "tab.tokenSet" },
	{ tab: EditorTab.IconPack, key: "tab.iconPack" },
	{ tab: EditorTab.Typography, key: "tab.typography" },
	{ tab: EditorTab.StylePack, key: "tab.stylePack" },
];

const EMPTY_PACKS: InstalledPack[] = [];
const EMPTY_THEMES: SavedTheme[] = [];

/** A composite freshly forked from a built-in base — all builtin refs. */
function forkComposite(base: ThemeName, name: string): ThemeDef {
	return {
		name,
		appearance: appearanceOfTheme(base),
		tokenSet: { kind: ThemeRefKind.Builtin, name: "shell/default-light" },
		iconPack: { kind: ThemeRefKind.Builtin, name: "phosphor" },
		typography: { kind: ThemeRefKind.Builtin, name: "system" },
	};
}

function detectBaseTheme(): ThemeName {
	const styles = getComputedStyle(document.documentElement);
	const bg = styles.getPropertyValue("--color-background-primary");
	const matched = detectThemeByBackground(bg);
	if (matched) return matched;
	const scheme = styles.colorScheme?.includes("dark") ?? false;
	return defaultThemeForScheme(scheme);
}

function entitiesService(): EntitiesService | null {
	return getBrainstorm()?.services?.entities ?? null;
}

export function ThemeEditorApp(): ReactElement {
	const [ready, setReady] = useState(false);
	const [baseTheme, setBaseTheme] = useState<ThemeName>(ThemeName.DefaultDark);
	const [theme, setTheme] = useState<ThemeDef>(() => forkComposite(ThemeName.DefaultDark, ""));
	const [themeId, setThemeId] = useState<string | null>(null);
	const [tokenSet, setTokenSet] = useState<TokenSetDef>(() => ({
		...EMPTY_TOKEN_SET,
		appearance: appearanceOfTheme(ThemeName.DefaultDark),
	}));
	const [tokenSetId, setTokenSetId] = useState<string | null>(null);
	const [typography, setTypography] = useState<TypographyDef>(() =>
		seedTypography(SYSTEM_TYPOGRAPHY.name),
	);
	const [typographyId, setTypographyId] = useState<string | null>(null);
	const [stylePack, setStylePack] = useState<StylePackDef>(() => ({ ...EMPTY_STYLE_PACK }));
	const [stylePackId, setStylePackId] = useState<string | null>(null);
	const [missing, setMissing] = useState<ThemeDependency[]>([]);
	const [activeTab, setActiveTab] = useState<EditorTab>(EditorTab.TokenSet);
	const [status, setStatus] = useState<string>(() => t("status.seeded"));

	const previewRef = useRef<HTMLElement>(null);
	const appliedKeys = useRef<Set<string>>(new Set());
	const moreButtonRef = useRef<HTMLButtonElement>(null);
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

	// ── Reactivity: the saved-theme + installed-pack lists read off the live
	// whole-vault snapshot through the ONE shared stack — `@brainstorm/react-yjs`
	// `useVaultEntities` (which owns the change subscription + coalescing). A
	// save here, or a write from another device, re-derives both lists with no
	// hand-rolled `onChange → list → setState` loop.
	const vault = useVaultEntities(ready ? (getBrainstorm()?.services?.vaultEntities ?? null) : null);
	const customThemes = useMemo(
		() => (vault.entities.length > 0 ? themesFromSnapshot(vault.entities) : EMPTY_THEMES),
		[vault],
	);
	const iconPacks = useMemo(
		() => (vault.entities.length > 0 ? iconPacksFromSnapshot(vault.entities) : EMPTY_PACKS),
		[vault],
	);

	const groups = useMemo(
		() => groupTokens(Object.keys(baseVarsForTheme(ThemeName.DefaultDark))),
		[],
	);
	const baseVars = useMemo(() => baseVarsForTheme(baseTheme), [baseTheme]);

	// ── Boot: detect the shell's current theme to seed the base, then mark
	// ready so the live lists bind. The lifecycle `ready` handshake gates this
	// (the runtime hands services over after first paint).
	useEffect(() => {
		const boot = (): void => {
			const detected = detectBaseTheme();
			setBaseTheme(detected);
			setTokenSet({ ...EMPTY_TOKEN_SET, appearance: appearanceOfTheme(detected) });
			setTheme(forkComposite(detected, ""));
			setReady(true);
			setStatus(t("status.forked"));
		};
		const bs = getBrainstorm();
		if (bs?.on) {
			const sub = bs.on("ready", boot);
			return () => sub?.unsubscribe();
		}
		boot();
		return undefined;
	}, []);

	// ── Apply the edited theme (base ∪ overrides ∪ typography) to the preview
	// element ONLY — the editor chrome keeps the shell's theme. Stale vars from
	// a previous render are cleared so reverting an override never ghosts.
	useLayoutEffect(() => {
		const el = previewRef.current;
		if (!el) return;
		const vars = composePreviewVars(baseVars, tokenSet);
		if (!isSystemTypography(typography)) Object.assign(vars, typographyCssVars(typography));
		const next = new Set(Object.keys(vars));
		for (const key of appliedKeys.current) {
			if (!next.has(key)) el.style.removeProperty(key);
		}
		for (const [key, value] of Object.entries(vars)) el.style.setProperty(key, value);
		appliedKeys.current = next;
	}, [baseVars, tokenSet, typography]);

	const choices = useMemo(() => iconPackChoices(iconPacks), [iconPacks]);
	const selectedValue = themeId ? `custom:${themeId}` : `builtin:${baseTheme}`;

	const startFork = useCallback((base: ThemeName): void => {
		setBaseTheme(base);
		setThemeId(null);
		setTokenSetId(null);
		setTokenSet({ ...EMPTY_TOKEN_SET, appearance: appearanceOfTheme(base) });
		setTypographyId(null);
		setTypography(seedTypography(SYSTEM_TYPOGRAPHY.name));
		setStylePackId(null);
		setStylePack({ ...EMPTY_STYLE_PACK });
		setActiveIconPack(null);
		setTheme(forkComposite(base, ""));
		setMissing([]);
		setStatus(t("status.forked"));
	}, []);

	const scanMissing = useCallback(async (forTheme: ThemeDef): Promise<ThemeDependency[]> => {
		const entities = entitiesService();
		if (!entities) return [];
		const deps = themeEntityDependencies(forTheme);
		const present = new Set<string>();
		for (const dep of deps) {
			if (await entities.get(dep.entityId)) present.add(dep.entityId);
		}
		return missingDependencies(deps, present);
	}, []);

	const loadCustom = useCallback(
		async (id: string): Promise<void> => {
			const entities = entitiesService();
			if (!entities) return;
			const loaded = await loadTheme(entities, id);
			if (!loaded) return;
			setThemeId(loaded.id);
			setTheme(loaded.def);
			setBaseTheme(defaultThemeForScheme(loaded.def.appearance === TokenSetAppearance.Dark));

			if (loaded.def.tokenSet.kind === ThemeRefKind.Entity) {
				const loadedSet = await loadTokenSet(entities, loaded.def.tokenSet.entityId);
				setTokenSetId(loadedSet?.id ?? null);
				setTokenSet(loadedSet?.def ?? { ...EMPTY_TOKEN_SET, appearance: loaded.def.appearance });
			} else {
				setTokenSetId(null);
				setTokenSet({ ...EMPTY_TOKEN_SET, appearance: loaded.def.appearance });
			}

			if (loaded.def.typography.kind === ThemeRefKind.Entity) {
				const loadedTypo = await loadTypography(entities, loaded.def.typography.entityId);
				setTypographyId(loadedTypo?.id ?? null);
				setTypography(loadedTypo?.def ?? seedTypography(SYSTEM_TYPOGRAPHY.name));
			} else {
				setTypographyId(null);
				setTypography(seedTypography(SYSTEM_TYPOGRAPHY.name));
			}

			if (loaded.def.stylePack?.kind === ThemeRefKind.Entity) {
				const loadedPack = await loadStylePack(entities, loaded.def.stylePack.entityId);
				setStylePackId(loadedPack?.id ?? null);
				setStylePack(loadedPack?.def ?? { ...EMPTY_STYLE_PACK });
			} else {
				setStylePackId(null);
				setStylePack({ ...EMPTY_STYLE_PACK });
			}

			setActiveIconPack(
				loaded.def.iconPack.kind === ThemeRefKind.Entity
					? await loadIconPack(entities, loaded.def.iconPack.entityId)
					: null,
			);

			setMissing(await scanMissing(loaded.def));
			setStatus(t("status.ready"));
		},
		[scanMissing],
	);

	const onSelectThemeValue = useCallback(
		(value: string): void => {
			if (value.startsWith("builtin:")) startFork(value.slice("builtin:".length) as ThemeName);
			else if (value.startsWith("custom:")) void loadCustom(value.slice("custom:".length));
		},
		[startFork, loadCustom],
	);

	const themeOptions = useMemo<SelectMenuOption[]>(
		() => [
			...builtinThemes().map((option) => ({
				value: `builtin:${option.name}`,
				label: t(THEME_LABEL_KEY[option.name]),
				group: t("selector.builtinGroup"),
			})),
			...customThemes.map((saved) => ({
				value: `custom:${saved.id}`,
				label: saved.name,
				group: t("selector.customGroup"),
			})),
		],
		[customThemes],
	);

	const onResetDependency = useCallback((slot: ThemeSlot): void => {
		const fallback = builtinFallbackRef(slot);
		setTheme((prev) => {
			if (slot === ThemeSlot.TokenSet && fallback) {
				setTokenSetId(null);
				setTokenSet({ ...EMPTY_TOKEN_SET, appearance: prev.appearance });
				return { ...prev, tokenSet: fallback };
			}
			if (slot === ThemeSlot.IconPack && fallback) {
				setActiveIconPack(null);
				return { ...prev, iconPack: fallback };
			}
			if (slot === ThemeSlot.Typography && fallback) {
				setTypographyId(null);
				setTypography(seedTypography(SYSTEM_TYPOGRAPHY.name));
				return { ...prev, typography: fallback };
			}
			const { stylePack: _omit, ...rest } = prev;
			return rest;
		});
		setMissing((prev) => prev.filter((d) => d.slot !== slot));
	}, []);

	const onSelectIconPack = useCallback(
		async (key: string): Promise<void> => {
			const choice = choices.find((c) => c.key === key);
			if (!choice) return;
			setTheme((prev) => ({ ...prev, iconPack: choice.ref }));
			const entities = entitiesService();
			if (choice.builtin) setActiveIconPack(null);
			else if (choice.ref.kind === ThemeRefKind.Entity)
				setActiveIconPack(await loadIconPack(entities, choice.ref.entityId));
		},
		[choices],
	);

	const previewAcrossShell = useCallback(async (): Promise<void> => {
		const themeService = getBrainstorm()?.services?.theme;
		if (!themeService) {
			setStatus(t("status.previewOffline"));
			return;
		}
		const vars = composePreviewVars(baseVarsForTheme(baseTheme), tokenSet);
		if (!isSystemTypography(typography)) Object.assign(vars, typographyCssVars(typography));
		try {
			await themeService.preview({ vars, appearance: appearanceOfTheme(baseTheme) });
			setStatus(t("status.previewing"));
		} catch {
			setStatus(t("status.previewFailed"));
		}
	}, [baseTheme, tokenSet, typography]);

	const openStylePackInCodeEditor = useCallback(async (): Promise<void> => {
		if (!stylePackId) {
			setStatus(t("status.openSaveFirst"));
			return;
		}
		const opened = await openEntity(getBrainstorm(), { entityId: stylePackId });
		setStatus(opened ? t("status.openedInCodeEditor") : t("status.openFailed"));
	}, [stylePackId]);

	const onSave = useCallback(async (): Promise<void> => {
		const entities = entitiesService();
		if (!entities) {
			setStatus(t("status.offline"));
			return;
		}
		setStatus(t("status.saving"));
		try {
			let next: ThemeDef = { ...theme, appearance: appearanceOfTheme(baseTheme) };
			if (next.name.trim().length === 0) {
				next = { ...next, name: `${t(THEME_LABEL_KEY[baseTheme])} (custom)` };
			}

			if (Object.keys(tokenSet.overrides).length > 0) {
				const setName = tokenSet.name.trim().length > 0 ? tokenSet.name : `${next.name} tokens`;
				const namedSet: TokenSetDef = { ...tokenSet, name: setName, appearance: next.appearance };
				const savedSet = await saveTokenSet(entities, namedSet, tokenSetId ?? undefined);
				if (savedSet) {
					setTokenSetId(savedSet.id);
					setTokenSet(namedSet);
					next = { ...next, tokenSet: { kind: ThemeRefKind.Entity, entityId: savedSet.id } };
				}
			} else {
				next = { ...next, tokenSet: { kind: ThemeRefKind.Builtin, name: "shell/default-light" } };
			}

			if (isSystemTypography(typography)) {
				next = { ...next, typography: { kind: ThemeRefKind.Builtin, name: "system" } };
			} else {
				const savedTypo = await saveTypography(entities, typography, typographyId ?? undefined);
				if (savedTypo) {
					setTypographyId(savedTypo.id);
					next = { ...next, typography: { kind: ThemeRefKind.Entity, entityId: savedTypo.id } };
				}
			}

			if (hasStylePackCss(stylePack)) {
				const packName = stylePack.name.trim().length > 0 ? stylePack.name : `${next.name} CSS`;
				const namedPack: StylePackDef = { ...stylePack, name: packName };
				const savedPack = await saveStylePack(entities, namedPack, stylePackId ?? undefined);
				if (savedPack) {
					setStylePackId(savedPack.id);
					setStylePack(namedPack);
					next = { ...next, stylePack: { kind: ThemeRefKind.Entity, entityId: savedPack.id } };
				}
			} else {
				const { stylePack: _omit, ...rest } = next;
				next = rest;
			}

			const saved = await saveTheme(entities, next, themeId ?? undefined);
			if (saved) setThemeId(saved.id);
			setTheme(next);
			setStatus(t("status.saved"));
		} catch (err) {
			// A swallowed save error left "Could not save the theme." undebuggable
			// (F-240) — surface the cause so a real failure leaves a trail.
			console.error("[theme-editor] save failed", err);
			setStatus(t("status.saveFailed"));
		}
	}, [
		theme,
		baseTheme,
		tokenSet,
		tokenSetId,
		typography,
		typographyId,
		stylePack,
		stylePackId,
		themeId,
	]);

	const openMore = useCallback((): void => {
		const anchor = moreButtonRef.current;
		if (!anchor) return;
		const rect = anchor.getBoundingClientRect();
		const items: Array<{ label: string; hint?: string; disabled?: boolean; onSelect: () => void }> =
			[];
		if (getBrainstorm()?.services?.theme) {
			items.push({
				label: t("action.previewShell"),
				hint: t("action.previewShellHint"),
				onSelect: () => void previewAcrossShell(),
			});
		}
		items.push({
			label: t("stylePack.openInCodeEditor"),
			disabled: stylePackId === null,
			...(stylePackId === null ? { hint: t("stylePack.openHintSaveFirst") } : {}),
			onSelect: () => void openStylePackInCodeEditor(),
		});
		openAnchoredMenu({ x: rect.right, y: rect.bottom }, items, {
			menuLabel: t("app.title"),
			anchor,
			align: MenuAlign.End,
		});
	}, [previewAcrossShell, openStylePackInCodeEditor, stylePackId]);

	const onTabKeyDown = (event: React.KeyboardEvent, index: number): void => {
		if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
			event.preventDefault();
			const delta = event.key === "ArrowRight" ? 1 : -1;
			const nextIndex = (index + delta + TABS.length) % TABS.length;
			tabRefs.current[nextIndex]?.focus();
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			const entry = TABS[index];
			if (entry) setActiveTab(entry.tab);
		}
	};

	const pane = ((): ReactElement => {
		switch (activeTab) {
			case EditorTab.IconPack:
				return (
					<IconPackPicker
						choices={choices}
						selectedKey={selectedChoiceKey(choices, theme.iconPack)}
						t={translate}
						onSelect={(key) => void onSelectIconPack(key)}
					/>
				);
			case EditorTab.StylePack:
				return (
					<StylePackEditor
						pack={stylePack}
						t={translate}
						canOpenInCodeEditor={stylePackId !== null}
						onName={(name) => setStylePack((p) => setStylePackName(p, name))}
						onCss={(css) => setStylePack((p) => setStylePackCss(p, css))}
						onOpenInCodeEditor={() => void openStylePackInCodeEditor()}
					/>
				);
			case EditorTab.Typography:
				return (
					<TypographyEditor
						typo={typography}
						t={translate}
						onName={(name) => setTypography((p) => setTypographyName(p, name))}
						onFontStack={(role: FontRole, stack: string) =>
							setTypography((p) => setFontStack(p, role, stack))
						}
						onScale={(scale: TypographyScale) => setTypography((p) => setScale(p, scale))}
					/>
				);
			default:
				return (
					<TokenGrid
						groups={groups}
						baseVars={baseVars}
						set={tokenSet}
						t={translate}
						handlers={{
							onChange: (name, value) => setTokenSet((s) => setOverride(s, name, value)),
							onReset: (name) => setTokenSet((s) => clearOverride(s, name)),
						}}
					/>
				);
		}
	})();

	return (
		<>
			<header className="app-header" data-testid="app-header">
				<div className="app-header__left">
					<h1 className="app-header__title">{t("app.title")}</h1>
				</div>
				<div className="app-header__right">
					<button
						ref={moreButtonRef}
						type="button"
						className="bs-object-menu__more te-header__more"
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
			<main id="app-root">
				<DependencyBanner missing={missing} t={translate} onReset={onResetDependency} />
				<div className="te-layout">
					<div className="te-canvas">
						<div className="te-toolbar">
							<SelectMenu
								className="te-toolbar__select"
								value={selectedValue}
								options={themeOptions}
								onChange={onSelectThemeValue}
								ariaLabel={t("selector.label")}
								placeholder={theme.name}
							/>
							<input
								type="text"
								className="bs-input te-toolbar__name"
								value={theme.name}
								placeholder={t("composite.namePlaceholder")}
								aria-label={t("composite.name")}
								onChange={(e) => setTheme((prev) => ({ ...prev, name: e.target.value }))}
							/>
							<button
								type="button"
								className="bs-btn te-toolbar__save"
								data-bs-primary
								onClick={() => void onSave()}
							>
								<span>{t("action.save")}</span>
							</button>
						</div>
						<p className="te-toolbar__status" role="status">
							{status}
						</p>
						{/* kbn-roles-exempt: tab keyboard handled by the app's hand-rolled Arrow-key onKeyDown (verified working). */}
						<div className="te-tabs" aria-label={t("tabs.region")} role="tablist">
							{TABS.map(({ tab, key }, index) => {
								const active = activeTab === tab;
								return (
									<button
										key={tab}
										type="button"
										role="tab"
										aria-selected={active}
										tabIndex={active ? 0 : -1}
										ref={(el) => {
											tabRefs.current[index] = el;
										}}
										className={active ? "te-tab te-tab--active" : "te-tab"}
										onClick={() => setActiveTab(tab)}
										onKeyDown={(event) => onTabKeyDown(event, index)}
									>
										{t(key)}
									</button>
								);
							})}
						</div>
						{pane}
					</div>
					<PreviewPanel t={translate} previewRef={previewRef} />
				</div>
			</main>
		</>
	);
}
