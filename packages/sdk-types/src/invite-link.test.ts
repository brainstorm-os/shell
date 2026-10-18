import { describe, expect, it } from "vitest";
import {
	DEFAULT_SHARE_ROLE,
	RosterRole,
	inviteLinkFor,
	inviteTokenFromInput,
	parseInviteLink,
	parseShareDefaultRole,
} from "./index";

const TOKEN = "eyJ2IjoyLCJ1c2VyUHViQjY0IjoiQUFBQSJ9_-xyz";

describe("invite deep links (Collab-C7)", () => {
	it("round-trips a token through its link", () => {
		expect(parseInviteLink(inviteLinkFor(TOKEN))).toBe(TOKEN);
	});

	it("refuses anything that is not exactly prefix + one bounded base64url segment", () => {
		for (const url of [
			`${inviteLinkFor(TOKEN)}?x=1`,
			`${inviteLinkFor(TOKEN)}#frag`,
			`${inviteLinkFor(TOKEN)}/more`,
			`${inviteLinkFor(TOKEN)} `,
			`brainstorm://invite/${TOKEN.replace("_", "%5F")}`,
			`brainstorm://entity/${TOKEN}`,
			`https://invite/${TOKEN}`,
			"brainstorm://invite/",
			"brainstorm://invite/tooShort",
			`brainstorm://invite/${"a".repeat(5000)}`,
			null,
			{},
		]) {
			expect(parseInviteLink(url)).toBeNull();
		}
	});

	it("reduces a pasted link to its code and leaves a raw code alone", () => {
		expect(inviteTokenFromInput(`  ${inviteLinkFor(TOKEN)}\n`)).toBe(TOKEN);
		expect(inviteTokenFromInput(" RAW-CODE ")).toBe("RAW-CODE");
	});

	it("defaults new shares to Viewer and never to Owner", () => {
		expect(DEFAULT_SHARE_ROLE).toBe(RosterRole.Viewer);
		expect(parseShareDefaultRole(RosterRole.Editor)).toBe(RosterRole.Editor);
		expect(parseShareDefaultRole(RosterRole.Owner)).toBe(RosterRole.Viewer);
		expect(parseShareDefaultRole("anything")).toBe(RosterRole.Viewer);
	});
});
