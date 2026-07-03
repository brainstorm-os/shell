/**
 * Settings → AI panel (11.9). Manages BYO cloud-provider API keys through the
 * privileged dashboard bridge (`window.brainstorm.aiSettings`) — the dashboard
 * is not a sandboxed app, so it uses direct ipcMain, not the broker. The raw
 * key is write-only: we send it on Save and only ever read back a
 * configured/not boolean, never the key itself (11.6 custody). The local model
 * (Ollama) needs no key, so it isn't listed here.
 */

import {
	ANTHROPIC_PROVIDER_ID,
	GEMINI_PROVIDER_ID,
	GLM_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
} from "@brainstorm/sdk-types";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AiAppBudgetView, AiSettingsView, AiUsageWindowView } from "../../preload";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { budgetConsumedFraction, formatCredits, isBudgetExhausted } from "./ai-budget-view";
import { McpServersSection } from "./mcp-panel";
import { SettingRow, SettingSelect } from "./settings-controls";
import "./ai-panel.css";

/** Sentinel select value for "no pinned default" (the built-in local model). */
const AUTO_ROUTING_VALUE = "auto";

/** A managed cloud provider. `monogram` is the single-glyph avatar face; the
 *  per-provider accent is keyed off `id` via CSS `data-provider`. */
type ProviderMeta = {
	id: string;
	nameKey: string;
	hintKey: string;
	monogram: string;
};

/** The cloud providers whose keys this panel manages (mirrors the main-side
 *  `KNOWN_CLOUD_PROVIDER_IDS`). Label/help are i18n; the id is the wire value. */
const CLOUD_PROVIDERS: ReadonlyArray<ProviderMeta> = [
	{
		id: ANTHROPIC_PROVIDER_ID,
		nameKey: "shell.settings.ai.anthropic.name",
		hintKey: "shell.settings.ai.anthropic.hint",
		monogram: "A",
	},
	{
		id: OPENAI_PROVIDER_ID,
		nameKey: "shell.settings.ai.openai.name",
		hintKey: "shell.settings.ai.openai.hint",
		monogram: "O",
	},
	{
		id: GLM_PROVIDER_ID,
		nameKey: "shell.settings.ai.glm.name",
		hintKey: "shell.settings.ai.glm.hint",
		monogram: "z",
	},
	{
		id: MISTRAL_PROVIDER_ID,
		nameKey: "shell.settings.ai.mistral.name",
		hintKey: "shell.settings.ai.mistral.hint",
		monogram: "M",
	},
	{
		id: GEMINI_PROVIDER_ID,
		nameKey: "shell.settings.ai.gemini.name",
		hintKey: "shell.settings.ai.gemini.hint",
		monogram: "G",
	},
];

/** A provider tile in the grid: monogram avatar + name + a key-status dot.
 *  Clicking opens the credential popover. */
function ProviderTile({
	provider,
	configured,
	onOpen,
}: { provider: ProviderMeta; configured: boolean; onOpen: () => void }) {
	return (
		<button
			type="button"
			className="settings__ai-tile"
			data-testid={`ai-provider-${provider.id}`}
			data-provider={provider.id}
			data-configured={configured}
			onClick={onOpen}
			title={t(provider.nameKey)}
		>
			<span className="settings__ai-avatar" aria-hidden="true">
				{provider.monogram}
				<span className="settings__ai-dot" />
			</span>
			<span className="settings__ai-tile-name">{t(provider.nameKey)}</span>
			<span className="settings__ai-tile-status">
				{configured ? t("shell.settings.ai.statusConfigured") : t("shell.settings.ai.statusUnset")}
			</span>
		</button>
	);
}

/** The credential editor, shown in the shared modal popover when a tile is
 *  picked. The key is write-only: typed in, saved, never read back. */
function ProviderKeyPopover({
	provider,
	configured,
	onClose,
	onChanged,
}: {
	provider: ProviderMeta;
	configured: boolean;
	onClose: () => void;
	onChanged: () => void | Promise<void>;
}) {
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();

	const save = async () => {
		if (draft.trim().length === 0) return;
		setBusy(true);
		try {
			if (await window.brainstorm.aiSettings.setProviderKey(provider.id, draft.trim())) {
				await onChanged();
				onClose();
			}
		} finally {
			setBusy(false);
		}
	};

	const clear = async () => {
		setBusy(true);
		try {
			await window.brainstorm.aiSettings.clearProviderKey(provider.id);
			await onChanged();
			onClose();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Popover
			title={t(provider.nameKey)}
			onClose={onClose}
			size={PopoverSize.Small}
			bodyPadding={PopoverBodyPadding.Comfortable}
			fitContent
			initialFocusRef={inputRef}
			testId={`ai-key-popover-${provider.id}`}
			footer={
				<>
					{configured && (
						<Button
							variant={ButtonVariant.Ghost}
							danger
							size={ButtonSize.Sm}
							className="popover__footer-lead"
							onClick={() => void clear()}
							disabled={busy}
						>
							{t("shell.settings.ai.clear")}
						</Button>
					)}
					<Button
						variant={ButtonVariant.Primary}
						size={ButtonSize.Sm}
						onClick={() => void save()}
						disabled={busy || draft.trim().length === 0}
					>
						{t("shell.settings.ai.save")}
					</Button>
				</>
			}
		>
			<form
				className="settings__ai-key-form"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<div className="settings__ai-key-id" data-provider={provider.id} data-configured={configured}>
					<span className="settings__ai-avatar" aria-hidden="true">
						{provider.monogram}
						<span className="settings__ai-dot" />
					</span>
					<span className="settings__ai-key-status-pill">
						{configured ? t("shell.settings.ai.statusConfigured") : t("shell.settings.ai.statusUnset")}
					</span>
				</div>
				<p className="settings__hint">{t(provider.hintKey)}</p>
				<label className="settings__ai-key-label" htmlFor={inputId}>
					{t("shell.settings.ai.keyLabel")}
				</label>
				<input
					id={inputId}
					ref={inputRef}
					className="settings__input"
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={draft}
					placeholder={
						configured ? t("shell.settings.ai.replacePlaceholder") : t("shell.settings.ai.keyPlaceholder")
					}
					onChange={(e) => setDraft(e.target.value)}
					aria-label={t("shell.settings.ai.keyLabel")}
				/>
			</form>
		</Popover>
	);
}

/** The provider grid: one tile per cloud provider, each opening a credential
 *  popover. Key-configured state is loaded once and refreshed after a change so
 *  every tile's status dot stays live. */
function ProviderGrid() {
	const [configured, setConfigured] = useState<Record<string, boolean>>({});
	const [openId, setOpenId] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		const entries = await Promise.all(
			CLOUD_PROVIDERS.map(
				async (p) => [p.id, await window.brainstorm.aiSettings.hasProviderKey(p.id)] as const,
			),
		);
		setConfigured(Object.fromEntries(entries));
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const open = CLOUD_PROVIDERS.find((p) => p.id === openId) ?? null;

	return (
		<div className="settings__field" data-testid="ai-providers">
			<div className="settings__ai-grid">
				{CLOUD_PROVIDERS.map((p) => (
					<ProviderTile
						key={p.id}
						provider={p}
						configured={configured[p.id] ?? false}
						onOpen={() => setOpenId(p.id)}
					/>
				))}
			</div>
			{open && (
				<ProviderKeyPopover
					provider={open}
					configured={configured[open.id] ?? false}
					onClose={() => setOpenId(null)}
					onChanged={refresh}
				/>
			)}
		</div>
	);
}

type UsageRow = AiUsageWindowView["apps"][number];

/** 11.9 — the default-provider routing picker. `null` (Automatic) keeps the
 *  built-in local model; a cloud choice routes there (and fails closed if its
 *  key isn't set — the rows above show that). */
function RoutingSection({
	settings,
	onChange,
}: { settings: AiSettingsView | null; onChange: (providerId: string | null) => void }) {
	const value = settings?.defaultProvider ?? AUTO_ROUTING_VALUE;
	const options = [
		{ value: AUTO_ROUTING_VALUE, label: t("shell.settings.ai.routingAuto") },
		...CLOUD_PROVIDERS.map((p) => ({ value: p.id, label: t(p.nameKey) })),
	];
	return (
		<div className="settings__field" data-testid="ai-routing">
			<SettingRow
				title={t("shell.settings.ai.routingTitle")}
				description={t("shell.settings.ai.routingHint")}
				control={
					<SettingSelect
						value={value}
						options={options}
						ariaLabel={t("shell.settings.ai.routingTitle")}
						onChange={(next) => onChange(next === AUTO_ROUTING_VALUE ? null : next)}
					/>
				}
			/>
		</div>
	);
}

/** The budget cell's face: tokens and/or credits ceilings, or "No budget". */
function budgetLabel(budget: AiAppBudgetView | undefined): string {
	if (!budget || (!budget.maxTokens && !budget.maxCredits)) {
		return t("shell.settings.ai.budgetNone");
	}
	const parts: string[] = [];
	if (budget.maxTokens) {
		parts.push(t("shell.settings.ai.budgetCurrent", { count: budget.maxTokens }));
	}
	if (budget.maxCredits) {
		parts.push(t("shell.settings.ai.budgetCurrentCredits", { count: budget.maxCredits }));
	}
	return parts.join(" · ");
}

/** One app's row: 30-day usage stat (if any) + the current budget, opening the
 *  budget editor popover when picked (mirrors the provider-tile → key-popover
 *  pattern so the section stays a calm read-only list, not a grid of live
 *  inputs). An exhausted budget (14.8 — the broker is refusing this app's AI
 *  calls) shows a distinct badge. */
function BudgetRow({
	appId,
	usage,
	budget,
	onOpen,
}: {
	appId: string;
	usage: UsageRow | undefined;
	budget: AiAppBudgetView | undefined;
	onOpen: () => void;
}) {
	const exhausted = isBudgetExhausted(usage, budget);
	const consumed = budgetConsumedFraction(usage, budget);
	return (
		<li className="settings__ai-usage-row">
			<button
				type="button"
				className="settings__ai-usage-trigger"
				data-testid={`ai-budget-${appId}`}
				data-exhausted={exhausted}
				onClick={onOpen}
			>
				<span className="settings__ai-usage-app">{appId}</span>
				{usage && (
					<span className="settings__ai-usage-stat">
						{t("shell.settings.ai.usageCalls", { count: usage.calls })} ·{" "}
						{t("shell.settings.ai.usageTokens", { count: usage.totalTokens })}
						{usage.creditsMicro > 0 && (
							<> · {t("shell.settings.ai.usageCredits", { credits: formatCredits(usage.creditsMicro) })}</>
						)}
					</span>
				)}
				{exhausted && (
					<span className="settings__ai-budget-exhausted">{t("shell.settings.ai.budgetExhausted")}</span>
				)}
				<span
					className="settings__ai-budget-value"
					data-set={Boolean(budget?.maxTokens || budget?.maxCredits)}
					title={t("shell.settings.ai.budgetEdit")}
				>
					{consumed !== null && !exhausted && (
						<span className="settings__ai-budget-consumed" aria-hidden="true">
							{Math.round(consumed * 100)}%
						</span>
					)}
					{budgetLabel(budget)}
				</span>
			</button>
		</li>
	);
}

/** Parse one budget input: empty = no cap on that unit; a positive integer
 *  otherwise (anything else is invalid). */
function parseBudgetDraft(draft: string): number | undefined | null {
	if (draft.trim().length === 0) return undefined;
	const parsed = Number.parseInt(draft, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return parsed;
}

/** The per-app budget editor (14.8): a rolling 30-day token and/or credit
 *  ceiling, shown in the shared popover. Clearing both fields clears the
 *  budget (= unlimited). */
function BudgetPopover({
	appId,
	budget,
	onClose,
	onSet,
}: {
	appId: string;
	budget: AiAppBudgetView | undefined;
	onClose: () => void;
	onSet: (appId: string, budget: AiAppBudgetView) => void;
}) {
	const hasBudget = Boolean(budget?.maxTokens || budget?.maxCredits);
	const [tokensDraft, setTokensDraft] = useState(budget?.maxTokens ? String(budget.maxTokens) : "");
	const [creditsDraft, setCreditsDraft] = useState(
		budget?.maxCredits ? String(budget.maxCredits) : "",
	);
	const inputRef = useRef<HTMLInputElement>(null);
	const tokensId = useId();
	const creditsId = useId();
	const tokens = parseBudgetDraft(tokensDraft);
	const credits = parseBudgetDraft(creditsDraft);
	const valid =
		tokens !== null && credits !== null && (tokens !== undefined || credits !== undefined);

	const save = () => {
		if (!valid) return;
		onSet(appId, {
			...(tokens !== undefined ? { maxTokens: tokens } : {}),
			...(credits !== undefined ? { maxCredits: credits } : {}),
		});
		onClose();
	};
	const clear = () => {
		onSet(appId, {});
		onClose();
	};

	return (
		<Popover
			title={appId}
			onClose={onClose}
			size={PopoverSize.Small}
			bodyPadding={PopoverBodyPadding.Comfortable}
			fitContent
			initialFocusRef={inputRef}
			testId={`ai-budget-popover-${appId}`}
			footer={
				<>
					{hasBudget && (
						<Button
							variant={ButtonVariant.Ghost}
							danger
							size={ButtonSize.Sm}
							className="popover__footer-lead"
							onClick={clear}
						>
							{t("shell.settings.ai.budgetClear")}
						</Button>
					)}
					<Button variant={ButtonVariant.Primary} size={ButtonSize.Sm} onClick={save} disabled={!valid}>
						{t("shell.settings.ai.budgetSet")}
					</Button>
				</>
			}
		>
			<form
				className="settings__ai-key-form"
				onSubmit={(e) => {
					e.preventDefault();
					save();
				}}
			>
				<p className="settings__hint">{t("shell.settings.ai.budgetHint")}</p>
				<label className="settings__ai-key-label" htmlFor={tokensId}>
					{t("shell.settings.ai.budgetUnit")}
				</label>
				<input
					id={tokensId}
					ref={inputRef}
					className="settings__input"
					type="number"
					min={0}
					inputMode="numeric"
					value={tokensDraft}
					placeholder={t("shell.settings.ai.budgetPlaceholder")}
					onChange={(e) => setTokensDraft(e.target.value)}
					aria-label={`${appId} ${t("shell.settings.ai.budgetUnit")}`}
				/>
				<label className="settings__ai-key-label" htmlFor={creditsId}>
					{t("shell.settings.ai.budgetCreditsUnit")}
				</label>
				<input
					id={creditsId}
					className="settings__input"
					type="number"
					min={0}
					inputMode="numeric"
					value={creditsDraft}
					placeholder={t("shell.settings.ai.budgetPlaceholder")}
					onChange={(e) => setCreditsDraft(e.target.value)}
					aria-label={`${appId} ${t("shell.settings.ai.budgetCreditsUnit")}`}
				/>
			</form>
		</Popover>
	);
}

/** 30-day usage accounting (14.8) + per-app budgets. Rows are the union of
 *  apps that have made AI calls in the window and apps that carry a budget. */
function UsageAndBudgetsSection({
	usage,
	settings,
	onSetBudget,
}: {
	usage: readonly UsageRow[];
	settings: AiSettingsView | null;
	onSetBudget: (appId: string, budget: AiAppBudgetView) => void;
}) {
	const [openAppId, setOpenAppId] = useState<string | null>(null);
	const budgets = settings?.appBudgets ?? {};
	const appIds = [...new Set([...usage.map((u) => u.appId), ...Object.keys(budgets)])].sort();
	if (appIds.length === 0) return null; // nothing to budget or report yet

	const usageById = new Map(usage.map((u) => [u.appId, u]));
	return (
		<div className="settings__field" data-testid="ai-budgets">
			<div className="settings__field-head">
				<span className="settings__field-label">{t("shell.settings.ai.budgetTitle")}</span>
				<span className="settings__ai-usage-window">{t("shell.settings.ai.usageWindow")}</span>
			</div>
			<p className="settings__hint">{t("shell.settings.ai.budgetHint")}</p>
			<ul className="settings__ai-usage-list">
				{appIds.map((appId) => (
					<BudgetRow
						key={appId}
						appId={appId}
						usage={usageById.get(appId)}
						budget={budgets[appId]}
						onOpen={() => setOpenAppId(appId)}
					/>
				))}
			</ul>
			{openAppId !== null && (
				<BudgetPopover
					appId={openAppId}
					budget={budgets[openAppId]}
					onClose={() => setOpenAppId(null)}
					onSet={onSetBudget}
				/>
			)}
		</div>
	);
}

export function AiPanel() {
	const [usage, setUsage] = useState<readonly UsageRow[]>([]);
	const [settings, setSettings] = useState<AiSettingsView | null>(null);

	useEffect(() => {
		// Guard against a version-skewed preload (dev HMR reloads the renderer
		// but not the Electron preload until a full restart). A missing optional
		// bridge method must degrade, never crash the whole Settings panel.
		const bridge = window.brainstorm.aiSettings;
		let live = true;
		if (typeof bridge?.usage === "function") {
			// A stale pre-14.8 preload returns a bare array; the current shape is
			// { windowMs, apps } — accept both so HMR skew degrades gracefully.
			void bridge.usage().then((u) => {
				if (!live) return;
				setUsage(Array.isArray(u) ? [] : (u?.apps ?? []));
			});
		}
		if (typeof bridge?.getSettings === "function") {
			void bridge.getSettings().then((s) => live && setSettings(s));
		}
		return () => {
			live = false;
		};
	}, []);

	const setDefaultProvider = useCallback((providerId: string | null) => {
		void window.brainstorm.aiSettings
			.setDefaultProvider?.(providerId)
			.then((s) => s && setSettings(s));
	}, []);

	const setBudget = useCallback((appId: string, budget: AiAppBudgetView) => {
		void window.brainstorm.aiSettings.setAppBudget?.(appId, budget).then((s) => s && setSettings(s));
	}, []);

	return (
		<section className="settings__section">
			<h4 className="settings__section-title">{t("shell.settings.ai.title")}</h4>
			<p className="settings__hint">{t("shell.settings.ai.intro")}</p>
			<ProviderGrid />
			<RoutingSection settings={settings} onChange={setDefaultProvider} />
			<McpServersSection />
			<UsageAndBudgetsSection usage={usage} settings={settings} onSetBudget={setBudget} />
		</section>
	);
}
