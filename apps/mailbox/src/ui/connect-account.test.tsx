// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectAccountDialog, type ReconnectSeed } from "./connect-account";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const seed: ReconnectSeed = {
	accountRef: "acct-9",
	address: "ra3or@list.ru",
	incoming: { host: "imap.mail.ru", port: 993, tls: true },
	outgoing: { host: "smtp.mail.ru", port: 465, tls: true },
	syncWindow: "1y",
};

function setInput(el: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
	setter?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ConnectAccountDialog — reconnect-in-place (Mailbox-13)", () => {
	it("prefills the account's coordinates, locks the mode, and submits to the same accountRef", () => {
		const onConnectImap = vi.fn().mockResolvedValue(undefined);
		act(() => {
			root.render(
				<ConnectAccountDialog
					onClose={() => {}}
					onConnect={async () => {}}
					onConnectImap={onConnectImap}
					reconnect={seed}
				/>,
			);
		});
		// Mode toggle hidden — this dialog repairs ONE known account.
		expect(host.querySelector(".bs-segmented")).toBeNull();
		const inputs = [...host.querySelectorAll<HTMLInputElement>("input")];
		const byValue = (v: string) => inputs.find((i) => i.value === v);
		expect(byValue("ra3or@list.ru")).toBeDefined();
		expect(byValue("imap.mail.ru")).toBeDefined();
		expect(byValue("smtp.mail.ru")).toBeDefined();

		const password = inputs.find((i) => i.type === "password");
		expect(password).toBeDefined();
		if (!password) return;
		act(() => setInput(password, "new-app-password"));
		const form = host.querySelector("form");
		act(() => {
			form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(onConnectImap).toHaveBeenCalledTimes(1);
		expect(onConnectImap.mock.calls[0]?.[0]).toMatchObject({
			accountRef: "acct-9",
			address: "ra3or@list.ru",
			secret: "new-app-password",
			incoming: { host: "imap.mail.ru", port: 993, tls: true },
			syncWindow: "1y",
		});
	});

	it("without a reconnect seed the dialog still creates accounts (toggle present, no accountRef)", () => {
		const onConnectImap = vi.fn().mockResolvedValue(undefined);
		act(() => {
			root.render(
				<ConnectAccountDialog
					onClose={() => {}}
					onConnect={async () => {}}
					onConnectImap={onConnectImap}
				/>,
			);
		});
		expect(host.querySelector(".bs-segmented")).not.toBeNull();
	});
});
