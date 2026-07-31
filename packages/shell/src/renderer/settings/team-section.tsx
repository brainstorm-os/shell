/**
 * Settings → Team (Agent-Teams-2) — the agent-member surface doc 69 §Management
 * specifies: directory (create / configure / delete an `Agent/v1` member) plus
 * the per-agent capability sheet ("scope an agent like a new hire").
 *
 * Grant/revoke here IS the consent gesture: the privileged dashboard renderer
 * drives the `agents:*` IPC, and main enforces the fail-closed agent-grantable
 * vocabulary (`@brainstorm-os/capabilities/agent-grants`) — this surface can
 * only OFFER what that policy allows, and offers it as a curated checklist
 * (reads / proposals / run set) rather than a free-text capability field. An
 * agent can never be granted a write: proposals persist only through a human's
 * approve gesture in the app that renders them (Agent-11b).
 */

import { useCallback, useEffect, useState } from "react";
import type { ShellAgent, ShellAgentAuditEvent } from "../../preload";
import { t } from "../i18n/t";
import { Button, ButtonSize, ButtonVariant } from "../ui/button";
import { ConfirmVariant, confirm } from "../ui/confirm";
import { Popover } from "../ui/popover";
import { PopoverBodyPadding, PopoverSize } from "../ui/popover-types";
import { TextArea, TextField, TextFieldSize } from "../ui/text-field";
import { ToggleRow } from "./settings-controls";
import "./team-section.css";

/** One offerable grant: the full `service.verb[:scope]` string + its label
 *  key. The catalog is deliberately a strict subset of the main-process
 *  agent-grantable vocabulary — pinned by test. */
export type TeamGrantOption = {
	grant: string;
	labelKey: string;
};

/** What the agent may READ — scoped, per doc 69 ("which collections"). */
export const TEAM_READ_GRANTS: readonly TeamGrantOption[] = [
	{ grant: "entities.read:*", labelKey: "shell.settings.team.read.all" },
	{ grant: "entities.read:io.brainstorm.notes/Note/v1", labelKey: "shell.settings.team.read.notes" },
	{ grant: "entities.read:brainstorm/Task/v1", labelKey: "shell.settings.team.read.tasks" },
	{ grant: "entities.read:brainstorm/Event/v1", labelKey: "shell.settings.team.read.events" },
	{
		grant: "entities.read:brainstorm/Bookmark/v1",
		labelKey: "shell.settings.team.read.bookmarks",
	},
	{ grant: "entities.read:brainstorm/Person/v1", labelKey: "shell.settings.team.read.contacts" },
	{ grant: "entities.read:brainstorm/Project/v1", labelKey: "shell.settings.team.read.projects" },
	{ grant: "entities.read:brainstorm/List/v1", labelKey: "shell.settings.team.read.databases" },
];

/** What the agent may PROPOSE — drafts a human approves, never direct writes. */
export const TEAM_PROPOSE_GRANTS: readonly TeamGrantOption[] = [
	{ grant: "intents.dispatch:propose-note", labelKey: "shell.settings.team.propose.note" },
	{ grant: "intents.dispatch:propose-task", labelKey: "shell.settings.team.propose.task" },
	{ grant: "intents.dispatch:propose-event", labelKey: "shell.settings.team.propose.event" },
	{ grant: "intents.dispatch:propose-bookmark", labelKey: "shell.settings.team.propose.bookmark" },
	{ grant: "intents.dispatch:propose-contact", labelKey: "shell.settings.team.propose.contact" },
	{ grant: "intents.dispatch:propose-row", labelKey: "shell.settings.team.propose.row" },
	{ grant: "intents.dispatch:propose-database", labelKey: "shell.settings.team.propose.database" },
];

/** Whether the agent may run at all + ground itself in the vault. */
export const TEAM_RUN_GRANTS: readonly TeamGrantOption[] = [
	{ grant: "ai.use", labelKey: "shell.settings.team.run.aiUse" },
	{ grant: "search.read", labelKey: "shell.settings.team.run.searchRead" },
	{ grant: "search.hybrid", labelKey: "shell.settings.team.run.searchHybrid" },
	{ grant: "roster.read", labelKey: "shell.settings.team.run.rosterRead" },
];

/** Split a `service.verb[:scope]` string for the revoke IPC (which takes the
 *  halves the ledger stores). */
export function splitGrant(grant: string): { capability: string; scope: string | null } {
	const colon = grant.indexOf(":");
	if (colon < 0) return { capability: grant, scope: null };
	return { capability: grant.slice(0, colon), scope: grant.slice(colon + 1) };
}

/** The full-string form of an agent's live grants, for checklist state. */
export function heldGrantSet(agent: ShellAgent): Set<string> {
	return new Set(
		agent.grants.map((g) => (g.scope === null ? g.capability : `${g.capability}:${g.scope}`)),
	);
}

/** Initials monogram for an agent avatar (no manifest icon to borrow). */
export function agentInitial(displayName: string): string {
	const first = displayName.trim()[0];
	return first ? first.toUpperCase() : "?";
}

/** One audit line, humanized: the kind's label key + what it touched. The kind
 *  set is open-ended (future writers), so unknown kinds fall back to the raw
 *  kind string rather than vanishing — an audit view must never drop rows. */
export function activityLabel(event: ShellAgentAuditEvent): {
	labelKey: string | null;
	fallback: string;
	detail: string;
} {
	const known: Record<string, string> = {
		"agent.create": "shell.settings.team.activity.created",
		"agent.delete": "shell.settings.team.activity.deleted",
		"agent.grant": "shell.settings.team.activity.granted",
		"agent.revoke": "shell.settings.team.activity.revoked",
		"ipc.denied": "shell.settings.team.activity.denied",
	};
	const capability = typeof event.capability === "string" ? event.capability : "";
	const scope = typeof event.scope === "string" ? event.scope : null;
	const detail = capability ? (scope ? `${capability}:${scope}` : capability) : "";
	return { labelKey: known[event.kind] ?? null, fallback: event.kind, detail };
}

function ActivityList({ events }: { events: ShellAgentAuditEvent[] }) {
	if (events.length === 0) {
		return <p className="team-section__note">{t("shell.settings.team.activity.empty")}</p>;
	}
	return (
		<ul className="team-section__activity">
			{events.map((event, index) => {
				const { labelKey, fallback, detail } = activityLabel(event);
				return (
					<li key={`${event.ts}-${index}`} className="team-section__activity-row">
						<span className="team-section__activity-label">
							{labelKey ? t(labelKey) : fallback}
							{detail ? <span className="team-section__activity-detail"> {detail}</span> : null}
						</span>
						<time className="team-section__activity-time" dateTime={new Date(event.ts).toISOString()}>
							{new Date(event.ts).toLocaleString()}
						</time>
					</li>
				);
			})}
		</ul>
	);
}

function GrantGroup({
	titleKey,
	options,
	held,
	onToggle,
}: {
	titleKey: string;
	options: readonly TeamGrantOption[];
	held: Set<string>;
	onToggle: (grant: string, next: boolean) => void;
}) {
	return (
		<section className="team-section__grant-group">
			<h4 className="team-section__group-title">{t(titleKey)}</h4>
			{options.map((option) => (
				<ToggleRow
					key={option.grant}
					title={t(option.labelKey)}
					checked={held.has(option.grant)}
					onChange={(next) => onToggle(option.grant, next)}
					ariaLabel={t("shell.settings.team.grantToggleAria", { grant: t(option.labelKey) })}
				/>
			))}
		</section>
	);
}

export function TeamSection() {
	const [agents, setAgents] = useState<ShellAgent[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [openId, setOpenId] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [draftName, setDraftName] = useState("");
	const [draftPersona, setDraftPersona] = useState("");
	const [personaDraft, setPersonaDraft] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			setAgents(await window.brainstorm.agents.list());
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const onCreate = useCallback(async () => {
		const displayName = draftName.trim();
		if (!displayName || creating) return;
		setCreating(true);
		try {
			const created = await window.brainstorm.agents.create({
				displayName,
				persona: draftPersona,
			});
			setDraftName("");
			setDraftPersona("");
			await refresh();
			if (created) setOpenId(created.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreating(false);
		}
	}, [draftName, draftPersona, creating, refresh]);

	const onToggleGrant = useCallback(
		async (agent: ShellAgent, grant: string, next: boolean) => {
			try {
				if (next) {
					const result = await window.brainstorm.agents.grant(agent.fingerprint, grant);
					if (!result.granted) {
						setError(t(`shell.settings.team.grantRefused.${result.reason}`));
					}
				} else {
					const { capability, scope } = splitGrant(grant);
					await window.brainstorm.agents.revoke(agent.fingerprint, capability, scope);
				}
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[refresh],
	);

	const onSavePersona = useCallback(
		async (agent: ShellAgent) => {
			if (personaDraft === null) return;
			try {
				await window.brainstorm.agents.update(agent.id, { persona: personaDraft });
				setPersonaDraft(null);
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[personaDraft, refresh],
	);

	const onDelete = useCallback(
		async (agent: ShellAgent) => {
			const confirmed = await confirm({
				title: t("shell.settings.team.deleteConfirm.title"),
				body: t("shell.settings.team.deleteConfirm.body", { name: agent.displayName }),
				confirmLabel: t("shell.settings.team.delete"),
				confirmVariant: ConfirmVariant.Destructive,
			});
			if (!confirmed) return;
			try {
				await window.brainstorm.agents.delete(agent.id);
				setOpenId(null);
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		},
		[refresh],
	);

	const openAgent = openId ? agents.find((a) => a.id === openId) : undefined;
	const held = openAgent ? heldGrantSet(openAgent) : new Set<string>();

	// The open agent's audit trail. `openAgent` is a fresh object after every
	// refresh(), so a grant/revoke toggle refetches and the new history line
	// shows up immediately.
	const [activity, setActivity] = useState<ShellAgentAuditEvent[]>([]);
	useEffect(() => {
		if (!openAgent) {
			setActivity([]);
			return;
		}
		let live = true;
		void window.brainstorm.agents.activity(openAgent.fingerprint).then((events) => {
			if (live) setActivity(events);
		});
		return () => {
			live = false;
		};
	}, [openAgent]);

	return (
		<div className="team-section" data-testid="team-section">
			<p className="team-section__intro">{t("shell.settings.team.intro")}</p>

			{error ? (
				<p className="settings__error" role="alert">
					{error}
				</p>
			) : null}

			{loading ? (
				<p className="settings__loading">{t("shell.common.loading")}</p>
			) : agents.length === 0 ? (
				<p className="settings__empty">{t("shell.settings.team.empty")}</p>
			) : (
				<ul className="grants-panel" data-testid="team-directory">
					{agents.map((agent) => (
						<li key={agent.id}>
							<button
								type="button"
								className="grants-panel__app"
								onClick={() => {
									setPersonaDraft(null);
									setOpenId(agent.id);
								}}
								aria-label={t("shell.settings.team.manageAria", { name: agent.displayName })}
							>
								<span className="team-section__avatar" aria-hidden="true">
									{agentInitial(agent.displayName)}
								</span>
								<span className="grants-panel__app-text">
									<span className="grants-panel__app-name">{agent.displayName}</span>
									<span className="grants-panel__app-count">
										{t("shell.settings.team.memberSummary", {
											count: agent.grants.length,
										})}
									</span>
								</span>
								<span className="grants-panel__manage">{t("shell.settings.security.manage")}</span>
							</button>
						</li>
					))}
				</ul>
			)}

			<section className="team-section__create">
				<h4 className="team-section__group-title">{t("shell.settings.team.create.title")}</h4>
				<TextField
					size={TextFieldSize.Md}
					value={draftName}
					onChange={setDraftName}
					placeholder={t("shell.settings.team.create.namePlaceholder")}
					aria-label={t("shell.settings.team.create.nameAria")}
				/>
				<TextArea
					value={draftPersona}
					onChange={setDraftPersona}
					placeholder={t("shell.settings.team.create.personaPlaceholder")}
					aria-label={t("shell.settings.team.create.personaAria")}
					rows={3}
				/>
				<div className="team-section__create-actions">
					<Button
						variant={ButtonVariant.Primary}
						size={ButtonSize.Md}
						onClick={() => void onCreate()}
						disabled={!draftName.trim() || creating}
					>
						{t("shell.settings.team.create.submit")}
					</Button>
				</div>
			</section>

			{openAgent && (
				<Popover
					title={
						<span className="grants-panel__dialog-title">
							<span className="team-section__avatar" aria-hidden="true">
								{agentInitial(openAgent.displayName)}
							</span>
							{openAgent.displayName}
						</span>
					}
					onClose={() => setOpenId(null)}
					size={PopoverSize.Medium}
					bodyPadding={PopoverBodyPadding.Comfortable}
					testId="team-agent-popover"
				>
					<div className="team-section__sheet">
						<p className="team-section__fingerprint" title={openAgent.pubkey}>
							{openAgent.fingerprint}
						</p>

						<section className="team-section__grant-group">
							<h4 className="team-section__group-title">{t("shell.settings.team.persona.title")}</h4>
							<TextArea
								value={personaDraft ?? openAgent.persona}
								onChange={setPersonaDraft}
								placeholder={t("shell.settings.team.persona.placeholder")}
								aria-label={t("shell.settings.team.persona.aria")}
								rows={4}
							/>
							<div className="team-section__create-actions">
								<Button
									variant={ButtonVariant.Neutral}
									size={ButtonSize.Md}
									onClick={() => void onSavePersona(openAgent)}
									disabled={personaDraft === null || personaDraft === openAgent.persona}
								>
									{t("shell.settings.team.persona.save")}
								</Button>
							</div>
						</section>

						<GrantGroup
							titleKey="shell.settings.team.group.read"
							options={TEAM_READ_GRANTS}
							held={held}
							onToggle={(grant, next) => void onToggleGrant(openAgent, grant, next)}
						/>
						<GrantGroup
							titleKey="shell.settings.team.group.propose"
							options={TEAM_PROPOSE_GRANTS}
							held={held}
							onToggle={(grant, next) => void onToggleGrant(openAgent, grant, next)}
						/>
						<GrantGroup
							titleKey="shell.settings.team.group.run"
							options={TEAM_RUN_GRANTS}
							held={held}
							onToggle={(grant, next) => void onToggleGrant(openAgent, grant, next)}
						/>
						<p className="team-section__note">{t("shell.settings.team.noWriteNote")}</p>

						<section className="team-section__grant-group">
							<h4 className="team-section__group-title">{t("shell.settings.team.activity.title")}</h4>
							<ActivityList events={activity} />
						</section>

						<div className="team-section__danger">
							<Button
								variant={ButtonVariant.Destructive}
								size={ButtonSize.Md}
								onClick={() => void onDelete(openAgent)}
							>
								{t("shell.settings.team.delete")}
							</Button>
						</div>
					</div>
				</Popover>
			)}
		</div>
	);
}
