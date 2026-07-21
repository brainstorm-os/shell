import { SHELL_IDENTITY } from "@brainstorm-os/capabilities/default-grants";
import { describe, expect, it } from "vitest";
import { RendererIdentityRegistry, registerDashboard } from "./renderer-identity";

describe("RendererIdentityRegistry", () => {
	it("register + get round-trips", () => {
		const reg = new RendererIdentityRegistry();
		reg.register(7, "io.example.app");
		expect(reg.get(7)).toBe("io.example.app");
	});

	it("unregister removes the mapping", () => {
		const reg = new RendererIdentityRegistry();
		reg.register(7, "io.example.app");
		reg.unregister(7);
		expect(reg.get(7)).toBeUndefined();
	});

	it("verify accepts a matching claim from a known WebContents id", () => {
		const reg = new RendererIdentityRegistry();
		reg.register(7, "io.example.app");
		expect(reg.verify("io.example.app", 7)).toBe(true);
		expect(reg.verify("io.example.app", { webContentsId: 7 })).toBe(true);
	});

	it("verify rejects a mismatched claim", () => {
		const reg = new RendererIdentityRegistry();
		reg.register(7, "io.example.app");
		expect(reg.verify("io.example.other", 7)).toBe(false);
	});

	it("verify rejects unknown WebContents", () => {
		const reg = new RendererIdentityRegistry();
		expect(reg.verify("io.example.app", 42)).toBe(false);
	});

	it("verify rejects malformed source", () => {
		const reg = new RendererIdentityRegistry();
		reg.register(7, "shell");
		expect(reg.verify("shell", "not-a-number")).toBe(false);
		expect(reg.verify("shell", null)).toBe(false);
		expect(reg.verify("shell", -1)).toBe(false);
		expect(reg.verify("shell", 1.5)).toBe(false);
		expect(reg.verify("shell", { somethingElse: 7 })).toBe(false);
	});

	it("registerDashboard tags the WebContents as the shell identity", () => {
		const reg = new RendererIdentityRegistry();
		registerDashboard(reg, 1);
		expect(reg.get(1)).toBe(SHELL_IDENTITY);
		expect(reg.verify(SHELL_IDENTITY, 1)).toBe(true);
	});

	it("size() reports the number of registered renderers", () => {
		const reg = new RendererIdentityRegistry();
		expect(reg.size()).toBe(0);
		reg.register(1, "shell");
		reg.register(2, "io.example.app");
		expect(reg.size()).toBe(2);
		reg.unregister(1);
		expect(reg.size()).toBe(1);
	});

	it("re-registering the same WebContents updates the mapping", () => {
		const reg = new RendererIdentityRegistry();
		reg.register(7, "old");
		reg.register(7, "new");
		expect(reg.get(7)).toBe("new");
	});
});
