import { PresenceActivity, type PresencePeer } from "@brainstorm-os/sdk/presence-stack";
import { describe, expect, it } from "vitest";
import { TypingLabel, typingLabel, typingPeers } from "./typing";

const peer = (id: string, name: string, typing = true): PresencePeer => ({
	id,
	name,
	color: "#000",
	...(typing ? { activity: PresenceActivity.Typing } : {}),
});

describe("typing indicator (Chats-4)", () => {
	it("keeps distinct other members who are typing", () => {
		const out = typingPeers(
			[peer("a", "Ada"), peer("a", "Ada (tab 2)"), peer("me", "Me"), peer("b", "Ben", false)],
			"me",
		);
		expect(out.map((p) => p.name)).toEqual(["Ada"]);
	});

	it("names one or two typers and summarises more", () => {
		expect(typingLabel([])).toBeNull();
		expect(typingLabel([peer("a", "Ada")])).toEqual({
			key: TypingLabel.One,
			params: { name: "Ada" },
		});
		expect(typingLabel([peer("a", "Ada"), peer("b", "Ben")])).toEqual({
			key: TypingLabel.Two,
			params: { a: "Ada", b: "Ben" },
		});
		expect(typingLabel([peer("a", "A"), peer("b", "B"), peer("c", "C")])?.key).toBe(TypingLabel.Many);
	});
});
