/**
 * Settings → Privacy → Network panel (Net-1f).
 *
 * Surfaces the per-vault network egress audit:
 *   - Active proxy section with per-vault override editor (segmented
 *     mode picker → conditional fields per mode).
 *   - Privacy mode segmented control (Off / On / Allowlist / Manual) +
 *     editable allowlist host-pattern list.
 *   - Per-app egress (last 7 days) with byte totals, top hosts, revoke.
 *   - Recent requests over the rotated audit log (24h, virtualized).
 *   - Blocked requests (collapsed by default; same shape + reason col).
 *   - Compact preview-cache row with Clear-cache action.
 *   - Placeholder card for the future embed-providers list (Stage 9).
 *
 * Privileged: every read flows through `window.brainstorm.network.*`,
 * which is wired only in the dashboard preload (apps see nothing). The
 * panel auto-refreshes on `vault:network-settings:changed` so a flip in
 * one window propagates without polling.
 *
 * Conventions:
 *   - Every label flows through `t(key)`.
 *   - Popovers / confirms route via the shared `<Popover>` / `confirm`.
 *   - Recent + Blocked share a `<RequestsTable>` to avoid copy-paste
 *     (DRY at the second copy per CLAUDE.md).
 *   - Per-app + Recent are row-virtualized via `@tanstack/react-virtual`.
 *   - Outline-on-border focus mirrors `feedback_focus_outline_replaces_border`.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import {
	type ChangeEvent,
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	CrashPayload,
	CrashPendingSummary,
	CrashSubmissionResult,
} from "../../feedback-wire-types";
import { CrashKind } from "../../feedback-wire-types";
import type {
	NetworkAuditRecord,
	NetworkBrokerState,
	NetworkCacheStats,
	NetworkPerAppSummary,
	NetworkProxyConfig,
	NetworkProxyEndpoint,
	VaultNetworkSettings,
} from "../../network-wire-types";
import {
	EffectiveProxyKind,
	NetworkAuditOutcome,
	NetworkPrivacyMode,
	NetworkProxyMode,
} from "../../network-wire-types";
import type { InstalledApp } from "../../preload";
import { AppIcon } from "../dashboard/app-icon";
import { FeedbackDialog } from "../feedback/feedback-dialog";
import { formatBytes, formatRelative as formatRelativeShared } from "../format/relative-time";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ConfirmVariant, confirm } from "../ui/confirm";
import { Icon, IconName } from "../ui/icon";
import { IconButton } from "../ui/icon-button";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { Segmented } from "../ui/segmented";
import { Select, TextField, TextFieldSize } from "../ui/text-field";
import { isPublicBeta } from "@brainstorm/sdk/analytics";
import { BrowserPrivacyPanel } from "./browser-privacy-panel";
import "./network-egress-panel.css";

const RECENT_ROW_HEIGHT = 36;
const PER_APP_ROW_HEIGHT = 88;

/** Doc-38 §Network panel "Recent requests — capped to 1000 entries". */
const RECENT_DEFAULT_LIMIT = 1000;

/** Built-in privacy-strict detector signal — surfaced as a hint above
 *  the segmented control. Avoid re-reading the same logic main-side;
 *  rely on the broker-state response carrying it later, but for v1 we
 *  cheaply infer from the cachedVaultPath via the existing vault
 *  context.
 *
 *  Note: the runtime detection lives main-side; the renderer just shows
 *  the hint when the default would be Off AND the user is currently On
 *  (the most useful UX cue, per doc-38 §User control). */

type LoadState = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

export function NetworkEgressPanel() {
	const [load, setLoad] = useState<LoadState>({ kind: "loading" });
	const [brokerState, setBrokerState] = useState<NetworkBrokerState | null>(null);
	const [recent, setRecent] = useState<readonly NetworkAuditRecord[]>([]);
	const [blocked, setBlocked] = useState<readonly NetworkAuditRecord[]>([]);
	const [perApp, setPerApp] = useState<readonly NetworkPerAppSummary[]>([]);
	const [cacheStats, setCacheStats] = useState<NetworkCacheStats | null>(null);
	const [installed, setInstalled] = useState<readonly InstalledApp[]>([]);
	const [hostFilter, setHostFilter] = useState("");
	const [appFilter, setAppFilter] = useState<string>("__all__");
	const [editingProxy, setEditingProxy] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const [state, recentRows, blockedRows, perAppRows, apps] = await Promise.all([
				window.brainstorm.network.brokerState(),
				window.brainstorm.network.audit.recent({ limit: RECENT_DEFAULT_LIMIT }),
				window.brainstorm.network.audit.blocked({ limit: RECENT_DEFAULT_LIMIT }),
				window.brainstorm.network.audit.perAppSummary(),
				window.brainstorm.apps.listInstalled(),
			]);
			setBrokerState(state);
			setRecent(recentRows);
			setBlocked(blockedRows);
			setPerApp(perAppRows);
			setCacheStats(state.previewCacheStats);
			setInstalled(apps);
			setLoad({ kind: "ready" });
		} catch (error) {
			setLoad({
				kind: "error",
				message: error instanceof Error ? error.message : t("shell.settings.network.loadFailed"),
			});
		}
	}, []);

	useEffect(() => {
		void refresh();
		const off = window.brainstorm.network.settings.on(() => {
			void refresh();
		});
		return off;
	}, [refresh]);

	const appNameById = useMemo<Map<string, string>>(() => {
		const map = new Map<string, string>();
		for (const app of installed) map.set(app.id, app.name);
		return map;
	}, [installed]);

	const appIconById = useMemo<Map<string, string | null>>(() => {
		const map = new Map<string, string | null>();
		for (const app of installed) {
			map.set(app.id, app.hasIcon ? window.brainstorm.apps.iconUrl(app.id, app.version) : null);
		}
		return map;
	}, [installed]);

	if (load.kind === "loading") {
		return (
			<section className="settings__section">
				<p className="settings__placeholder">{t("shell.settings.network.loading")}</p>
			</section>
		);
	}

	if (load.kind === "error" || !brokerState) {
		return (
			<section className="settings__section">
				<p className="settings__error" role="alert">
					{load.kind === "error" ? load.message : t("shell.settings.network.loadFailed")}
				</p>
				<Button onClick={() => void refresh()} size={ButtonSize.Sm}>
					{t("shell.settings.network.retry")}
				</Button>
			</section>
		);
	}

	const settings: VaultNetworkSettings = {
		privacy: brokerState.privacy,
		proxyOverride: brokerState.proxy.mode === NetworkProxyMode.System ? null : brokerState.proxy,
	};

	return (
		<section className="network-egress" data-testid="network-egress-panel">
			<p className="settings__section-summary">{t("shell.settings.network.summary")}</p>

			<ActiveProxySection state={brokerState} onEdit={() => setEditingProxy(true)} />

			<PrivacySection
				privacy={brokerState.privacy}
				proxyOverride={settings.proxyOverride}
				onChange={async (nextSettings) => {
					await window.brainstorm.network.settings.set(nextSettings);
				}}
			/>

			<PerAppSection
				rows={perApp}
				appNameById={appNameById}
				appIconById={appIconById}
				onRevoke={async (appId) => {
					const appName = appNameById.get(appId) ?? appId;
					const confirmed = await confirm({
						title: t("shell.settings.network.perApp.revokeConfirm.title", { appId: appName }),
						body: t("shell.settings.network.perApp.revokeConfirm.body"),
						confirmLabel: t("shell.settings.network.perApp.revoke"),
						confirmVariant: ConfirmVariant.Destructive,
					});
					if (!confirmed) return;
					await Promise.all([
						window.brainstorm.ledger.revoke(appId, "network.fetch", null),
						window.brainstorm.ledger.revoke(appId, "network.fetch.private", null),
						window.brainstorm.ledger.revoke(appId, "network.preview", null),
					]);
					await refresh();
				}}
			/>

			<AutomationEgressSection />

			<RecentSection
				title={t("shell.settings.network.recent.title")}
				rows={recent}
				appNameById={appNameById}
				appIconById={appIconById}
				hostFilter={hostFilter}
				onHostFilter={setHostFilter}
				appFilter={appFilter}
				onAppFilter={setAppFilter}
				onExport={() => {
					exportAuditRecords(recent);
				}}
			/>

			<BlockedSection
				rows={blocked}
				appNameById={appNameById}
				appIconById={appIconById}
				hostFilter={hostFilter}
				appFilter={appFilter}
			/>

			<BrowserPrivacyPanel />

			<PreviewCacheSection
				stats={cacheStats ?? brokerState.previewCacheStats}
				onClear={async () => {
					const confirmed = await confirm({
						title: t("shell.settings.network.cache.clearConfirm.title"),
						body: t("shell.settings.network.cache.clearConfirm.body"),
						confirmLabel: t("shell.settings.network.cache.clearConfirm.confirm"),
						confirmVariant: ConfirmVariant.Destructive,
					});
					if (!confirmed) return;
					await window.brainstorm.network.cache.clear();
					await refresh();
				}}
			/>

			<EmbedProvidersPlaceholder />

			<AnalyticsBetaSection />

			<FeedbackSection />

			{editingProxy && (
				<ProxyEditorPopover
					initial={brokerState.proxy}
					hasOverride={settings.proxyOverride !== null}
					onClose={() => setEditingProxy(false)}
					onSave={async (next) => {
						const nextSettings: VaultNetworkSettings = {
							privacy: brokerState.privacy,
							proxyOverride: next,
						};
						await window.brainstorm.network.settings.set(nextSettings);
						setEditingProxy(false);
					}}
				/>
			)}
		</section>
	);
}

// ---------------------------------------------------------------------
// Section: Active proxy
// ---------------------------------------------------------------------

function ActiveProxySection({
	state,
	onEdit,
}: {
	state: NetworkBrokerState;
	onEdit: () => void;
}) {
	const modeLabel = proxyModeLabel(state.proxy.mode);
	return (
		<div className="network-egress__group" data-testid="network-egress-proxy">
			<div className="network-egress__group-header">
				<h4 className="network-egress__group-title">{t("shell.settings.network.proxy.title")}</h4>
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Sm}
					onClick={onEdit}
					data-testid="network-egress-proxy-edit"
				>
					{t("shell.settings.network.proxy.edit")}
				</Button>
			</div>
			<div className="network-egress__row">
				<span className="network-egress__pill">{modeLabel}</span>
				<span className="network-egress__resolved">{resolvedProxyHint(state.resolvedProxyKind)}</span>
			</div>
			{state.proxy.mode === NetworkProxyMode.System && (
				<p className="network-egress__hint">{t("shell.settings.network.proxy.systemNote")}</p>
			)}
			{state.proxy.mode === NetworkProxyMode.Manual && <ManualProxyDetails proxy={state.proxy} />}
			{state.proxy.mode === NetworkProxyMode.Pac && (
				<p className="network-egress__hint" title={state.proxy.pacUrl}>
					{t("shell.settings.network.proxy.pacUrl")}: {state.proxy.pacUrl}
				</p>
			)}
		</div>
	);
}

function ManualProxyDetails({
	proxy,
}: {
	proxy: NetworkProxyConfig & { mode: NetworkProxyMode.Manual };
}) {
	const rows: ReadonlyArray<{ label: string; endpoint: NetworkProxyEndpoint | undefined }> = [
		{ label: t("shell.settings.network.proxy.endpoint.http"), endpoint: proxy.httpProxy },
		{ label: t("shell.settings.network.proxy.endpoint.https"), endpoint: proxy.httpsProxy },
		{ label: t("shell.settings.network.proxy.endpoint.socks5"), endpoint: proxy.socks5Proxy },
	];
	return (
		<div className="network-egress__manual">
			{rows.map((row) => (
				<div key={row.label} className="network-egress__row">
					<span className="network-egress__label">{row.label}</span>
					<span className="network-egress__value">
						{row.endpoint ? `${row.endpoint.host}:${row.endpoint.port}` : "—"}
					</span>
				</div>
			))}
			<div className="network-egress__row">
				<span className="network-egress__label">{t("shell.settings.network.proxy.noProxy")}</span>
				<span className="network-egress__value">
					{proxy.noProxy.length === 0
						? t("shell.settings.network.proxy.noProxy.none")
						: proxy.noProxy.join(", ")}
				</span>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------
// Proxy editor popover
// ---------------------------------------------------------------------

type ProxyEditorState = {
	mode: NetworkProxyMode;
	httpHost: string;
	httpPort: string;
	httpsHost: string;
	httpsPort: string;
	socks5Host: string;
	socks5Port: string;
	noProxy: string;
	pacUrl: string;
};

function proxyToEditorState(config: NetworkProxyConfig): ProxyEditorState {
	const base: ProxyEditorState = {
		mode: config.mode,
		httpHost: "",
		httpPort: "",
		httpsHost: "",
		httpsPort: "",
		socks5Host: "",
		socks5Port: "",
		noProxy: "",
		pacUrl: "",
	};
	if (config.mode === NetworkProxyMode.Manual) {
		if (config.httpProxy) {
			base.httpHost = config.httpProxy.host;
			base.httpPort = String(config.httpProxy.port);
		}
		if (config.httpsProxy) {
			base.httpsHost = config.httpsProxy.host;
			base.httpsPort = String(config.httpsProxy.port);
		}
		if (config.socks5Proxy) {
			base.socks5Host = config.socks5Proxy.host;
			base.socks5Port = String(config.socks5Proxy.port);
		}
		base.noProxy = config.noProxy.join(", ");
	}
	if (config.mode === NetworkProxyMode.Pac) {
		base.pacUrl = config.pacUrl;
	}
	return base;
}

function editorStateToProxy(state: ProxyEditorState): NetworkProxyConfig | { error: string } {
	if (state.mode === NetworkProxyMode.Direct) {
		return { mode: NetworkProxyMode.Direct };
	}
	if (state.mode === NetworkProxyMode.System) {
		return { mode: NetworkProxyMode.System };
	}
	if (state.mode === NetworkProxyMode.Pac) {
		const trimmed = state.pacUrl.trim();
		if (trimmed.length === 0) {
			return { error: t("shell.settings.network.proxy.editor.invalid") };
		}
		return { mode: NetworkProxyMode.Pac, pacUrl: trimmed };
	}
	const endpoints: Pick<
		Extract<NetworkProxyConfig, { mode: NetworkProxyMode.Manual }>,
		"httpProxy" | "httpsProxy" | "socks5Proxy"
	> = {};
	const httpRow = parseEndpoint(state.httpHost, state.httpPort);
	if (httpRow === "invalid") {
		return { error: t("shell.settings.network.proxy.editor.invalid") };
	}
	if (httpRow) endpoints.httpProxy = httpRow;
	const httpsRow = parseEndpoint(state.httpsHost, state.httpsPort);
	if (httpsRow === "invalid") {
		return { error: t("shell.settings.network.proxy.editor.invalid") };
	}
	if (httpsRow) endpoints.httpsProxy = httpsRow;
	const socks5Row = parseEndpoint(state.socks5Host, state.socks5Port);
	if (socks5Row === "invalid") {
		return { error: t("shell.settings.network.proxy.editor.invalid") };
	}
	if (socks5Row) endpoints.socks5Proxy = socks5Row;
	const noProxy = state.noProxy
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	return { mode: NetworkProxyMode.Manual, noProxy, ...endpoints };
}

function parseEndpoint(host: string, port: string): NetworkProxyEndpoint | null | "invalid" {
	const h = host.trim();
	const p = port.trim();
	if (h.length === 0 && p.length === 0) return null;
	if (h.length === 0 || p.length === 0) return "invalid";
	const portNum = Number.parseInt(p, 10);
	if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return "invalid";
	return { host: h, port: portNum };
}

function ProxyEditorPopover({
	initial,
	hasOverride,
	onClose,
	onSave,
}: {
	initial: NetworkProxyConfig;
	hasOverride: boolean;
	onClose: () => void;
	onSave: (next: NetworkProxyConfig | null) => Promise<void>;
}) {
	const [state, setState] = useState<ProxyEditorState>(() => proxyToEditorState(initial));
	const [overrideOn, setOverrideOn] = useState(hasOverride);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);
		if (!overrideOn) {
			setSaving(true);
			try {
				await onSave(null);
			} catch (e) {
				setError(e instanceof Error ? e.message : t("shell.settings.network.proxy.editor.invalid"));
			} finally {
				setSaving(false);
			}
			return;
		}
		const next = editorStateToProxy(state);
		if ("error" in next) {
			setError(next.error);
			return;
		}
		setSaving(true);
		try {
			await onSave(next);
		} catch (e) {
			setError(e instanceof Error ? e.message : t("shell.settings.network.proxy.editor.invalid"));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Popover
			title={t("shell.settings.network.proxy.editor.title")}
			onClose={onClose}
			size={PopoverSize.Medium}
			bodyPadding={PopoverBodyPadding.Comfortable}
			testId="network-egress-proxy-editor"
		>
			<form className="network-egress__editor" onSubmit={onSubmit}>
				<Checkbox
					checked={overrideOn}
					onChange={setOverrideOn}
					label={t("shell.settings.network.proxy.useOverride")}
				/>
				<fieldset disabled={!overrideOn} className="network-egress__fieldset">
					<Select
						label={t("shell.settings.network.proxy.editor.modeLabel")}
						size={TextFieldSize.Sm}
						value={state.mode}
						onChange={(next) => setState((s) => ({ ...s, mode: next as NetworkProxyMode }))}
						options={[
							{ value: NetworkProxyMode.System, label: t("shell.settings.network.proxy.mode.system") },
							{ value: NetworkProxyMode.Direct, label: t("shell.settings.network.proxy.mode.direct") },
							{ value: NetworkProxyMode.Manual, label: t("shell.settings.network.proxy.mode.manual") },
							{ value: NetworkProxyMode.Pac, label: t("shell.settings.network.proxy.mode.pac") },
						]}
					/>
					{state.mode === NetworkProxyMode.Manual && (
						<>
							<ManualEndpointRow
								label={t("shell.settings.network.proxy.endpoint.http")}
								host={state.httpHost}
								port={state.httpPort}
								onHost={(v) => setState((s) => ({ ...s, httpHost: v }))}
								onPort={(v) => setState((s) => ({ ...s, httpPort: v }))}
							/>
							<ManualEndpointRow
								label={t("shell.settings.network.proxy.endpoint.https")}
								host={state.httpsHost}
								port={state.httpsPort}
								onHost={(v) => setState((s) => ({ ...s, httpsHost: v }))}
								onPort={(v) => setState((s) => ({ ...s, httpsPort: v }))}
							/>
							<ManualEndpointRow
								label={t("shell.settings.network.proxy.endpoint.socks5")}
								host={state.socks5Host}
								port={state.socks5Port}
								onHost={(v) => setState((s) => ({ ...s, socks5Host: v }))}
								onPort={(v) => setState((s) => ({ ...s, socks5Port: v }))}
							/>
							<TextField
								label={t("shell.settings.network.proxy.editor.noProxyLabel")}
								size={TextFieldSize.Sm}
								value={state.noProxy}
								placeholder="localhost, .internal, 10.0.0.0/8"
								onChange={(next) => setState((s) => ({ ...s, noProxy: next }))}
								hint={t("shell.settings.network.proxy.editor.noProxyHint")}
							/>
						</>
					)}
					{state.mode === NetworkProxyMode.Pac && (
						<TextField
							label={t("shell.settings.network.proxy.editor.pacLabel")}
							size={TextFieldSize.Sm}
							type="url"
							value={state.pacUrl}
							placeholder="https://example.com/proxy.pac"
							onChange={(next) => setState((s) => ({ ...s, pacUrl: next }))}
							hint={t("shell.settings.network.proxy.editor.pacHint")}
						/>
					)}
				</fieldset>
				{error && (
					<p className="settings__error" role="alert">
						{error}
					</p>
				)}
				<div className="network-egress__editor-footer">
					<Button variant={ButtonVariant.Ghost} size={ButtonSize.Sm} onClick={onClose} type="button">
						{t("shell.settings.network.proxy.editor.cancel")}
					</Button>
					<Button variant={ButtonVariant.Primary} size={ButtonSize.Sm} loading={saving} type="submit">
						{t("shell.settings.network.proxy.editor.save")}
					</Button>
				</div>
			</form>
		</Popover>
	);
}

function ManualEndpointRow({
	label,
	host,
	port,
	onHost,
	onPort,
}: {
	label: string;
	host: string;
	port: string;
	onHost: (next: string) => void;
	onPort: (next: string) => void;
}) {
	return (
		<div className="network-egress__endpoint-row">
			<span className="network-egress__field network-egress__field--label">{label}</span>
			<TextField
				size={TextFieldSize.Sm}
				value={host}
				onChange={onHost}
				placeholder={t("shell.settings.network.proxy.editor.hostLabel")}
				aria-label={`${label} ${t("shell.settings.network.proxy.editor.hostLabel")}`}
			/>
			<TextField
				size={TextFieldSize.Sm}
				value={port}
				onChange={onPort}
				placeholder={t("shell.settings.network.proxy.editor.portLabel")}
				aria-label={`${label} ${t("shell.settings.network.proxy.editor.portLabel")}`}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------
// Section: Privacy mode
// ---------------------------------------------------------------------

function PrivacySection({
	privacy,
	proxyOverride,
	onChange,
}: {
	privacy: NetworkBrokerState["privacy"];
	proxyOverride: VaultNetworkSettings["proxyOverride"];
	onChange: (next: VaultNetworkSettings) => Promise<void>;
}) {
	const setPrivacy = async (next: NetworkBrokerState["privacy"]) => {
		await onChange({ privacy: next, proxyOverride });
	};
	return (
		<div className="network-egress__group" data-testid="network-egress-privacy">
			<h4 className="network-egress__group-title">{t("shell.settings.network.privacy.title")}</h4>
			<Segmented
				value={privacy.mode}
				onChange={(next) => {
					void setPrivacy(buildPrivacy(next, privacy));
				}}
				aria-label={t("shell.settings.network.privacy.title")}
				options={PRIVACY_MODE_ORDER.map((mode) => ({
					value: mode,
					label: t(privacyModeLabelKey(mode)),
					testId: `network-egress-privacy-${mode}`,
				}))}
			/>
			{privacy.mode === NetworkPrivacyMode.Allowlist && (
				<AllowlistEditor
					hosts={privacy.hosts}
					onChange={(nextHosts) => {
						void setPrivacy({ mode: NetworkPrivacyMode.Allowlist, hosts: nextHosts });
					}}
				/>
			)}
		</div>
	);
}

const PRIVACY_MODE_ORDER: readonly NetworkPrivacyMode[] = [
	NetworkPrivacyMode.Off,
	NetworkPrivacyMode.On,
	NetworkPrivacyMode.Allowlist,
	NetworkPrivacyMode.Manual,
];

function privacyModeLabelKey(mode: NetworkPrivacyMode): string {
	switch (mode) {
		case NetworkPrivacyMode.Off:
			return "shell.settings.network.privacy.mode.off";
		case NetworkPrivacyMode.On:
			return "shell.settings.network.privacy.mode.on";
		case NetworkPrivacyMode.Allowlist:
			return "shell.settings.network.privacy.mode.allowlist";
		case NetworkPrivacyMode.Manual:
			return "shell.settings.network.privacy.mode.manual";
	}
}

function buildPrivacy(
	mode: NetworkPrivacyMode,
	current: NetworkBrokerState["privacy"],
): NetworkBrokerState["privacy"] {
	if (mode === NetworkPrivacyMode.Allowlist) {
		const hosts = current.mode === NetworkPrivacyMode.Allowlist ? current.hosts : [];
		return { mode: NetworkPrivacyMode.Allowlist, hosts };
	}
	if (mode === NetworkPrivacyMode.Off) return { mode: NetworkPrivacyMode.Off };
	if (mode === NetworkPrivacyMode.On) return { mode: NetworkPrivacyMode.On };
	return { mode: NetworkPrivacyMode.Manual };
}

function AllowlistEditor({
	hosts,
	onChange,
}: {
	hosts: readonly string[];
	onChange: (next: readonly string[]) => void;
}) {
	const [input, setInput] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const add = () => {
		const trimmed = input.trim();
		if (trimmed.length === 0) return;
		if (hosts.includes(trimmed)) {
			setInput("");
			return;
		}
		onChange([...hosts, trimmed]);
		setInput("");
		inputRef.current?.focus();
	};
	return (
		<div className="network-egress__allowlist" data-testid="network-egress-allowlist">
			<h5 className="network-egress__subtitle">
				{t("shell.settings.network.privacy.allowlist.title")}
			</h5>
			<p className="network-egress__hint">{t("shell.settings.network.privacy.allowlist.hint")}</p>
			{hosts.length === 0 ? (
				<p className="network-egress__empty">{t("shell.settings.network.privacy.allowlist.empty")}</p>
			) : (
				<ul className="network-egress__pills">
					{hosts.map((host) => (
						<li key={host} className="network-egress__pill network-egress__pill--removable">
							<span>{host}</span>
							<IconButton
								icon={IconName.Close}
								label={t("shell.settings.network.privacy.allowlist.remove")}
								onClick={() => onChange(hosts.filter((h) => h !== host))}
							/>
						</li>
					))}
				</ul>
			)}
			<form
				className="network-egress__allowlist-add"
				onSubmit={(e) => {
					e.preventDefault();
					add();
				}}
			>
				<TextField
					ref={inputRef}
					size={TextFieldSize.Sm}
					value={input}
					placeholder={t("shell.settings.network.privacy.allowlist.placeholder")}
					onChange={setInput}
					data-testid="network-egress-allowlist-input"
				/>
				<Button
					type="submit"
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Sm}
					iconLeft={IconName.Plus}
				>
					{t("shell.settings.network.privacy.allowlist.add")}
				</Button>
			</form>
		</div>
	);
}

// ---------------------------------------------------------------------
// Section: Automation network access (11b.8b — per-origin egress allowlist)
// ---------------------------------------------------------------------

/** The Automations app holds the `network.egress:<origin>` grants the HTTP
 *  step's frozen caps intersect against. Per-origin only; the grant itself goes
 *  through the fail-safe capability prompt in main. */
const AUTOMATIONS_APP_ID = "io.brainstorm.automations";

function AutomationEgressSection() {
	const [origins, setOrigins] = useState<readonly string[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);

	const reload = useCallback(async () => {
		const byApp = await window.brainstorm.ledger.listGrantsByApp();
		const grants = byApp[AUTOMATIONS_APP_ID] ?? [];
		setOrigins(
			grants
				.filter((g) => g.capability === "network.egress" && typeof g.scope === "string")
				.map((g) => g.scope as string)
				.sort((a, b) => a.localeCompare(b)),
		);
	}, []);

	useEffect(() => {
		void reload();
	}, [reload]);

	const add = async () => {
		if (busy || input.trim().length === 0) return;
		setBusy(true);
		try {
			const { granted } = await window.brainstorm.ledger.requestEgressGrant(AUTOMATIONS_APP_ID, input);
			if (granted) {
				setInput("");
				await reload();
			}
		} finally {
			setBusy(false);
		}
	};

	const revoke = async (origin: string) => {
		const confirmed = await confirm({
			title: t("shell.settings.network.automation.revokeConfirm.title", { origin }),
			body: t("shell.settings.network.automation.revokeConfirm.body"),
			confirmLabel: t("shell.settings.network.automation.revoke"),
			confirmVariant: ConfirmVariant.Destructive,
		});
		if (!confirmed) return;
		await window.brainstorm.ledger.revoke(AUTOMATIONS_APP_ID, "network.egress", origin);
		await reload();
	};

	return (
		<div className="network-egress__group" data-testid="network-egress-automation">
			<h4 className="network-egress__group-title">{t("shell.settings.network.automation.title")}</h4>
			<p className="network-egress__hint">{t("shell.settings.network.automation.warning")}</p>
			{origins.length === 0 ? (
				<p className="network-egress__empty">{t("shell.settings.network.automation.empty")}</p>
			) : (
				<ul className="network-egress__pills">
					{origins.map((origin) => (
						<li key={origin} className="network-egress__pill network-egress__pill--removable">
							<span>{origin}</span>
							<IconButton
								icon={IconName.Close}
								label={t("shell.settings.network.automation.revoke")}
								onClick={() => void revoke(origin)}
							/>
						</li>
					))}
				</ul>
			)}
			<form
				className="network-egress__allowlist-add"
				onSubmit={(e) => {
					e.preventDefault();
					void add();
				}}
			>
				<TextField
					size={TextFieldSize.Sm}
					value={input}
					placeholder={t("shell.settings.network.automation.placeholder")}
					onChange={setInput}
					data-testid="network-egress-automation-input"
				/>
				<Button
					type="submit"
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Sm}
					iconLeft={IconName.Plus}
					disabled={busy || input.trim().length === 0}
				>
					{t("shell.settings.network.automation.add")}
				</Button>
			</form>
		</div>
	);
}

// ---------------------------------------------------------------------
// Section: Per-app egress
// ---------------------------------------------------------------------

function PerAppSection({
	rows,
	appNameById,
	appIconById,
	onRevoke,
}: {
	rows: readonly NetworkPerAppSummary[];
	appNameById: Map<string, string>;
	appIconById: Map<string, string | null>;
	onRevoke: (appId: string) => Promise<void>;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => PER_APP_ROW_HEIGHT,
		overscan: 4,
		getItemKey: (index) => rows[index]?.appId ?? index,
	});
	const virtualRows = virtualizer.getVirtualItems();
	return (
		<div className="network-egress__group" data-testid="network-egress-per-app">
			<h4 className="network-egress__group-title">{t("shell.settings.network.perApp.title")}</h4>
			<p className="network-egress__hint">{t("shell.settings.network.perApp.summary")}</p>
			{rows.length === 0 ? (
				<p className="network-egress__empty" data-testid="network-egress-per-app-empty">
					{t("shell.settings.network.perApp.empty")}
				</p>
			) : (
				<div
					ref={scrollRef}
					className="network-egress__virtual network-egress__virtual--per-app"
					style={{ maxHeight: `${Math.min(rows.length, 4) * PER_APP_ROW_HEIGHT + 8}px` }}
				>
					<div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
						{virtualRows.map((vrow) => {
							const row = rows[vrow.index];
							if (!row) return null;
							return (
								<div
									key={row.appId}
									style={{
										position: "absolute",
										top: 0,
										left: 0,
										width: "100%",
										transform: `translateY(${vrow.start}px)`,
										height: `${vrow.size}px`,
									}}
								>
									<PerAppRow
										row={row}
										name={appNameById.get(row.appId) ?? row.appId}
										iconSrc={appIconById.get(row.appId) ?? null}
										onRevoke={() => onRevoke(row.appId)}
									/>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}

function PerAppRow({
	row,
	name,
	iconSrc,
	onRevoke,
}: {
	row: NetworkPerAppSummary;
	name: string;
	iconSrc: string | null;
	onRevoke: () => void;
}) {
	const requestCountLabel = t("shell.settings.network.perApp.requestCount", {
		count: row.requestCount,
	});
	return (
		<div className="network-egress__per-app-row" data-testid={`network-egress-per-app-${row.appId}`}>
			<AppIcon name={name} seed={row.appId} src={iconSrc} size={32} />
			<div className="network-egress__per-app-text">
				<span className="network-egress__per-app-name">{name}</span>
				<span className="network-egress__per-app-meta">
					{requestCountLabel}
					{" · "}
					{t("shell.settings.network.perApp.bytes", {
						received: formatBytes(row.receivedBytes),
						sent: formatBytes(row.sentBytes),
					})}
					{" · "}
					{t("shell.settings.network.perApp.lastSeen", { when: formatRelative(row.lastSeenMs) })}
				</span>
				{row.topHosts.length > 0 && (
					<span className="network-egress__per-app-hosts">
						{row.topHosts
							.slice(0, 5)
							.map((h) => `${h.host} (${h.count})`)
							.join(", ")}
					</span>
				)}
			</div>
			<IconButton
				icon={IconName.Prohibit}
				label={t("shell.settings.network.perApp.revoke")}
				onClick={onRevoke}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------
// Section: Recent / Blocked tables
// ---------------------------------------------------------------------

function RecentSection({
	title,
	rows,
	appNameById,
	appIconById,
	hostFilter,
	onHostFilter,
	appFilter,
	onAppFilter,
	onExport,
}: {
	title: string;
	rows: readonly NetworkAuditRecord[];
	appNameById: Map<string, string>;
	appIconById: Map<string, string | null>;
	hostFilter: string;
	onHostFilter: (next: string) => void;
	appFilter: string;
	onAppFilter: (next: string) => void;
	onExport: () => void;
}) {
	const appOptions = useMemo(() => {
		const ids = new Set<string>();
		for (const r of rows) ids.add(r.appId);
		return Array.from(ids).sort((a, b) =>
			(appNameById.get(a) ?? a).localeCompare(appNameById.get(b) ?? b),
		);
	}, [rows, appNameById]);

	const filtered = useMemo(() => {
		return rows.filter((r) => {
			if (appFilter !== "__all__" && r.appId !== appFilter) return false;
			if (hostFilter.length > 0 && !r.host.includes(hostFilter.toLowerCase())) return false;
			return true;
		});
	}, [rows, appFilter, hostFilter]);

	return (
		<div
			className="network-egress__group network-egress__group--grow"
			data-testid="network-egress-recent"
		>
			<div className="network-egress__group-header">
				<div className="network-egress__group-heading">
					<h4 className="network-egress__group-title">{title}</h4>
					<p className="network-egress__hint">
						{t("shell.settings.network.recent.summary", { limit: RECENT_DEFAULT_LIMIT })}
					</p>
				</div>
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Sm}
					iconLeft={IconName.Download}
					onClick={onExport}
					data-testid="network-egress-recent-export"
				>
					{t("shell.settings.network.recent.export")}
				</Button>
			</div>
			<div className="network-egress__filters">
				<Select
					value={appFilter}
					onChange={onAppFilter}
					size={TextFieldSize.Sm}
					aria-label={t("shell.settings.network.recent.filter.appAll")}
					data-testid="network-egress-recent-app-filter"
					options={[
						{ value: "__all__", label: t("shell.settings.network.recent.filter.appAll") },
						...appOptions.map((id) => ({ value: id, label: appNameById.get(id) ?? id })),
					]}
				/>
				<div className="network-egress__filter-input">
					<TextField
						type="search"
						value={hostFilter}
						onChange={onHostFilter}
						size={TextFieldSize.Sm}
						iconLeft={IconName.Search}
						placeholder={t("shell.settings.network.recent.filter.hostPlaceholder")}
						aria-label={t("shell.settings.network.recent.filter.hostPlaceholder")}
						data-testid="network-egress-recent-host-filter"
					/>
				</div>
			</div>
			<RequestsTable
				rows={filtered}
				appNameById={appNameById}
				appIconById={appIconById}
				showReason={false}
				emptyKey="shell.settings.network.recent.empty"
				testId="network-egress-recent-table"
			/>
		</div>
	);
}

function BlockedSection({
	rows,
	appNameById,
	appIconById,
	hostFilter,
	appFilter,
}: {
	rows: readonly NetworkAuditRecord[];
	appNameById: Map<string, string>;
	appIconById: Map<string, string | null>;
	hostFilter: string;
	appFilter: string;
}) {
	const [open, setOpen] = useState(false);
	const filtered = useMemo(() => {
		return rows.filter((r) => {
			if (appFilter !== "__all__" && r.appId !== appFilter) return false;
			if (hostFilter.length > 0 && !r.host.includes(hostFilter.toLowerCase())) return false;
			return true;
		});
	}, [rows, appFilter, hostFilter]);

	return (
		<div className="network-egress__group" data-testid="network-egress-blocked">
			<button
				type="button"
				className="network-egress__collapse"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
			>
				<Icon name={IconName.CaretDown} size={14} className="network-egress__collapse-caret" />
				<span>{t("shell.settings.network.blocked.title")}</span>
				{rows.length > 0 && <span className="network-egress__count">({rows.length})</span>}
			</button>
			{open && (
				<RequestsTable
					rows={filtered}
					appNameById={appNameById}
					appIconById={appIconById}
					showReason={true}
					emptyKey="shell.settings.network.blocked.empty"
					testId="network-egress-blocked-table"
				/>
			)}
		</div>
	);
}

function RequestsTable({
	rows,
	appNameById,
	appIconById,
	showReason,
	emptyKey,
	testId,
}: {
	rows: readonly NetworkAuditRecord[];
	appNameById: Map<string, string>;
	appIconById: Map<string, string | null>;
	showReason: boolean;
	emptyKey: string;
	testId: string;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => RECENT_ROW_HEIGHT,
		overscan: 12,
		getItemKey: (index) => {
			const row = rows[index];
			return row ? `${row.ts}|${row.appId}|${row.host}|${index}` : index;
		},
	});
	if (rows.length === 0) {
		return (
			<p className="network-egress__empty" data-testid={`${testId}-empty`}>
				{t(emptyKey)}
			</p>
		);
	}
	const virtualRows = virtualizer.getVirtualItems();
	return (
		<div
			ref={scrollRef}
			className="network-egress__virtual network-egress__virtual--requests"
			data-testid={testId}
			style={{ maxHeight: `${Math.min(rows.length, 12) * RECENT_ROW_HEIGHT + 32}px` }}
		>
			<div className="network-egress__table-header">
				<span className="network-egress__col-ts">
					{t("shell.settings.network.recent.col.timestamp")}
				</span>
				<span className="network-egress__col-app">{t("shell.settings.network.recent.col.app")}</span>
				<span className="network-egress__col-method">
					{t("shell.settings.network.recent.col.method")}
				</span>
				<span className="network-egress__col-host">{t("shell.settings.network.recent.col.host")}</span>
				<span className="network-egress__col-status">
					{t("shell.settings.network.recent.col.status")}
				</span>
				<span className="network-egress__col-bytes">
					{t("shell.settings.network.recent.col.bytes")}
				</span>
				<span className="network-egress__col-latency">
					{t("shell.settings.network.recent.col.latency")}
				</span>
				{showReason && (
					<span className="network-egress__col-reason">
						{t("shell.settings.network.recent.col.reason")}
					</span>
				)}
			</div>
			<div
				className="network-egress__table-body"
				style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}
			>
				{virtualRows.map((vrow) => {
					const row = rows[vrow.index];
					if (!row) return null;
					return (
						<div
							key={vrow.key}
							className={`network-egress__table-row network-egress__table-row--${row.outcome}`}
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								transform: `translateY(${vrow.start}px)`,
								height: `${vrow.size}px`,
							}}
						>
							<span className="network-egress__col-ts" title={new Date(row.ts).toISOString()}>
								{formatRelative(row.ts)}
							</span>
							<span className="network-egress__col-app">
								<AppIcon
									name={appNameById.get(row.appId) ?? row.appId}
									seed={row.appId}
									src={appIconById.get(row.appId) ?? null}
									size={18}
								/>
								<span className="network-egress__col-app-name">
									{appNameById.get(row.appId) ?? row.appId}
								</span>
							</span>
							<span className="network-egress__col-method">{row.method}</span>
							<span className="network-egress__col-host" title={row.host}>
								{row.host}
							</span>
							<span className="network-egress__col-status">
								{row.outcome === NetworkAuditOutcome.Completed
									? row.status
									: t(outcomeLabelKey(row.outcome))}
							</span>
							<span className="network-egress__col-bytes">{formatBytes(row.bytes)}</span>
							<span className="network-egress__col-latency">
								{row.durationMs}
								{/* i18n-exempt — "ms" is the SI unit symbol, not localized */}ms
							</span>
							{showReason && (
								<span className="network-egress__col-reason" title={row.reason}>
									{row.reason || "—"}
								</span>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function outcomeLabelKey(outcome: NetworkAuditOutcome): string {
	switch (outcome) {
		case NetworkAuditOutcome.Completed:
			return "shell.settings.network.outcome.completed";
		case NetworkAuditOutcome.Refused:
			return "shell.settings.network.outcome.refused";
		case NetworkAuditOutcome.Aborted:
			return "shell.settings.network.outcome.aborted";
		case NetworkAuditOutcome.Errored:
			return "shell.settings.network.outcome.errored";
	}
}

// ---------------------------------------------------------------------
// Section: Embed providers placeholder
// ---------------------------------------------------------------------

function EmbedProvidersPlaceholder() {
	return (
		<div
			className="network-egress__group network-egress__group--soft"
			data-testid="network-egress-embeds"
		>
			<div className="network-egress__soft-row">
				<Icon name={IconName.Sparkle} size={14} />
				<div>
					<h4 className="network-egress__group-title">{t("shell.settings.network.embeds.title")}</h4>
					<p className="network-egress__hint">{t("shell.settings.network.embeds.placeholder")}</p>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------
// Section: Beta analytics disclosure
// ---------------------------------------------------------------------

function AnalyticsBetaSection() {
	const version = window.brainstorm?.version ?? "0.0.0";
	if (!isPublicBeta(version)) return null;
	return (
		<div className="network-egress__group" data-testid="network-egress-analytics">
			<h4 className="network-egress__group-title">{t("shell.settings.network.analytics.title")}</h4>
			<p className="network-egress__hint">{t("shell.settings.network.analytics.summary")}</p>
		</div>
	);
}

// ---------------------------------------------------------------------
// Section: Feedback opt-in (Feedback-1)
// ---------------------------------------------------------------------

function FeedbackSection() {
	const [settings, setSettings] = useState<{
		enabled: boolean;
		endpoint: string | null;
		installationId: string;
		crashReportingEnabled: boolean;
		lastCrashSubmitAttemptMs: number | null;
	} | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [endpointDraft, setEndpointDraft] = useState("");
	const [endpointError, setEndpointError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);

	useEffect(() => {
		let cancelled = false;
		window.brainstorm.feedback.settings
			.get()
			.then((s) => {
				if (cancelled) return;
				setSettings(s);
				setEndpointDraft(s.endpoint ?? "");
				setLoadError(null);
			})
			.catch(() => {
				if (cancelled) return;
				setLoadError(t("shell.settings.network.feedback.loadFailed"));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const onToggle = async (next: boolean) => {
		setSaving(true);
		try {
			const updated = await window.brainstorm.feedback.settings.set({ enabled: next });
			setSettings(updated);
		} catch (error) {
			setLoadError(
				error instanceof Error ? error.message : t("shell.settings.network.feedback.loadFailed"),
			);
		} finally {
			setSaving(false);
		}
	};

	const onEndpointBlur = async () => {
		const trimmed = endpointDraft.trim();
		const normalized = trimmed.length === 0 ? null : trimmed;
		if (normalized !== null && !/^https?:\/\//i.test(normalized)) {
			setEndpointError(t("shell.settings.network.feedback.endpointInvalid"));
			return;
		}
		setEndpointError(null);
		if (settings && normalized === settings.endpoint) return;
		setSaving(true);
		try {
			const updated = await window.brainstorm.feedback.settings.set({ endpoint: normalized });
			setSettings(updated);
		} catch (error) {
			setEndpointError(
				error instanceof Error ? error.message : t("shell.settings.network.feedback.endpointInvalid"),
			);
		} finally {
			setSaving(false);
		}
	};

	if (loadError) {
		return (
			<div className="network-egress__group" data-testid="network-egress-feedback">
				<h4 className="network-egress__group-title">{t("shell.settings.network.feedback.title")}</h4>
				<p className="settings__error" role="alert">
					{loadError}
				</p>
			</div>
		);
	}

	return (
		<div className="network-egress__group" data-testid="network-egress-feedback">
			<h4 className="network-egress__group-title">{t("shell.settings.network.feedback.title")}</h4>
			<p className="network-egress__hint">{t("shell.settings.network.feedback.summary")}</p>
			<Checkbox
				checked={settings?.enabled ?? false}
				disabled={saving || settings === null}
				onChange={(next) => void onToggle(next)}
				label={t("shell.settings.network.feedback.toggle")}
				data-testid="network-egress-feedback-toggle"
			/>
			{settings?.enabled && (
				<TextField
					label={t("shell.settings.network.feedback.endpointLabel")}
					type="url"
					value={endpointDraft}
					onChange={setEndpointDraft}
					onBlur={() => void onEndpointBlur()}
					placeholder={t("shell.settings.network.feedback.endpointPlaceholder")}
					{...(endpointError
						? { error: endpointError }
						: { hint: t("shell.settings.network.feedback.endpointHint") })}
					data-testid="network-egress-feedback-endpoint"
				/>
			)}
			<div className="network-egress__feedback-actions">
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Sm}
					onClick={() => setDialogOpen(true)}
					disabled={!settings?.enabled || settings.endpoint === null}
					data-testid="network-egress-feedback-open"
				>
					{t("shell.settings.network.feedback.openDialog")}
				</Button>
				{settings && (
					<small
						className="network-egress__install-id"
						title={t("shell.settings.network.feedback.installationId")}
					>
						{t("shell.settings.network.feedback.installationId")}:{" "}
						<code data-testid="network-egress-feedback-installation-id">{settings.installationId}</code>
					</small>
				)}
			</div>
			{settings && (
				<CrashReporterRow
					settings={settings}
					saving={saving}
					onToggle={async (next) => {
						setSaving(true);
						try {
							const updated = await window.brainstorm.feedback.settings.set({
								crashReportingEnabled: next,
							});
							setSettings(updated);
						} catch (error) {
							setLoadError(
								error instanceof Error ? error.message : t("shell.settings.network.feedback.loadFailed"),
							);
						} finally {
							setSaving(false);
						}
					}}
				/>
			)}
			{dialogOpen && <FeedbackDialog onClose={() => setDialogOpen(false)} />}
		</div>
	);
}

// ---------------------------------------------------------------------
// Section: Crash reporter row (Feedback-2)
// ---------------------------------------------------------------------

function CrashReporterRow({
	settings,
	saving,
	onToggle,
}: {
	settings: {
		enabled: boolean;
		endpoint: string | null;
		installationId: string;
		crashReportingEnabled: boolean;
		lastCrashSubmitAttemptMs: number | null;
	};
	saving: boolean;
	onToggle: (next: boolean) => Promise<void>;
}) {
	const [pending, setPending] = useState<CrashPendingSummary | null>(null);
	const [reviewOpen, setReviewOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [lastResult, setLastResult] = useState<CrashSubmissionResult | null>(null);

	const refresh = useCallback(async () => {
		try {
			const summary = await window.brainstorm.feedback.crash.pendingCount();
			setPending(summary);
		} catch (_error) {
			setPending(null);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const onSubmitNow = async () => {
		setSubmitting(true);
		try {
			const result = await window.brainstorm.feedback.crash.submitNow();
			setLastResult(result);
			await refresh();
		} finally {
			setSubmitting(false);
		}
	};

	const submitDisabled =
		submitting ||
		!settings.crashReportingEnabled ||
		settings.endpoint === null ||
		(pending !== null && pending.count === 0);

	return (
		<div className="network-egress__subgroup" data-testid="network-egress-crash">
			<h5 className="network-egress__subtitle">{t("shell.settings.network.crash.title")}</h5>
			<Checkbox
				checked={settings.crashReportingEnabled}
				disabled={saving}
				onChange={(next) => void onToggle(next)}
				label={t("shell.settings.network.crash.toggle")}
				data-testid="network-egress-crash-toggle"
			/>
			<p className="network-egress__hint">{t("shell.settings.network.crash.summary")}</p>
			<p className="network-egress__hint" data-testid="network-egress-crash-pending">
				{pending === null || pending.count === 0
					? t("shell.settings.network.crash.pendingNone")
					: t("shell.settings.network.crash.pendingCount", { count: pending.count })}
				{pending &&
					pending.localCount > 0 &&
					t("shell.settings.network.crash.localCount", { count: pending.localCount })}
				{settings.lastCrashSubmitAttemptMs && (
					<>
						{" "}
						{t("shell.settings.network.crash.lastAttempt", {
							when: formatRelative(settings.lastCrashSubmitAttemptMs),
						})}
					</>
				)}
			</p>
			{lastResult && (
				<p className="network-egress__hint" data-testid="network-egress-crash-result">
					{t("shell.settings.network.crash.submitResult", {
						submitted: lastResult.submitted,
						failed: lastResult.failed,
						dropped: lastResult.dropped,
					})}
				</p>
			)}
			<div className="network-egress__feedback-actions">
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Sm}
					onClick={() => void onSubmitNow()}
					disabled={submitDisabled}
					loading={submitting}
					data-testid="network-egress-crash-submit"
				>
					{t("shell.settings.network.crash.submitNow")}
				</Button>
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Sm}
					onClick={() => setReviewOpen(true)}
					disabled={pending === null || pending.count === 0}
					data-testid="network-egress-crash-review"
				>
					{t("shell.settings.network.crash.reviewPending")}
				</Button>
			</div>
			{reviewOpen && (
				<CrashPendingPopover
					onClose={() => setReviewOpen(false)}
					onCleared={async () => {
						await refresh();
						setLastResult(null);
					}}
				/>
			)}
		</div>
	);
}

function CrashPendingPopover({
	onClose,
	onCleared,
}: {
	onClose: () => void;
	onCleared: () => Promise<void>;
}) {
	const [rows, setRows] = useState<readonly CrashPayload[] | null>(null);

	useEffect(() => {
		let cancelled = false;
		window.brainstorm.feedback.crash
			.list()
			.then((list) => {
				if (cancelled) return;
				setRows(list);
			})
			.catch(() => {
				if (cancelled) return;
				setRows([]);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const onClear = async () => {
		const confirmed = await confirm({
			title: t("shell.settings.network.crash.clearConfirm.title"),
			body: t("shell.settings.network.crash.clearConfirm.body"),
			confirmLabel: t("shell.settings.network.crash.clearConfirm.confirm"),
			confirmVariant: ConfirmVariant.Destructive,
		});
		if (!confirmed) return;
		await window.brainstorm.feedback.crash.clear();
		await onCleared();
		onClose();
	};

	return (
		<Popover
			title={t("shell.settings.network.crash.popoverTitle")}
			onClose={onClose}
			size={PopoverSize.Medium}
			bodyPadding={PopoverBodyPadding.Comfortable}
			testId="network-egress-crash-popover"
		>
			{rows === null ? (
				<p className="settings__placeholder">{t("shell.settings.network.loading")}</p>
			) : rows.length === 0 ? (
				<p className="network-egress__empty">{t("shell.settings.network.crash.emptyPopover")}</p>
			) : (
				<ul className="network-egress__crash-list" data-testid="network-egress-crash-list">
					{rows.map((row) => (
						<li key={row.requestId} className="network-egress__crash-row">
							<span className="network-egress__crash-meta">
								{formatRelative(row.capturedAt)} · {t(crashKindLabelKey(row.kind))}
								{row.appId ? ` · ${row.appId}` : ""}
							</span>
							<span className="network-egress__crash-line" title={row.stack ?? row.message}>
								{firstLine(row.stack ?? row.message)}
							</span>
						</li>
					))}
				</ul>
			)}
			<div className="network-egress__editor-footer">
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Sm}
					onClick={onClose}
					data-testid="network-egress-crash-popover-close"
				>
					{t("shell.settings.network.proxy.editor.cancel")}
				</Button>
				<Button
					variant={ButtonVariant.Destructive}
					size={ButtonSize.Sm}
					onClick={() => void onClear()}
					disabled={rows !== null && rows.length === 0}
					data-testid="network-egress-crash-popover-clear"
				>
					{t("shell.settings.network.crash.clearAll")}
				</Button>
			</div>
		</Popover>
	);
}

function crashKindLabelKey(kind: CrashKind): string {
	switch (kind) {
		case CrashKind.UncaughtException:
			return "shell.settings.network.crash.kind.uncaught-exception";
		case CrashKind.UnhandledRejection:
			return "shell.settings.network.crash.kind.unhandled-rejection";
		case CrashKind.RendererProcessGone:
			return "shell.settings.network.crash.kind.renderer-process-gone";
		case CrashKind.RendererCrashed:
			return "shell.settings.network.crash.kind.renderer-crashed";
		case CrashKind.RendererKilled:
			return "shell.settings.network.crash.kind.renderer-killed";
		case CrashKind.UnresponsiveRenderer:
			return "shell.settings.network.crash.kind.unresponsive-renderer";
		case CrashKind.MainProcessGone:
			return "shell.settings.network.crash.kind.main-process-gone";
	}
}

function firstLine(input: string): string {
	const idx = input.indexOf("\n");
	if (idx === -1) return input;
	return input.slice(0, idx);
}

// ---------------------------------------------------------------------
// Section: Preview cache
// ---------------------------------------------------------------------

function PreviewCacheSection({
	stats,
	onClear,
}: {
	stats: NetworkCacheStats;
	onClear: () => Promise<void>;
}) {
	return (
		<div
			className="network-egress__group network-egress__group--compact"
			data-testid="network-egress-cache"
		>
			<div className="network-egress__row">
				<div className="network-egress__cache-text">
					<h4 className="network-egress__group-title">{t("shell.settings.network.cache.title")}</h4>
					<p className="network-egress__hint">
						{stats.entryCount === 0
							? t("shell.settings.network.cache.empty")
							: t("shell.settings.network.cache.summary", {
									count: stats.entryCount,
									oldest: stats.oldestMs !== null ? formatRelative(stats.oldestMs) : "—",
									newest: stats.newestMs !== null ? formatRelative(stats.newestMs) : "—",
								})}
					</p>
				</div>
				<Button
					variant={ButtonVariant.Ghost}
					size={ButtonSize.Sm}
					onClick={() => void onClear()}
					disabled={stats.entryCount === 0}
					data-testid="network-egress-cache-clear"
				>
					{t("shell.settings.network.cache.clear")}
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function proxyModeLabel(mode: NetworkProxyMode): string {
	switch (mode) {
		case NetworkProxyMode.Direct:
			return t("shell.settings.network.proxy.mode.direct");
		case NetworkProxyMode.System:
			return t("shell.settings.network.proxy.mode.system");
		case NetworkProxyMode.Manual:
			return t("shell.settings.network.proxy.mode.manual");
		case NetworkProxyMode.Pac:
			return t("shell.settings.network.proxy.mode.pac");
	}
}

function resolvedProxyHint(kind: EffectiveProxyKind): string {
	switch (kind) {
		case EffectiveProxyKind.Direct:
			return t("shell.settings.network.proxy.mode.direct");
		case EffectiveProxyKind.Http:
			return t("shell.settings.network.proxy.endpoint.http");
		case EffectiveProxyKind.Https:
			return t("shell.settings.network.proxy.endpoint.https");
		case EffectiveProxyKind.Socks5:
			return t("shell.settings.network.proxy.endpoint.socks5");
		case EffectiveProxyKind.Deferred:
			return t("shell.settings.network.proxy.mode.system");
	}
}

export { formatBytes };

/** Wraps the shared `formatRelative` with this panel's absent-sentinel ("—")
 *  and its `(ms)`-first call shape (the audit rows pass a single timestamp). */
export function formatRelative(ms: number, now: number = Date.now()): string {
	if (!Number.isFinite(ms) || ms <= 0) return "—";
	return formatRelativeShared(now, ms);
}

async function exportAuditRecords(records: readonly NetworkAuditRecord[]): Promise<void> {
	try {
		const blob = new Blob([records.map((r) => JSON.stringify(r)).join("\n")], {
			type: "application/x-jsonlines",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `network-audit-${new Date().toISOString().split("T")[0]}.jsonl`;
		a.click();
		URL.revokeObjectURL(url);
	} catch (error) {
		console.warn("[network-egress] export failed", error);
	}
}
