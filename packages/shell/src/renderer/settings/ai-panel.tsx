/**
 * Settings → AI panel (11.9). Manages BYO cloud-provider API keys through the
 * privileged dashboard bridge (`window.brainstorm.aiSettings`) — the dashboard
 * is not a sandboxed app, so it uses direct ipcMain, not the broker. The raw
 * key is write-only: we send it on Save and only ever read back a
 * configured/not boolean, never the key itself (11.6 custody). The local model
 * (Ollama) needs no key; its tile edits the endpoint + model instead.
 *
 * Agent-14 — custom OpenAI-compatible endpoints (with an OpenRouter preset):
 * name, base URL, default model, optional key. Adding one is the user's
 * consent to egress there; the request still rides the network broker. The
 * URL policy is the same pure `checkEndpointUrl` main enforces, run here only
 * to explain a refusal before Save.
 */

import {
	ANTHROPIC_PROVIDER_ID,
	GEMINI_PROVIDER_ID,
	GLM_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	OLLAMA_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
	SOLHEIM_PROVIDER_ID,
} from "@brainstorm-os/sdk-types";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { checkEndpointUrl } from "../../main/ai/endpoint-url";
import type {
	AiAppBudgetView,
	AiCustomEndpointView,
	AiSettingsView,
	AiUsageWindowView,
} from "../../preload";
import {
	CustomEndpointError,
	CustomEndpointPreset,
	EndpointUrlError,
	OLLAMA_DEFAULT_ENDPOINT,
	OLLAMA_DEFAULT_MODEL,
	OllamaSettingsError,
	PRESET_BASE_URL,
} from "../../shared/ai-endpoints";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { TextField } from "../ui/text-field";
import { AgentActivitySection } from "./agent-activity-section";
import { budgetConsumedFraction, formatCredits, isBudgetExhausted } from "./ai-budget-view";
import { McpServersSection } from "./mcp-panel";
import { SettingRow, SettingSelect } from "./settings-controls";
import "./ai-panel.css";

/** Sentinel select value for "no pinned default" (the built-in local model). */
const AUTO_ROUTING_VALUE = "auto";

/** A managed cloud provider. `monogram` is the single-glyph avatar face; the
 *  per-provider accent is keyed off `id` via CSS `data-provider`.
 *  `tileNameKey` is optional — when set, the grid tile uses the shorter label
 *  (F-416: drop parentheticals that truncate mid-word on fixed-width tiles)
 *  while the credential dialog keeps the full `nameKey`. */
type ProviderMeta = {
	id: string;
	nameKey: string;
	tileNameKey?: string;
	hintKey: string;
	monogram: string;
};

/** The cloud providers whose keys this panel manages (mirrors the main-side
 *  `KNOWN_CLOUD_PROVIDER_IDS`). Label/help are i18n; the id is the wire value. */
const CLOUD_PROVIDERS: ReadonlyArray<ProviderMeta> = [
	{
		id: ANTHROPIC_PROVIDER_ID,
		nameKey: "shell.settings.ai.anthropic.name",
		tileNameKey: "shell.settings.ai.anthropic.tile",
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
	{
		id: SOLHEIM_PROVIDER_ID,
		nameKey: "shell.settings.ai.solheim.name",
		hintKey: "shell.settings.ai.solheim.hint",
		monogram: "S",
	},
];

/** A provider tile in the grid: monogram avatar + name + a key-status dot.
 *  Clicking opens the credential popover. */
function ProviderTile({
	provider,
	configured,
	statusLabel,
	onOpen,
}: { provider: ProviderMeta; configured: boolean; statusLabel?: string; onOpen: () => void }) {
	const tileLabel = t(provider.tileNameKey ?? provider.nameKey);
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
			<span className="settings__ai-tile-name">{tileLabel}</span>
			<span className="settings__ai-tile-status">
				{statusLabel ??
					(configured ? t("shell.settings.ai.statusConfigured") : t("shell.settings.ai.statusUnset"))}
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
							size={ButtonSize.Md}
							className="popover__footer-lead"
							onClick={() => void clear()}
							disabled={busy}
						>
							{t("shell.settings.ai.clear")}
						</Button>
					)}
					<Button
						variant={ButtonVariant.Primary}
						size={ButtonSize.Md}
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
				<TextField
					id={inputId}
					ref={inputRef}
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={draft}
					placeholder={
						configured ? t("shell.settings.ai.replacePlaceholder") : t("shell.settings.ai.keyPlaceholder")
					}
					onChange={setDraft}
					aria-label={t("shell.settings.ai.keyLabel")}
				/>
			</form>
		</Popover>
	);
}

/** The provider grid: one tile per cloud provider, each opening a credential
 *  popover. Key-configured state is loaded once and refreshed after a change so
 *  every tile's status dot stays live. */
function ProviderGrid({
	settings,
	onSettings,
}: { settings: AiSettingsView | null; onSettings: (next: AiSettingsView) => void }) {
	const [configured, setConfigured] = useState<Record<string, boolean>>({});
	const [openId, setOpenId] = useState<string | null>(null);
	const [ollamaOpen, setOllamaOpen] = useState(false);
	const ollamaCustomised = Boolean(settings?.ollama?.endpoint || settings?.ollama?.model);

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
				<ProviderTile
					provider={OLLAMA_META}
					configured={ollamaCustomised}
					statusLabel={
						ollamaCustomised
							? t("shell.settings.ai.statusCustomised")
							: t("shell.settings.ai.statusDefault")
					}
					onOpen={() => setOllamaOpen(true)}
				/>
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
			{ollamaOpen && (
				<OllamaPopover settings={settings} onClose={() => setOllamaOpen(false)} onSaved={onSettings} />
			)}
		</div>
	);
}

const OLLAMA_META: ProviderMeta = {
	id: OLLAMA_PROVIDER_ID,
	nameKey: "shell.settings.ai.ollama.name",
	tileNameKey: "shell.settings.ai.ollama.tile",
	hintKey: "shell.settings.ai.ollama.hint",
	monogram: "L",
};

const URL_ERROR_KEY: Record<EndpointUrlError, string> = {
	[EndpointUrlError.Malformed]: "shell.settings.ai.url.malformed",
	[EndpointUrlError.Scheme]: "shell.settings.ai.url.scheme",
	[EndpointUrlError.Credentials]: "shell.settings.ai.url.credentials",
	[EndpointUrlError.QueryOrFragment]: "shell.settings.ai.url.queryOrFragment",
	[EndpointUrlError.InsecurePublic]: "shell.settings.ai.url.insecurePublic",
	[EndpointUrlError.BlockedPort]: "shell.settings.ai.url.blockedPort",
	[EndpointUrlError.TooLong]: "shell.settings.ai.url.tooLong",
};

const ENDPOINT_ERROR_KEY: Record<
	Exclude<CustomEndpointError, CustomEndpointError.InvalidUrl>,
	string
> = {
	[CustomEndpointError.InvalidName]: "shell.settings.ai.endpoints.error.name",
	[CustomEndpointError.InvalidModel]: "shell.settings.ai.endpoints.error.model",
	[CustomEndpointError.TooMany]: "shell.settings.ai.endpoints.error.tooMany",
	[CustomEndpointError.NotFound]: "shell.settings.ai.endpoints.error.notFound",
};

/** Live URL feedback for a draft: the refusal reason, or the cleartext-LAN
 *  note, or nothing. Empty drafts say nothing (the field is just unfilled). */
function urlFeedback(draft: string): { error?: string; hint?: string } {
	if (draft.trim().length === 0) return {};
	const check = checkEndpointUrl(draft);
	if (!check.ok) return { error: t(URL_ERROR_KEY[check.error]) };
	if (check.privateHost && check.url.startsWith("http:")) {
		return { hint: t("shell.settings.ai.endpoints.lanNote") };
	}
	return {};
}

/** Ollama endpoint + model. Empty fields fall back to the env / built-in
 *  default, shown as placeholders. */
function OllamaPopover({
	settings,
	onClose,
	onSaved,
}: {
	settings: AiSettingsView | null;
	onClose: () => void;
	onSaved: (next: AiSettingsView) => void;
}) {
	const [endpoint, setEndpoint] = useState(settings?.ollama?.endpoint ?? "");
	const [model, setModel] = useState(settings?.ollama?.model ?? "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const feedback = urlFeedback(endpoint);

	const submit = async (next: { endpoint: string; model: string }) => {
		setBusy(true);
		try {
			const result = await window.brainstorm.aiSettings.setOllama?.(next);
			if (!result) return;
			if (result.ok) {
				onSaved(result.settings);
				onClose();
			} else if (result.error === OllamaSettingsError.InvalidUrl && result.urlError) {
				setError(t(URL_ERROR_KEY[result.urlError]));
			} else {
				setError(t("shell.settings.ai.endpoints.error.model"));
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<Popover
			title={t(OLLAMA_META.nameKey)}
			onClose={onClose}
			size={PopoverSize.Small}
			bodyPadding={PopoverBodyPadding.Comfortable}
			fitContent
			initialFocusRef={inputRef}
			testId="ai-ollama-popover"
			footer={
				<>
					<Button
						variant={ButtonVariant.Ghost}
						size={ButtonSize.Md}
						className="popover__footer-lead"
						onClick={() => void submit({ endpoint: "", model: "" })}
						disabled={busy}
					>
						{t("shell.settings.ai.ollama.reset")}
					</Button>
					<Button
						variant={ButtonVariant.Primary}
						size={ButtonSize.Md}
						onClick={() => void submit({ endpoint, model })}
						disabled={busy || Boolean(feedback.error)}
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
					if (!feedback.error) void submit({ endpoint, model });
				}}
			>
				<p className="settings__hint">{t(OLLAMA_META.hintKey)}</p>
				<TextField
					ref={inputRef}
					label={t("shell.settings.ai.ollama.endpointLabel")}
					type="url"
					spellCheck={false}
					value={endpoint}
					placeholder={OLLAMA_DEFAULT_ENDPOINT}
					onChange={(v) => {
						setEndpoint(v);
						setError(null);
					}}
					{...(feedback.error ? { error: feedback.error } : {})}
					{...(feedback.hint ? { hint: feedback.hint } : {})}
					data-testid="ai-ollama-endpoint"
				/>
				<TextField
					label={t("shell.settings.ai.ollama.modelLabel")}
					spellCheck={false}
					value={model}
					placeholder={OLLAMA_DEFAULT_MODEL}
					onChange={(v) => {
						setModel(v);
						setError(null);
					}}
					data-testid="ai-ollama-model"
				/>
				{error && <p className="settings__error">{error}</p>}
			</form>
		</Popover>
	);
}

/** Host part of a stored base URL, for the endpoint row's detail line. */
function endpointHost(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}

/** Add / edit one custom endpoint. The key is write-only like the built-in
 *  providers': typed, saved through `setProviderKey`, never read back. */
function EndpointPopover({
	endpoint,
	preset,
	onClose,
	onSaved,
}: {
	endpoint: AiCustomEndpointView | null;
	preset: CustomEndpointPreset;
	onClose: () => void;
	onSaved: (next: AiSettingsView) => void;
}) {
	const bridge = window.brainstorm.aiSettings;
	const [name, setName] = useState(
		endpoint?.name ?? (preset === CustomEndpointPreset.OpenRouter ? "OpenRouter" : ""),
	);
	const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? PRESET_BASE_URL[preset] ?? "");
	const [model, setModel] = useState(endpoint?.defaultModel ?? "");
	const [key, setKey] = useState("");
	const [hasKey, setHasKey] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const feedback = urlFeedback(baseUrl);
	const isOpenRouter = (endpoint?.preset ?? preset) === CustomEndpointPreset.OpenRouter;

	useEffect(() => {
		if (!endpoint) return;
		let live = true;
		void bridge.hasProviderKey(endpoint.id).then((has) => live && setHasKey(has));
		return () => {
			live = false;
		};
	}, [bridge, endpoint]);

	const canSave =
		!busy &&
		name.trim().length > 0 &&
		model.trim().length > 0 &&
		baseUrl.trim().length > 0 &&
		!feedback.error;

	const save = async () => {
		if (!canSave) return;
		setBusy(true);
		try {
			const result = await bridge.upsertEndpoint?.({
				...(endpoint ? { id: endpoint.id } : {}),
				name,
				baseUrl,
				defaultModel: model,
				preset: endpoint?.preset ?? preset,
			});
			if (!result) return;
			if (!result.ok) {
				setError(
					result.error === CustomEndpointError.InvalidUrl
						? t(URL_ERROR_KEY[result.urlError ?? EndpointUrlError.Malformed])
						: t(ENDPOINT_ERROR_KEY[result.error]),
				);
				return;
			}
			if (key.trim().length > 0) await bridge.setProviderKey(result.endpoint.id, key.trim());
			onSaved(result.settings);
			onClose();
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		if (!endpoint) return;
		setBusy(true);
		try {
			const next = await bridge.removeEndpoint?.(endpoint.id);
			if (next) onSaved(next);
			onClose();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Popover
			title={endpoint ? endpoint.name : t("shell.settings.ai.endpoints.newTitle")}
			onClose={onClose}
			size={PopoverSize.Small}
			bodyPadding={PopoverBodyPadding.Comfortable}
			fitContent
			initialFocusRef={inputRef}
			testId="ai-endpoint-popover"
			footer={
				<>
					{endpoint && (
						<Button
							variant={ButtonVariant.Ghost}
							danger
							size={ButtonSize.Md}
							className="popover__footer-lead"
							onClick={() => void remove()}
							disabled={busy}
						>
							{t("shell.settings.ai.endpoints.remove")}
						</Button>
					)}
					<Button
						variant={ButtonVariant.Primary}
						size={ButtonSize.Md}
						onClick={() => void save()}
						disabled={!canSave}
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
				<p className="settings__hint">{t("shell.settings.ai.endpoints.hint")}</p>
				<TextField
					ref={inputRef}
					label={t("shell.settings.ai.endpoints.nameLabel")}
					value={name}
					maxLength={64}
					placeholder={t("shell.settings.ai.endpoints.namePlaceholder")}
					onChange={setName}
					data-testid="ai-endpoint-name"
				/>
				<TextField
					label={t("shell.settings.ai.endpoints.urlLabel")}
					type="url"
					spellCheck={false}
					value={baseUrl}
					placeholder={t("shell.settings.ai.endpoints.urlPlaceholder")}
					onChange={(v) => {
						setBaseUrl(v);
						setError(null);
					}}
					{...(feedback.error ? { error: feedback.error } : {})}
					{...(feedback.hint ? { hint: feedback.hint } : {})}
					data-testid="ai-endpoint-url"
				/>
				<TextField
					label={t("shell.settings.ai.endpoints.modelLabel")}
					spellCheck={false}
					value={model}
					maxLength={200}
					placeholder={t("shell.settings.ai.endpoints.modelPlaceholder")}
					onChange={(v) => {
						setModel(v);
						setError(null);
					}}
					{...(isOpenRouter ? { hint: t("shell.settings.ai.endpoints.openRouterHint") } : {})}
					data-testid="ai-endpoint-model"
				/>
				<TextField
					label={t("shell.settings.ai.endpoints.keyLabel")}
					type="password"
					autoComplete="off"
					spellCheck={false}
					value={key}
					placeholder={
						hasKey ? t("shell.settings.ai.replacePlaceholder") : t("shell.settings.ai.keyPlaceholder")
					}
					onChange={setKey}
					hint={t("shell.settings.ai.endpoints.keyHint")}
					data-testid="ai-endpoint-key"
				/>
				{error && <p className="settings__error">{error}</p>}
			</form>
		</Popover>
	);
}

/** The editor target: an existing endpoint, or a new one from a preset. */
type EndpointEditTarget =
	| { kind: EndpointEditKind.Edit; endpoint: AiCustomEndpointView }
	| { kind: EndpointEditKind.New; preset: CustomEndpointPreset };

enum EndpointEditKind {
	Edit = "edit",
	New = "new",
}

/** Agent-14 — the custom endpoint list + the add affordances. */
function CustomEndpointsSection({
	settings,
	onSettings,
}: { settings: AiSettingsView | null; onSettings: (next: AiSettingsView) => void }) {
	const [target, setTarget] = useState<EndpointEditTarget | null>(null);
	const endpoints = settings?.customEndpoints ?? [];
	return (
		<div className="settings__field" data-testid="ai-endpoints">
			<div className="settings__field-head">
				<span className="settings__field-label">{t("shell.settings.ai.endpoints.title")}</span>
			</div>
			<p className="settings__hint">{t("shell.settings.ai.endpoints.hint")}</p>
			{endpoints.length === 0 ? (
				<p className="settings__hint">{t("shell.settings.ai.endpoints.empty")}</p>
			) : (
				<ul className="settings__ai-usage-list">
					{endpoints.map((e) => (
						<li key={e.id} className="settings__ai-usage-row">
							<button
								type="button"
								className="settings__ai-usage-trigger"
								data-testid={`ai-endpoint-${e.id}`}
								onClick={() => setTarget({ kind: EndpointEditKind.Edit, endpoint: e })}
							>
								<span className="settings__ai-usage-app">{e.name}</span>
								<span className="settings__ai-usage-stat">
									{t("shell.settings.ai.endpoints.rowDetail", {
										host: endpointHost(e.baseUrl),
										model: e.defaultModel,
									})}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
			<div className="settings__ai-endpoint-actions">
				<Button
					variant={ButtonVariant.Neutral}
					size={ButtonSize.Md}
					onClick={() => setTarget({ kind: EndpointEditKind.New, preset: CustomEndpointPreset.Generic })}
					data-testid="ai-endpoint-add"
				>
					{t("shell.settings.ai.endpoints.add")}
				</Button>
				<Button
					variant={ButtonVariant.Neutral}
					size={ButtonSize.Md}
					onClick={() =>
						setTarget({ kind: EndpointEditKind.New, preset: CustomEndpointPreset.OpenRouter })
					}
					data-testid="ai-endpoint-add-openrouter"
				>
					{t("shell.settings.ai.endpoints.addOpenRouter")}
				</Button>
			</div>
			{target && (
				<EndpointPopover
					endpoint={target.kind === EndpointEditKind.Edit ? target.endpoint : null}
					preset={target.kind === EndpointEditKind.Edit ? target.endpoint.preset : target.preset}
					onClose={() => setTarget(null)}
					onSaved={onSettings}
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
		{ value: OLLAMA_PROVIDER_ID, label: t(OLLAMA_META.nameKey) },
		...CLOUD_PROVIDERS.map((p) => ({ value: p.id, label: t(p.nameKey) })),
		...(settings?.customEndpoints ?? []).map((e) => ({ value: e.id, label: e.name })),
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
							size={ButtonSize.Md}
							className="popover__footer-lead"
							onClick={clear}
						>
							{t("shell.settings.ai.budgetClear")}
						</Button>
					)}
					<Button variant={ButtonVariant.Primary} size={ButtonSize.Md} onClick={save} disabled={!valid}>
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
				<TextField
					id={tokensId}
					ref={inputRef}
					type="number"
					min={0}
					inputMode="numeric"
					value={tokensDraft}
					placeholder={t("shell.settings.ai.budgetPlaceholder")}
					onChange={setTokensDraft}
					aria-label={`${appId} ${t("shell.settings.ai.budgetUnit")}`}
				/>
				<label className="settings__ai-key-label" htmlFor={creditsId}>
					{t("shell.settings.ai.budgetCreditsUnit")}
				</label>
				<TextField
					id={creditsId}
					type="number"
					min={0}
					inputMode="numeric"
					value={creditsDraft}
					placeholder={t("shell.settings.ai.budgetPlaceholder")}
					onChange={setCreditsDraft}
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
			<ProviderGrid settings={settings} onSettings={setSettings} />
			<CustomEndpointsSection settings={settings} onSettings={setSettings} />
			<RoutingSection settings={settings} onChange={setDefaultProvider} />
			<McpServersSection />
			<UsageAndBudgetsSection usage={usage} settings={settings} onSetBudget={setBudget} />
			{/* Agent-12d — the vault-wide agent activity view rides beside the
			    usage panel (doc 77 §Surfaces #3). */}
			<AgentActivitySection />
		</section>
	);
}
