import { describe, expect, it } from "vitest";
import { createEditorT } from "./i18n";
import { MEDIA_COMMAND_IDS, createMediaBlockCommands } from "./media-commands";
import { AudioBlockNode } from "./nodes/audio-block-node";
import { FileBlockNode } from "./nodes/file-block-node";
import { ImageBlockNode } from "./nodes/image-block-node";
import { InlineImageNode } from "./nodes/inline-image-node";
import { VideoBlockNode } from "./nodes/video-block-node";
import { FULL_EDITOR_NODES, MEDIA_NODES } from "./standard-nodes";

describe("createMediaBlockCommands", () => {
	it("exposes the media commands in display order, all in the Media category", () => {
		const commands = createMediaBlockCommands(createEditorT());
		expect(commands.map((c) => c.id)).toEqual(MEDIA_COMMAND_IDS);
		expect(commands.map((c) => c.id)).toEqual([
			"block.media.image",
			"block.media.image.vault",
			"block.media.image.inline",
			"block.media.video",
			"block.media.audio",
			"block.media.file",
			"block.media.file.vault",
		]);
		for (const command of commands) {
			expect(command.category).toBe("media");
			expect(command.label.length).toBeGreaterThan(0);
		}
	});

	it("localises labels through the editor i18n seam", () => {
		const commands = createMediaBlockCommands(createEditorT({ "editor.media.image": "Bild" }));
		const image = commands.find((c) => c.id === "block.media.image");
		expect(image?.label).toBe("Bild");
	});
});

describe("media node registration", () => {
	it("MEDIA_NODES carries the media classes", () => {
		expect(MEDIA_NODES).toEqual([
			ImageBlockNode,
			InlineImageNode,
			VideoBlockNode,
			AudioBlockNode,
			FileBlockNode,
		]);
	});

	it("FULL_EDITOR_NODES includes every media node so peer-authored media renders", () => {
		for (const node of MEDIA_NODES) {
			expect(FULL_EDITOR_NODES).toContain(node);
		}
	});
});
