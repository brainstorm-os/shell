/**
 * Contacts store (Collab-C5 / C6-d — share-by-name foundation, design 71).
 *
 * Per-vault directory of the people you collaborate with: each contact is a
 * VERIFIED {@link ShareInvite} (a signed bundle binding a display name's
 * Ed25519 identity to an X25519 wrapping key) saved under a display name. Once a
 * teammate's invite has been accepted once (pasted, scanned, or seeded), the
 * share UI can offer them as a click-to-share pick — no re-pasting a code — and
 * `shareCollection` reuses the stored invite to wrap the DEK to them.
 *
 * Per VAULT, not per device (contacts are "who I share THIS vault's work with",
 * vault data — unlike the per-device selective-sync policy). Stored at
 * `<vault>/shell/contacts.json`. Fail-safe: a missing/corrupt file reads as an
 * empty directory (never throws into the share flow). An invite that does not
 * cryptographically verify is REFUSED on add — a contact's wrapping key is only
 * ever trusted through the signature that binds it to their identity.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { type ShareInvite, isShareInvite, verifyShareInvite } from "./share-invite";

const CONTACTS_FILE_NAME = "contacts.json";
const CONTACTS_VERSION = 1 as const;

/** One saved contact: a display name + the verified invite that carries their
 *  sovereign Ed25519 identity and X25519 wrapping key (bound by `invite.sig`). */
export type Contact = {
	displayName: string;
	invite: ShareInvite;
};

type ContactsFile = {
	v: typeof CONTACTS_VERSION;
	/** Keyed by the contact's base64 sovereign Ed25519 pubkey (`invite.userPubB64`). */
	contacts: Record<string, Contact>;
};

export function contactsStorePath(vaultPath: string): string {
	return join(vaultPath, "shell", CONTACTS_FILE_NAME);
}

function isContact(value: unknown): value is Contact {
	if (!value || typeof value !== "object") return false;
	const c = value as Partial<Contact>;
	return typeof c.displayName === "string" && isShareInvite(c.invite);
}

export class ContactsStore {
	#cache: Map<string, Contact> | null = null;
	readonly #path: string;

	constructor(options: { readonly path: string }) {
		this.#path = options.path;
	}

	/** Save (or update) a contact from a verified invite under `displayName`,
	 *  keyed by the invite's sovereign pubkey. Throws on an invite that fails
	 *  cryptographic verification — fail-closed, never store an unverifiable key.
	 *  Re-adding the same pubkey updates the display name + refreshes the invite. */
	async add(displayName: string, invite: ShareInvite): Promise<Contact> {
		if (!verifyShareInvite(invite)) {
			throw new Error("contacts-store: invite failed verification");
		}
		const map = await this.#loaded();
		const contact: Contact = { displayName, invite };
		map.set(invite.userPubB64, contact);
		await this.#writeToDisk(map);
		return contact;
	}

	/** Every saved contact, display-name-sorted (stable for the picker). */
	async list(): Promise<Contact[]> {
		const map = await this.#loaded();
		return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
	}

	/** The contact for a sovereign pubkey, or null. Used by the share flow to
	 *  recover a teammate's verified invite for a click-to-share. */
	async get(userPubB64: string): Promise<Contact | null> {
		const map = await this.#loaded();
		return map.get(userPubB64) ?? null;
	}

	/** Remove a contact by pubkey. Returns true if one was removed. */
	async remove(userPubB64: string): Promise<boolean> {
		const map = await this.#loaded();
		if (!map.delete(userPubB64)) return false;
		await this.#writeToDisk(map);
		return true;
	}

	async #loaded(): Promise<Map<string, Contact>> {
		if (this.#cache) return this.#cache;
		this.#cache = await this.#readFromDisk();
		return this.#cache;
	}

	async #readFromDisk(): Promise<Map<string, Contact>> {
		let raw: string;
		try {
			raw = await fs.readFile(this.#path, "utf8");
		} catch {
			return new Map();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return new Map();
		}
		const contacts = (parsed as Partial<ContactsFile> | null)?.contacts;
		if (!contacts || typeof contacts !== "object") return new Map();
		const map = new Map<string, Contact>();
		for (const [pub, value] of Object.entries(contacts)) {
			// Re-verify on read too: a tampered file can't smuggle in a contact
			// whose wrapping key isn't signed by its identity.
			if (isContact(value) && value.invite.userPubB64 === pub && verifyShareInvite(value.invite)) {
				map.set(pub, value);
			}
		}
		return map;
	}

	async #writeToDisk(map: Map<string, Contact>): Promise<void> {
		const file: ContactsFile = { v: CONTACTS_VERSION, contacts: Object.fromEntries(map) };
		await fs.mkdir(dirname(this.#path), { recursive: true });
		await fs.writeFile(this.#path, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	}
}
