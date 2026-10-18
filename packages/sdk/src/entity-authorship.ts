/**
 * Agent-16 / Collab-C7 — an object's authorship, as the shared inspector shows
 * it: which agent created it (from the server-stamped provenance, projected as
 * the derived `createdByAgent` property — never anything a client wrote) and,
 * for a shared object, who edited it last (the shell records the authenticated
 * editor on the sync path; the host resolves a display name via the roster).
 *
 * Pure: the panel calls {@link authorshipMeta} to turn this into meta rows, so
 * every app that renders `<PropertiesPanel authorship={…}>` reads the same.
 */

import {
	CREATED_BY_AGENT_PROPERTY_KEY,
	type RosterMember,
	type RosterService,
	type SharingService,
	readAgentProvenance,
} from "@brainstorm-os/sdk-types";
import { humanizeKey } from "./humanize-key";
import { type AuthorshipLabels, DEFAULT_AUTHORSHIP_LABELS } from "./i18n/common-labels";

const FINGERPRINT_PREFIX = "ed25519:";
const FINGERPRINT_SHOWN = 8;

/** The last editor of a shared object, already resolved to a display name. */
export type LastEditView = { name: string; at: number };

export type AuthorshipInput = {
	/** The object's property bag as read (snapshot row / `entities.get`). */
	properties?: Readonly<Record<string, unknown>> | null | undefined;
	/** Display names for agent principals (app id or `ed25519:` fingerprint),
	 *  when the host knows them. */
	agentNames?: Readonly<Record<string, string>>;
	lastEdit?: LastEditView | null;
	labels?: Partial<AuthorshipLabels>;
	formatTime?: (ms: number) => string;
};

/** The agent principal that created the object, or null. */
export function createdByAgentOf(
	properties: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
	if (!properties) return null;
	const derived = properties[CREATED_BY_AGENT_PROPERTY_KEY];
	if (typeof derived === "string" && derived !== "") return derived;
	return readAgentProvenance(properties as Record<string, unknown>)?.agent ?? null;
}

/** A legible name for an agent principal: a host-supplied name first; else an
 *  app id reads as its last segment ("io.brainstorm.agent" → "Agent") and a
 *  key fingerprint is shortened. */
export function agentDisplayName(agent: string, names?: Readonly<Record<string, string>>): string {
	const known = names?.[agent];
	if (known) return known;
	if (agent.startsWith(FINGERPRINT_PREFIX)) {
		const hex = agent.slice(FINGERPRINT_PREFIX.length);
		return hex.length > FINGERPRINT_SHOWN
			? `${FINGERPRINT_PREFIX}${hex.slice(0, FINGERPRINT_SHOWN)}…`
			: agent;
	}
	const last = agent.split(".").pop() ?? agent;
	return humanizeKey(last) || agent;
}

function defaultTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** The authorship rows for an object, in display order. Empty when there is
 *  nothing to say (a human-created, unshared object). */
export function authorshipMeta(
	input: AuthorshipInput,
): Array<{ label: string; value: string; title?: string }> {
	const labels = { ...DEFAULT_AUTHORSHIP_LABELS, ...input.labels };
	const rows: Array<{ label: string; value: string; title?: string }> = [];
	const agent = createdByAgentOf(input.properties);
	if (agent) {
		rows.push({
			label: labels.createdBy,
			value: agentDisplayName(agent, input.agentNames),
			title: agent,
		});
	}
	if (input.lastEdit) {
		const time = (input.formatTime ?? defaultTime)(input.lastEdit.at);
		rows.push({
			label: labels.lastEdited,
			value: labels.lastEditedValue.replace("{name}", input.lastEdit.name).replace("{time}", time),
		});
	}
	return rows;
}

/** Collab-C7 — the last editor of a shared object, resolved to a display name
 *  through the roster (the editor key is the roster's join key). `youLabel`
 *  names the local user. An editor no longer on the roster reads as a short
 *  key. Null when nothing is recorded or the shell does not expose it. */
export async function resolveLastEdit(
	sharing: Pick<SharingService, "lastEdit">,
	roster: Pick<RosterService, "members"> | null,
	entityId: string,
	youLabel: string,
	members?: readonly RosterMember[],
): Promise<LastEditView | null> {
	if (!sharing.lastEdit) return null;
	const edit = await sharing.lastEdit(entityId);
	if (!edit) return null;
	let roll = members;
	if (!roll && roster) {
		try {
			roll = await roster.members(entityId);
		} catch {
			roll = [];
		}
	}
	const member = roll?.find((m) => m.pubkey === edit.editor);
	const name = member
		? member.isSelf
			? youLabel
			: member.displayName || member.fingerprint
		: `${edit.editor.slice(0, FINGERPRINT_SHOWN)}…`;
	return { name, at: edit.editedAt };
}
