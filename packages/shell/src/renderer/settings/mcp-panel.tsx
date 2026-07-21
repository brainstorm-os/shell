/**
 * Settings → AI → MCP servers (MCP-3, doc 64 §Settings UI). Mirrors the
 * provider-key surface: a list of connected servers (each with health + enable
 * state), a popover to add/configure one (transport, URL, auth secret), and a
 * tools inspector that lists the discovered tools with their UNTRUSTED
 * descriptions shown verbatim-but-marked, plus read-only/destructive
 * annotations + a rug-pull flag (changed/new since approval).
 *
 * The auth secret is write-only across the privileged dashboard bridge
 * (`window.brainstorm.mcpSettings`); we send it on save and only ever read back
 * a configured/not boolean. stdio (local-process) servers (MCP-2) are
 * configurable here — command + argv, shown for review; an agent can only
 * SPAWN one after the default-off `mcp.spawn-local` permission is granted
 * (OQ-MCP-2).
 */

import { McpTransportKind, isStdioMcpTransport } from "@brainstorm-os/sdk-types";
import { useCallback, useEffect, useState } from "react";
import type { McpInspectResultView, McpServerSettingsView } from "../../preload";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { TextArea, TextField } from "../ui/text-field";
import { SettingSelect } from "./settings-controls";
import "./mcp-panel.css";

/** The transport options the picker offers (HTTP families + local stdio). */
const TRANSPORT_OPTIONS = [
	{ value: McpTransportKind.StreamableHttp, labelKey: "shell.settings.mcp.transport.http" },
	{ value: McpTransportKind.Sse, labelKey: "shell.settings.mcp.transport.sse" },
	{ value: McpTransportKind.Stdio, labelKey: "shell.settings.mcp.transport.stdio" },
];

function ServerTile({ server, onOpen }: { server: McpServerSettingsView; onOpen: () => void }) {
	return (
		<button
			type="button"
			className="settings__mcp-tile"
			data-testid={`mcp-server-${server.id}`}
			data-enabled={server.enabledHere}
			onClick={onOpen}
			title={server.name}
		>
			<span className="settings__mcp-tile-name">{server.name}</span>
			<span className="settings__mcp-tile-url">
				{server.url ?? server.command ?? server.transport}
			</span>
			<span className="settings__mcp-tile-status">
				{server.enabledHere
					? t("shell.settings.mcp.statusEnabled")
					: t("shell.settings.mcp.statusDisabled")}
			</span>
		</button>
	);
}

/** The tools inspector — UNTRUSTED descriptions verbatim, marked untrusted, with
 *  annotation badges + a rug-pull "changed/new" flag and an Approve action. */
function ToolsInspector({ serverId }: { serverId: string }) {
	const [result, setResult] = useState<McpInspectResultView | null>(null);
	const refresh = useCallback(() => {
		void window.brainstorm.mcpSettings.inspect(serverId).then(setResult);
	}, [serverId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh is the effect body; re-run on serverId change.
	useEffect(refresh, [serverId]);

	if (!result) return <p className="settings__hint">{t("shell.settings.mcp.inspecting")}</p>;
	if (!result.ok) return <p className="settings__hint">{t("shell.settings.mcp.inspectFailed")}</p>;
	const hasRugPull = result.tools.some((tool) => tool.rugPull !== null);

	return (
		<div className="settings__mcp-tools" data-testid={`mcp-tools-${serverId}`}>
			<p id={`mcp-untrusted-note-${serverId}`} className="settings__mcp-untrusted-note">
				{t("shell.settings.mcp.untrustedNote")}
			</p>
			<ul
				className="settings__mcp-tool-list"
				aria-label={t("shell.settings.mcp.untrustedNote")}
				aria-describedby={`mcp-untrusted-note-${serverId}`}
			>
				{result.tools.map((tool) => (
					<li key={tool.name} className="settings__mcp-tool" data-rugpull={tool.rugPull ?? "none"}>
						<span className="settings__mcp-tool-head">
							<span className="settings__mcp-tool-name">{tool.name}</span>
							{tool.readOnlyHint && (
								<span className="settings__mcp-badge">{t("shell.settings.mcp.readOnly")}</span>
							)}
							{tool.destructiveHint && (
								<span className="settings__mcp-badge settings__mcp-badge--danger">
									{t("shell.settings.mcp.destructive")}
								</span>
							)}
							{tool.rugPull && (
								<span className="settings__mcp-badge settings__mcp-badge--warn">
									{tool.rugPull === "new"
										? t("shell.settings.mcp.toolNew")
										: t("shell.settings.mcp.toolChanged")}
								</span>
							)}
						</span>
						{/* UNTRUSTED server text — rendered as inert text, never markup. */}
						<span className="settings__mcp-tool-desc">{tool.description}</span>
					</li>
				))}
			</ul>
			{hasRugPull && (
				<Button
					variant={ButtonVariant.Neutral}
					size={ButtonSize.Md}
					onClick={() => void window.brainstorm.mcpSettings.approve(serverId).then(refresh)}
				>
					{t("shell.settings.mcp.approveChanges")}
				</Button>
			)}
		</div>
	);
}

function ServerPopover({
	server,
	onClose,
	onChanged,
}: {
	server: McpServerSettingsView | null;
	onClose: () => void;
	onChanged: () => void | Promise<void>;
}) {
	const editing = server !== null;
	const [id, setId] = useState(server?.id ?? "");
	const [name, setName] = useState(server?.name ?? "");
	const [transport, setTransport] = useState<string>(
		server?.transport ?? McpTransportKind.StreamableHttp,
	);
	const [url, setUrl] = useState(server?.url ?? "");
	const [command, setCommand] = useState(server?.command ?? "");
	const [argsText, setArgsText] = useState((server?.args ?? []).join("\n"));
	const [requiresAuth, setRequiresAuth] = useState(server?.requiresAuth ?? false);
	const [secret, setSecret] = useState("");
	const [busy, setBusy] = useState(false);

	const isStdio = isStdioMcpTransport(transport as McpTransportKind);
	// One argv entry per line (a path may contain spaces; blank lines dropped).
	const args = argsText
		.split("\n")
		.map((a) => a.trim())
		.filter((a) => a.length > 0);
	const endpointReady = isStdio ? command.trim().length > 0 : url.trim().length > 0;
	const canSave = id.trim().length > 0 && name.trim().length > 0 && endpointReady;

	const save = async () => {
		if (!canSave) return;
		setBusy(true);
		try {
			const saved = await window.brainstorm.mcpSettings.upsert(
				isStdio
					? {
							id: id.trim(),
							name: name.trim(),
							transport,
							command: command.trim(),
							args,
							requiresAuth: false,
						}
					: { id: id.trim(), name: name.trim(), transport, url: url.trim(), requiresAuth },
			);
			if (saved && !isStdio && requiresAuth && secret.trim().length > 0) {
				await window.brainstorm.mcpSettings.setAuth(saved.id, secret.trim());
			}
			if (saved) {
				await onChanged();
				onClose();
			}
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		if (!server) return;
		setBusy(true);
		try {
			await window.brainstorm.mcpSettings.remove(server.id);
			await onChanged();
			onClose();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Popover
			title={editing ? server.name : t("shell.settings.mcp.addTitle")}
			onClose={onClose}
			size={PopoverSize.Small}
			bodyPadding={PopoverBodyPadding.Comfortable}
			fitContent
			testId="mcp-server-popover"
			footer={
				<>
					{editing && (
						<Button
							variant={ButtonVariant.Ghost}
							danger
							size={ButtonSize.Md}
							className="popover__footer-lead"
							onClick={() => void remove()}
							disabled={busy}
						>
							{t("shell.settings.mcp.remove")}
						</Button>
					)}
					<Button
						variant={ButtonVariant.Primary}
						size={ButtonSize.Md}
						onClick={() => void save()}
						disabled={busy || !canSave}
					>
						{t("shell.settings.mcp.save")}
					</Button>
				</>
			}
		>
			<form
				className="settings__mcp-form"
				onSubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<label className="settings__mcp-label" htmlFor="mcp-id">
					{t("shell.settings.mcp.idLabel")}
				</label>
				<TextField
					id="mcp-id"
					value={id}
					disabled={editing}
					placeholder={t("shell.settings.mcp.idPlaceholder")}
					onChange={setId}
				/>
				<label className="settings__mcp-label" htmlFor="mcp-name">
					{t("shell.settings.mcp.nameLabel")}
				</label>
				<TextField
					id="mcp-name"
					value={name}
					placeholder={t("shell.settings.mcp.namePlaceholder")}
					onChange={setName}
				/>
				<label className="settings__mcp-label" htmlFor="mcp-transport">
					{t("shell.settings.mcp.transportLabel")}
				</label>
				<SettingSelect
					id="mcp-transport"
					value={transport}
					options={TRANSPORT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
					ariaLabel={t("shell.settings.mcp.transportLabel")}
					onChange={setTransport}
				/>
				{isStdio ? (
					<>
						<label className="settings__mcp-label" htmlFor="mcp-command">
							{t("shell.settings.mcp.commandLabel")}
						</label>
						<TextField
							id="mcp-command"
							value={command}
							spellCheck={false}
							placeholder={t("shell.settings.mcp.commandPlaceholder")}
							onChange={setCommand}
						/>
						<label className="settings__mcp-label" htmlFor="mcp-args">
							{t("shell.settings.mcp.argsLabel")}
						</label>
						<TextArea
							id="mcp-args"
							value={argsText}
							spellCheck={false}
							rows={3}
							placeholder={t("shell.settings.mcp.argsPlaceholder")}
							onChange={setArgsText}
						/>
						<p className="settings__mcp-spawn-note">{t("shell.settings.mcp.spawnConsentNote")}</p>
					</>
				) : (
					<>
						<label className="settings__mcp-label" htmlFor="mcp-url">
							{t("shell.settings.mcp.urlLabel")}
						</label>
						<TextField
							id="mcp-url"
							type="url"
							value={url}
							placeholder="https://example.com/mcp"
							onChange={setUrl}
						/>
						<Checkbox
							checked={requiresAuth}
							onChange={setRequiresAuth}
							label={t("shell.settings.mcp.requiresAuth")}
						/>
						{requiresAuth && (
							<TextField
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={secret}
								placeholder={
									server?.requiresAuth
										? t("shell.settings.mcp.authReplacePlaceholder")
										: t("shell.settings.mcp.authPlaceholder")
								}
								onChange={setSecret}
								aria-label={t("shell.settings.mcp.authLabel")}
							/>
						)}
					</>
				)}
				{editing && <ToolsInspector serverId={server.id} />}
			</form>
		</Popover>
	);
}

/** The MCP servers section — a grid of connected servers + an Add tile, each
 *  opening a config/inspector popover. Enable toggles flip per-device. */
export function McpServersSection() {
	const [servers, setServers] = useState<ReadonlyArray<McpServerSettingsView>>([]);
	const [openId, setOpenId] = useState<string | null>(null);
	const [adding, setAdding] = useState(false);

	const refresh = useCallback(async () => {
		const bridge = window.brainstorm.mcpSettings;
		if (typeof bridge?.list !== "function") return;
		setServers(await bridge.list());
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const open = servers.find((s) => s.id === openId) ?? null;

	return (
		<div className="settings__field" data-testid="mcp-servers">
			<div className="settings__field-head">
				<span className="settings__field-label">{t("shell.settings.mcp.title")}</span>
			</div>
			<p className="settings__hint">{t("shell.settings.mcp.intro")}</p>
			<div className="settings__mcp-grid">
				{servers.map((server) => (
					<div key={server.id} className="settings__mcp-cell">
						<ServerTile server={server} onOpen={() => setOpenId(server.id)} />
						<Button
							variant={server.enabledHere ? ButtonVariant.Ghost : ButtonVariant.Neutral}
							size={ButtonSize.Md}
							onClick={() =>
								void window.brainstorm.mcpSettings.setEnabled(server.id, !server.enabledHere).then(refresh)
							}
						>
							{server.enabledHere ? t("shell.settings.mcp.disable") : t("shell.settings.mcp.enable")}
						</Button>
					</div>
				))}
				<button
					type="button"
					className="settings__mcp-tile settings__mcp-tile--add"
					data-testid="mcp-add"
					onClick={() => setAdding(true)}
				>
					{t("shell.settings.mcp.add")}
				</button>
			</div>
			{open && <ServerPopover server={open} onClose={() => setOpenId(null)} onChanged={refresh} />}
			{adding && <ServerPopover server={null} onClose={() => setAdding(false)} onChanged={refresh} />}
		</div>
	);
}
