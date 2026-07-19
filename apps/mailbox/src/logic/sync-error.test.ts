import { describe, expect, it } from "vitest";
import { SyncErrorClass, classifySyncError } from "./sync-error";

describe("classifySyncError (F-445)", () => {
	it("auth rejections", () => {
		expect(classifySyncError("imap: authentication failed")).toBe(SyncErrorClass.Auth);
	});
	it("connectivity failures speak human, not errno", () => {
		for (const m of [
			"imap: connect ECONNREFUSED 127.0.0.1:59993",
			"getaddrinfo ENOTFOUND imap.example.test",
			"Socket timeout",
			"connect ETIMEDOUT 10.0.0.1:993",
			"self signed certificate",
		])
			expect(classifySyncError(m)).toBe(SyncErrorClass.Connect);
	});
	it("everything else passes through", () => {
		expect(classifySyncError("mailbox worker crashed")).toBe(SyncErrorClass.Other);
	});
});
