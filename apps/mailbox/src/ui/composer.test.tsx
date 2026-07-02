// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySeed } from "../logic/compose";
import type { AccountView } from "../types/mail-view";
import { Composer } from "./composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const account: AccountView = { id: "acc-1", address: "me@example.test", displayName: "Me" };

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

describe("Composer spellcheck surfaces (B11.16b)", () => {
	it("opts prose surfaces (subject/body) in and address surfaces (to/cc) out", () => {
		act(() => {
			root.render(
				<Composer
					seed={emptySeed(account.id)}
					accounts={[account]}
					onClose={() => {}}
					onSend={async () => {}}
				/>,
			);
		});
		const inputs = host.querySelectorAll("input.bs-input");
		const body = host.querySelector(".mb-compose__body") as HTMLTextAreaElement;
		// Field order in the form: to, cc, subject.
		const toEl = inputs[0] as HTMLInputElement;
		const ccEl = inputs[1] as HTMLInputElement;
		const subjectEl = inputs[2] as HTMLInputElement;
		// Address fields are structured text (opt out); subject + body are prose.
		expect(toEl.getAttribute("spellcheck")).toBe("false");
		expect(ccEl.getAttribute("spellcheck")).toBe("false");
		expect(subjectEl.getAttribute("spellcheck")).toBe("true");
		expect(body.getAttribute("spellcheck")).toBe("true");
	});
});

describe("Composer send dispatch", () => {
	it("dispatches the validated send payload and closes on success", async () => {
		const onSend = vi.fn(async (_payload: Record<string, unknown>) => {});
		const onClose = vi.fn();
		act(() => {
			root.render(
				<Composer
					seed={{ ...emptySeed(account.id), to: "you@example.test", subject: "Hi" }}
					accounts={[account]}
					onClose={onClose}
					onSend={onSend}
				/>,
			);
		});
		const form = host.querySelector("form") as HTMLFormElement;
		await act(async () => {
			form.requestSubmit();
		});
		expect(onSend).toHaveBeenCalledTimes(1);
		const payload = onSend.mock.calls[0]?.[0] ?? {};
		expect(payload.accountRef).toBe(account.id);
		expect(payload.to).toEqual(["you@example.test"]);
		expect(payload.subject).toBe("Hi");
		expect(typeof payload.submissionId).toBe("string");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("does not dispatch without a recipient", () => {
		const onSend = vi.fn(async () => {});
		act(() => {
			root.render(
				<Composer
					seed={emptySeed(account.id)}
					accounts={[account]}
					onClose={() => {}}
					onSend={onSend}
				/>,
			);
		});
		const form = host.querySelector("form") as HTMLFormElement;
		act(() => {
			form.requestSubmit();
		});
		expect(onSend).not.toHaveBeenCalled();
	});
});
