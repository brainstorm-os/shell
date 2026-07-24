// @vitest-environment jsdom
/**
 * Collab-C5 — `<ShareDialog>` over mocked `sharing` + `roster` services:
 * renders the member list, an Owner adds by pasted code (→ `sharing.share`,
 * reloads), revokes a member (→ `sharing.revoke`), and mints their own invite
 * code (→ `sharing.createInvite`). A non-manager sees the read-only list with no
 * add section + no revoke affordances.
 */

import type { RosterMember, RosterService, SharingService } from "@brainstorm-os/sdk-types";
import { RosterMemberKind, RosterRole } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareDialog, type ShareDialogLabels } from "./share-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS: ShareDialogLabels = {
	title: "Share",
	membersHeading: "People with access",
	you: "you",
	roleOwner: "Owner",
	roleEditor: "Can edit",
	roleViewer: "Can view",
	revoke: "Remove",
	addHeading: "Add people",
	codePlaceholder: "Paste an invite code",
	canEdit: "Can edit",
	canView: "Can view",
	add: "Add",
	quickAddHeading: "Add a teammate",
	inviteHeading: "Your invite code",
	getCode: "Get my invite code",
	copy: "Copy",
	copied: "Copied",
	inviteHint: "Share this code so someone can add you.",
	shareFailed: "Couldn't share.",
	revokeFailed: "Couldn't remove.",
	loadFailed: "Couldn't load members.",
	done: "Done",
};

function member(
	pubkey: string,
	role: RosterRole,
	isSelf = false,
	displayName?: string,
): RosterMember {
	return {
		pubkey,
		role,
		kind: RosterMemberKind.Human,
		isSelf,
		fingerprint: `ed25519:${pubkey}`,
		...(displayName ? { displayName } : {}),
	};
}

const flush = () =>
	act(async () => {
		await Promise.resolve();
	});

/** Set a controlled input's value through React's tracked native setter so its
 *  `onChange` fires (a bare `input.value = …` is invisible to React). */
function typeInto(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ShareDialog", () => {
	let host: HTMLDivElement;
	let root: Root;
	let sharing: {
		createInvite: ReturnType<typeof vi.fn<SharingService["createInvite"]>>;
		share: ReturnType<typeof vi.fn<SharingService["share"]>>;
		shareCollection: ReturnType<typeof vi.fn<SharingService["shareCollection"]>>;
		saveContact: ReturnType<typeof vi.fn<SharingService["saveContact"]>>;
		listContacts: ReturnType<typeof vi.fn<SharingService["listContacts"]>>;
		revoke: ReturnType<typeof vi.fn<SharingService["revoke"]>>;
	};
	let roster: { members: ReturnType<typeof vi.fn<RosterService["members"]>> };

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		sharing = {
			createInvite: vi.fn<SharingService["createInvite"]>(async () => "INVITE-TOKEN-XYZ"),
			share: vi.fn<SharingService["share"]>(async () => []),
			shareCollection: vi.fn<SharingService["shareCollection"]>(async () => []),
			saveContact: vi.fn<SharingService["saveContact"]>(async () => ({
				pubkey: "p",
				displayName: "",
			})),
			listContacts: vi.fn<SharingService["listContacts"]>(async () => []),
			revoke: vi.fn<SharingService["revoke"]>(async () => []),
		};
		roster = {
			members: vi.fn<RosterService["members"]>(async () => [
				member("owner1", RosterRole.Owner, true, "Mira"),
				member("guest1", RosterRole.Editor, false, "Marcus"),
			]),
		};
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		vi.restoreAllMocks();
	});

	async function mount(canManage: boolean): Promise<void> {
		await act(async () => {
			root.render(
				<ShareDialog
					entityId="ent_1"
					entityType="brainstorm/Note/v1"
					sharing={sharing}
					roster={roster}
					canManage={canManage}
					labels={LABELS}
					onClose={() => undefined}
				/>,
			);
		});
		await flush();
	}

	const rows = () => host.querySelectorAll<HTMLElement>(".bs-share__member");
	const codeInput = () =>
		host.querySelector<HTMLInputElement>(".bs-share__add .bs-share__code-input");
	const addBtn = () =>
		[...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add");

	it("renders the member list from roster.members (self tagged)", async () => {
		await mount(true);
		expect(roster.members).toHaveBeenCalledWith("ent_1");
		expect(rows().length).toBe(2);
		expect(host.textContent).toContain("Mira (you)");
		expect(host.textContent).toContain("Marcus");
	});

	it("Owner adds by pasted code → sharing.share with the chosen role, then reloads", async () => {
		await mount(true);
		const input = codeInput();
		if (!input) throw new Error("expected code input for a manager");
		await act(async () => typeInto(input, "PASTED-CODE"));
		await act(async () => addBtn()?.click());
		await flush();
		expect(sharing.share).toHaveBeenCalledWith({
			entityId: "ent_1",
			type: "brainstorm/Note/v1",
			invite: "PASTED-CODE",
			role: RosterRole.Editor,
		});
		// Reloaded after the share (initial mount + post-share).
		expect(roster.members.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("Enter in the code field submits the add (no click needed)", async () => {
		await mount(true);
		const input = codeInput();
		if (!input) throw new Error("expected code input for a manager");
		await act(async () => typeInto(input, "PASTED-CODE"));
		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		await flush();
		expect(sharing.share).toHaveBeenCalledWith({
			entityId: "ent_1",
			type: "brainstorm/Note/v1",
			invite: "PASTED-CODE",
			role: RosterRole.Editor,
		});
	});

	it("Enter with an empty code field does nothing", async () => {
		await mount(true);
		const input = codeInput();
		if (!input) throw new Error("expected code input for a manager");
		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		await flush();
		expect(sharing.share).not.toHaveBeenCalled();
	});

	it("collection mode adds via sharing.shareCollection (cascade), not share", async () => {
		await act(async () => {
			root.render(
				<ShareDialog
					entityId="chan_1"
					entityType="io.brainstorm.chat/Channel/v1"
					collection
					sharing={sharing}
					roster={roster}
					canManage
					labels={LABELS}
					onClose={() => undefined}
				/>,
			);
		});
		await flush();
		const input = codeInput();
		if (!input) throw new Error("expected code input for a manager");
		await act(async () => typeInto(input, "PASTED-CODE"));
		await act(async () => addBtn()?.click());
		await flush();
		expect(sharing.shareCollection).toHaveBeenCalledWith({
			entityId: "chan_1",
			type: "io.brainstorm.chat/Channel/v1",
			invite: "PASTED-CODE",
			role: RosterRole.Editor,
		});
		expect(sharing.share).not.toHaveBeenCalled();
	});

	it("share-by-name: a known non-member contact renders as a chip and shares by contact", async () => {
		sharing.listContacts.mockResolvedValue([{ pubkey: "carol-pub", displayName: "Carol" }]);
		roster.members.mockResolvedValue([]); // no current members → Carol is a pick
		await mount(true);
		const chip = [...host.querySelectorAll<HTMLButtonElement>(".bs-share__contact")].find((b) =>
			b.textContent?.includes("Carol"),
		);
		if (!chip) throw new Error("expected a Carol quick-add chip");
		await act(async () => chip.click());
		await flush();
		expect(sharing.share).toHaveBeenCalledWith({
			entityId: "ent_1",
			type: "brainstorm/Note/v1",
			contact: "carol-pub",
			role: RosterRole.Editor,
		});
	});

	it("Owner revokes a non-owner member → sharing.revoke", async () => {
		await mount(true);
		const revokeBtn = host.querySelector<HTMLButtonElement>(".bs-share__revoke");
		if (!revokeBtn) throw new Error("expected a revoke button for the editor");
		await act(async () => revokeBtn.click());
		await flush();
		expect(sharing.revoke).toHaveBeenCalledWith({
			entityId: "ent_1",
			type: "brainstorm/Note/v1",
			member: "guest1",
		});
	});

	it("mints the local invite code through sharing.createInvite", async () => {
		await mount(true);
		const getBtn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(b) => b.textContent === "Get my invite code",
		);
		if (!getBtn) throw new Error("expected the get-code button");
		await act(async () => getBtn.click());
		await flush();
		expect(sharing.createInvite).toHaveBeenCalled();
		const readonly = host.querySelector<HTMLInputElement>(".bs-share__invite .bs-share__code-input");
		expect(readonly?.value).toBe("INVITE-TOKEN-XYZ");
	});

	it("a non-manager sees no add section and no revoke affordances", async () => {
		await mount(false);
		expect(rows().length).toBe(2);
		expect(codeInput()).toBeNull();
		expect(host.querySelector(".bs-share__revoke")).toBeNull();
	});
});
