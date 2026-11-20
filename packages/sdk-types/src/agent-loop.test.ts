import { describe, expect, it } from "vitest";
import {
	AGENT_EMPTY_ANSWER_NUDGE,
	AGENT_LOOP_MAX_ITERATIONS_CEILING,
	AGENT_TOOLS_CLOSE,
	AGENT_TOOLS_OPEN,
	AGENT_TOOLS_PRIVACY_GUIDANCE,
	type AgentLoopPorts,
	AgentStopReason,
	type AgentToolCall,
	ToolRefusalReason,
	buildAgentSystemPrompt,
	intersectAgentTools,
	parseAgentReply,
	resolveAgentAnswer,
	runAgentLoop,
} from "./agent-loop";
import type { AgentTool } from "./automations";
import { type AiChatMessage, MessageRole, messageText } from "./conversation";

const searchTool: AgentTool = { verb: "search", label: "Search the vault" };
const noteTool: AgentTool = {
	verb: "create",
	entityType: "brainstorm/Note/v1",
	label: "Create a note",
};

/** A scripted `generate` that returns the next canned reply per call. */
function scriptedPorts(
	replies: readonly string[],
	dispatch: (call: AgentToolCall) => Promise<unknown> = async () => null,
): AgentLoopPorts & { seen: AiChatMessage[][]; dispatched: AgentToolCall[] } {
	const seen: AiChatMessage[][] = [];
	const dispatched: AgentToolCall[] = [];
	let i = 0;
	return {
		seen,
		dispatched,
		generate: async (messages) => {
			seen.push([...messages]);
			const content = replies[Math.min(i, replies.length - 1)] ?? '{"final":"done"}';
			i++;
			return { content, provenance: { provider: "ollama", model: "m", generatedAt: "t" } };
		},
		dispatchTool: async (call) => {
			dispatched.push(call);
			return dispatch(call);
		},
	};
}

describe("intersectAgentTools (security keystone)", () => {
	it("offers a tool only when its full capability footprint is held", () => {
		const tools = [searchTool, noteTool];
		const offered = intersectAgentTools(tools, [
			"intents.dispatch:search",
			"intents.dispatch:create",
			"entities.read:brainstorm/Note/v1",
		]);
		expect(offered.map((t) => t.verb)).toEqual(["search", "create"]);
	});

	it("drops a tool whose entity-read cap is missing (partial coverage fails closed)", () => {
		const offered = intersectAgentTools(
			[noteTool],
			// has the dispatch cap but NOT the implied entities.read scope
			["intents.dispatch:create"],
		);
		expect(offered).toEqual([]);
	});

	it("a `*` scope grant covers a scoped tool requirement", () => {
		const offered = intersectAgentTools([noteTool], ["intents.dispatch:create", "entities.read:*"]);
		expect(offered.map((t) => t.verb)).toEqual(["create"]);
	});

	it("property: offered ⊆ declared, and every offered tool's caps are fully held", () => {
		// Deterministic pseudo-random sampling (no fast-check dependency in this
		// contract leaf): the two invariants the security keystone must hold over
		// arbitrary declared-tool / frozen-cap combinations.
		const verbs = ["search", "create", "open", "delete"];
		const types: (string | undefined)[] = ["A", "B", undefined];
		const capPool = [
			"intents.dispatch:search",
			"intents.dispatch:create",
			"intents.dispatch:open",
			"entities.read:A",
			"entities.read:B",
			"entities.read:*",
			"unrelated.cap",
		];
		let seed = 12345;
		const rnd = (n: number): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const pick = <T>(arr: readonly T[]): T => arr[rnd(arr.length)] as T;

		for (let trial = 0; trial < 300; trial++) {
			const declared: AgentTool[] = Array.from({ length: rnd(5) }, () => {
				const t = pick(types);
				return { verb: pick(verbs), label: "x", ...(t ? { entityType: t } : {}) };
			});
			const frozen = Array.from({ length: rnd(capPool.length) }, () => pick(capPool));
			const offered = intersectAgentTools(declared, frozen);
			for (const tool of offered) {
				expect(declared).toContain(tool);
				const reqs = [
					`intents.dispatch:${tool.verb}`,
					...(tool.entityType ? [`entities.read:${tool.entityType}`] : []),
				];
				for (const req of reqs) {
					expect(frozen.some((h) => h === req || h === req.replace(/:[^:]*$/, ":*"))).toBe(true);
				}
			}
		}
	});
});

describe("parseAgentReply", () => {
	it("parses a tool call", () => {
		expect(parseAgentReply('{"tool":"search","args":{"q":"x"}}')).toEqual({
			kind: "tool",
			call: { tool: "search", args: { q: "x" } },
		});
	});

	it("parses a final answer with citations", () => {
		expect(parseAgentReply('{"final":"hi","citations":["a","b"]}')).toEqual({
			kind: "final",
			answer: "hi",
			citations: ["a", "b"],
		});
	});

	it("extracts JSON from a fenced / prose-wrapped reply", () => {
		const parsed = parseAgentReply('Sure!\n```json\n{"tool":"search","args":{}}\n```');
		expect(parsed).toEqual({ kind: "tool", call: { tool: "search", args: {} } });
	});

	it("returns null for non-protocol prose (loop treats as final)", () => {
		expect(parseAgentReply("I think the answer is 42.")).toBeNull();
	});

	it("missing args defaults to an empty object", () => {
		expect(parseAgentReply('{"tool":"search"}')).toEqual({
			kind: "tool",
			call: { tool: "search", args: {} },
		});
	});
});

/** The owner-reported payload: llama3.2 answering a nonsense message. */
const SCREENSHOT_PAYLOAD = '{"final": {}, "citations": []}';

describe("envelope shapes — the answer is never the raw envelope", () => {
	const cases: ReadonlyArray<readonly [label: string, content: string, answer: string]> = [
		["a string final", '{"final":"hi","citations":[]}', "hi"],
		["the screenshot payload (final is an empty object)", SCREENSHOT_PAYLOAD, ""],
		["final object with a text field", '{"final":{"text":"from text"}}', "from text"],
		["final object with a content field", '{"final":{"content":"from content"}}', "from content"],
		["final object with a message field", '{"final":{"message":"from message"}}', "from message"],
		["final object with an answer field", '{"final":{"answer":"from answer"}}', "from answer"],
		["final object with no text field", '{"final":{"status":"ok","n":1}}', ""],
		["final object whose text field is blank", '{"final":{"text":"   "}}', ""],
		["final array of strings", '{"final":["one","two"]}', "one\ntwo"],
		["final array of text objects", '{"final":[{"text":"one"},{"nope":1}]}', "one"],
		["final empty array", '{"final":[]}', ""],
		["final null", '{"final":null}', ""],
		["final boolean", '{"final":true}', ""],
		["final number", '{"final":42}', "42"],
		["whitespace-only final", '{"final":"  \\n "}', ""],
		[
			"a final with a raw newline in the string",
			'{"final":"line one\nline two"}',
			"line one\nline two",
		],
		["a blank final with a raw newline in the string", '{"final":" \n "}', ""],
		["an envelope with citations but no final", '{"citations":["n1"]}', ""],
		["an envelope with an unusable tool", '{"tool":5,"args":{}}', ""],
		["a bare empty object", "{}", ""],
		["a fenced bare empty object", "```json\n{}\n```", ""],
		["a fenced empty envelope", '```json\n{"final": {}, "citations": []}\n```', ""],
		["an empty envelope wrapped in prose", 'Here you go:\n{"final": {}}', ""],
		["a string final wrapped in prose", 'Sure!\n```json\n{"final":"hi"}\n```', "hi"],
		["an empty reply", "", ""],
		["a whitespace-only reply", " \n\t ", ""],
		["plain prose", "The answer is 42.", "The answer is 42."],
		[
			"prose that mentions an empty object",
			"Use {} for an empty object.",
			"Use {} for an empty object.",
		],
		["a non-envelope JSON object", '{"name":"Ada","age":36}', '{"name":"Ada","age":36}'],
		[
			"a final cut off mid-string",
			'{"final": "The plan has \\"two\\" parts',
			'The plan has "two" parts',
		],
		["a fenced final cut off mid-string", '```json\n{"final": "half an ans', "half an ans"],
		["a final cut off before its string", '{"final": ', ""],
		["cut-off JSON that is not an envelope", '{"name": "Ada', '{"name": "Ada'],
	];

	it.each(cases)("%s", (_label, content, answer) => {
		const resolved = resolveAgentAnswer(content);
		expect(resolved).toBe(answer);
		// The invariant behind the bug: an envelope never reaches the user.
		expect(resolved).not.toContain('"final"');
		expect(resolved).not.toContain('"citations"');
	});

	it("a tool call is not an answer", () => {
		expect(resolveAgentAnswer('{"tool":"search","args":{}}')).toBe("");
	});

	it("keeps the citations of an envelope whose final is an object", () => {
		expect(parseAgentReply('{"final":{"text":"hi"},"citations":["n1",2]}')).toEqual({
			kind: "final",
			answer: "hi",
			citations: ["n1"],
		});
	});
});

/** The follow-up report, verbatim: llama3.2 answering "s" — prose, the
 *  recited tool list (schema hints included), then an empty envelope. */
const RECITED_PROSE = [
	"It seems like you just pressed a key. If you'd like to ask a question, request an action, or gather information, please rephrase your request, and I'll help you accordingly. Available tools:",
	"• open: Open or navigate to an object in your vault by its id",
	"• propose-note: Propose a new note to add to the vault",
	'• propose-database: Propose a new database. args: {"name": "<database name>", …}',
].join("\n");
const RECITED_TRANSCRIPT = `${RECITED_PROSE}\n{"final": "", "citations": []}`;

const LONG_PROSE =
	"The launch slipped for two reasons.\nFirst, the venue fell through.\nSecond, the budget was cut.";

describe("an envelope mixed with prose — only the envelope text is removed", () => {
	const cases: ReadonlyArray<readonly [label: string, content: string, answer: string]> = [
		["the reported transcript (prose, tool list, empty envelope)", RECITED_TRANSCRIPT, RECITED_PROSE],
		[
			"an empty envelope first, then prose",
			'{"final": "", "citations": []}\nI am not sure what you mean.',
			"I am not sure what you mean.",
		],
		[
			"a fenced empty envelope after prose",
			'I am not sure what you mean.\n```json\n{"final": "", "citations": []}\n```',
			"I am not sure what you mean.",
		],
		[
			"an empty envelope on its own line in the middle of prose",
			'First part.\n{"final": {}, "citations": []}\nSecond part.',
			"First part.\n\nSecond part.",
		],
		["a one-line preamble gives way to final", 'Here is my answer:\n{"final":"42"}', "42"],
		[
			"substantial prose is kept and a final it already contains is dropped",
			`${LONG_PROSE}\n{"final":"the venue fell through"}`,
			LONG_PROSE,
		],
		[
			"substantial prose is kept and a different final follows it",
			`${LONG_PROSE}\n{"final":"Rebook by Friday."}`,
			`${LONG_PROSE}\n\nRebook by Friday.`,
		],
		[
			"JSON with a final key among other keys is the user's answer",
			'{"final": true, "score": 3, "round": "semi"}',
			'{"final": true, "score": 3, "round": "semi"}',
		],
		[
			"an envelope inside a larger example code block is left alone",
			'The format is:\n```json\n// when done\n{"final": "x", "citations": []}\n```',
			'The format is:\n```json\n// when done\n{"final": "x", "citations": []}\n```',
		],
		[
			"an envelope mentioned mid-sentence is left alone",
			'Reply with {"final": "x"} when you are done, please.',
			'Reply with {"final": "x"} when you are done, please.',
		],
		[
			"an envelope nested in other JSON is left alone",
			'{"example": {"final": "x"}}',
			'{"example": {"final": "x"}}',
		],
	];

	it.each(cases)("%s", (_label, content, answer) => {
		expect(resolveAgentAnswer(content)).toBe(answer);
	});

	it("honours the citations of an envelope stripped out of prose", () => {
		expect(parseAgentReply('See the plan.\n{"final": "", "citations": ["n1"]}')).toEqual({
			kind: "final",
			answer: "See the plan.",
			citations: ["n1"],
		});
	});

	it("finds a tool call that follows unparseable braces in prose", () => {
		expect(
			parseAgentReply('I will use args {"name": "<x>", …} now.\n{"tool":"search","args":{"q":"a"}}'),
		).toEqual({ kind: "tool", call: { tool: "search", args: { q: "a" } } });
	});

	it("the loop does not retry when the prose around an empty envelope is the answer", async () => {
		const ports = scriptedPorts([RECITED_TRANSCRIPT, '{"final":"never asked"}']);
		const result = await runAgentLoop(ports, {
			instructions: "x",
			tools: [searchTool],
			frozenCapabilities: ["intents.dispatch:search"],
		});
		expect(result.finalAnswer).toBe(RECITED_PROSE);
		expect(result.iterations).toBe(1);
	});
});

describe("buildAgentSystemPrompt", () => {
	it("keeps the tool list internal: delimited, and never to be recited", () => {
		const prompt = buildAgentSystemPrompt("Do the thing.", [searchTool]);
		expect(prompt).toContain(AGENT_TOOLS_PRIVACY_GUIDANCE);
		const open = prompt.lastIndexOf(AGENT_TOOLS_OPEN);
		const close = prompt.lastIndexOf(AGENT_TOOLS_CLOSE);
		const tool = prompt.indexOf("search: Search the vault");
		expect(open).toBeGreaterThan(-1);
		expect(tool).toBeGreaterThan(open);
		expect(close).toBeGreaterThan(tool);
		expect(prompt).not.toContain("Available tools:");
	});

	it("lists offered tools and the JSON protocol", () => {
		const prompt = buildAgentSystemPrompt("Do the thing.", [searchTool, noteTool]);
		expect(prompt).toContain("search: Search the vault");
		expect(prompt).toContain("create: Create a note (entity type: brainstorm/Note/v1)");
		expect(prompt).toContain('{"tool": "<name>"');
		expect(prompt).toContain('{"final"');
	});

	it("notes when no tools are available", () => {
		expect(buildAgentSystemPrompt("x", [])).toContain("(none");
	});
});

describe("runAgentLoop", () => {
	const config = (over: Partial<Parameters<typeof runAgentLoop>[1]> = {}) => ({
		instructions: "Find the note.",
		tools: [searchTool],
		frozenCapabilities: ["intents.dispatch:search"],
		...over,
	});

	it("dispatches a tool, feeds the result back, then returns the final answer", async () => {
		const ports = scriptedPorts(
			['{"tool":"search","args":{"q":"abc"}}', '{"final":"found it","citations":["n1"]}'],
			async () => ({ hits: 1 }),
		);
		const result = await runAgentLoop(ports, config());
		expect(result.stopReason).toBe(AgentStopReason.Final);
		expect(result.finalAnswer).toBe("found it");
		expect(result.citations).toEqual(["n1"]);
		expect(ports.dispatched).toEqual([{ tool: "search", args: { q: "abc" } }]);
		// The tool result was fed back as a tool-role message before the 2nd generate.
		const secondCall = ports.seen[1] ?? [];
		expect(
			secondCall.some((m) => m.role === MessageRole.Tool && messageText(m.content).includes("hits")),
		).toBe(true);
		expect(result.iterations).toBe(2);
	});

	it("refuses a tool not in the offered set (fail-closed), then continues", async () => {
		const ports = scriptedPorts([
			'{"tool":"delete","args":{}}', // not offered
			'{"final":"ok"}',
		]);
		const result = await runAgentLoop(ports, config());
		expect(ports.dispatched).toEqual([]); // never dispatched
		const refusal = result.steps.find((s) => s.kind === "tool-refused");
		expect(refusal).toEqual({
			kind: "tool-refused",
			tool: "delete",
			reason: ToolRefusalReason.UnknownTool,
		});
		expect(result.finalAnswer).toBe("ok");
	});

	it("refuses a declared tool whose caps the frozen set does not cover", async () => {
		const ports = scriptedPorts(['{"tool":"create","args":{}}', '{"final":"done"}']);
		// `create` is declared but the note-read cap is absent → never offered.
		const result = await runAgentLoop(
			ports,
			config({ tools: [noteTool], frozenCapabilities: ["intents.dispatch:create"] }),
		);
		expect(ports.dispatched).toEqual([]);
		expect(result.steps.some((s) => s.kind === "tool-refused")).toBe(true);
	});

	it("bounds iterations and never exceeds the ceiling", async () => {
		// Always asks for a tool → would loop forever without the bound.
		const ports = scriptedPorts(['{"tool":"search","args":{}}']);
		const result = await runAgentLoop(ports, config({ maxIterations: 1000 }));
		expect(result.stopReason).toBe(AgentStopReason.MaxIterations);
		expect(result.iterations).toBe(AGENT_LOOP_MAX_ITERATIONS_CEILING);
	});

	it("honours a small maxIterations", async () => {
		const ports = scriptedPorts(['{"tool":"search","args":{}}']);
		const result = await runAgentLoop(ports, config({ maxIterations: 2 }));
		expect(result.iterations).toBe(2);
		expect(result.stopReason).toBe(AgentStopReason.MaxIterations);
	});

	it("treats non-protocol prose as the final answer (always terminates)", async () => {
		const ports = scriptedPorts(["The answer is 42."]);
		const result = await runAgentLoop(ports, config());
		expect(result.stopReason).toBe(AgentStopReason.Final);
		expect(result.finalAnswer).toBe("The answer is 42.");
		expect(result.iterations).toBe(1);
	});

	it("stops with GenerateFailed when generate throws", async () => {
		const ports: AgentLoopPorts = {
			generate: async () => {
				throw new Error("provider down");
			},
			dispatchTool: async () => null,
		};
		const result = await runAgentLoop(ports, config());
		expect(result.stopReason).toBe(AgentStopReason.GenerateFailed);
		expect(result.error).toBe("provider down");
		expect(result.finalAnswer).toBe("");
	});

	it("a tool dispatch error is recorded and fed back, loop continues", async () => {
		const ports = scriptedPorts(
			['{"tool":"search","args":{}}', '{"final":"recovered"}'],
			async () => {
				throw new Error("boom");
			},
		);
		const result = await runAgentLoop(ports, config());
		const err = result.steps.find((s) => s.kind === "tool-error");
		expect(err).toMatchObject({ kind: "tool-error", tool: "search", error: "boom" });
		expect(result.finalAnswer).toBe("recovered");
	});

	describe("empty answer recovery", () => {
		const nudges = (messages: readonly AiChatMessage[]): number =>
			messages.filter((m) => messageText(m.content) === AGENT_EMPTY_ANSWER_NUDGE).length;

		it("retries once when the model returns the empty envelope, then answers", async () => {
			const ports = scriptedPorts([SCREENSHOT_PAYLOAD, '{"final":"I am not sure what you mean."}']);
			const result = await runAgentLoop(ports, config());
			expect(result.stopReason).toBe(AgentStopReason.Final);
			expect(result.finalAnswer).toBe("I am not sure what you mean.");
			expect(result.iterations).toBe(2);
			// The retry told the model its last message had no answer.
			const second = ports.seen[1] ?? [];
			expect(second.at(-1)).toEqual({ role: MessageRole.User, content: AGENT_EMPTY_ANSWER_NUDGE });
			expect(second.at(-2)).toEqual({ role: MessageRole.Assistant, content: SCREENSHOT_PAYLOAD });
		});

		it("gives up after ONE retry with an empty answer — never the raw envelope", async () => {
			const ports = scriptedPorts([SCREENSHOT_PAYLOAD, SCREENSHOT_PAYLOAD, '{"final":"too late"}']);
			const result = await runAgentLoop(ports, config());
			expect(result.stopReason).toBe(AgentStopReason.Final);
			expect(result.finalAnswer).toBe("");
			expect(result.iterations).toBe(2);
			expect(ports.seen).toHaveLength(2);
			expect(nudges(ports.seen[1] ?? [])).toBe(1);
			// The raw output stays on the record for the trace.
			expect(result.steps).toEqual([
				{ kind: "assistant", content: SCREENSHOT_PAYLOAD },
				{ kind: "assistant", content: SCREENSHOT_PAYLOAD },
			]);
		});

		it("still retries when the run was bounded to a single iteration", async () => {
			const ports = scriptedPorts(["", '{"final":"hello"}']);
			const result = await runAgentLoop(ports, config({ tools: [], maxIterations: 1 }));
			expect(result.finalAnswer).toBe("hello");
			expect(result.iterations).toBe(2);
		});

		it("the single retry is spent once, across the whole run", async () => {
			const ports = scriptedPorts([
				SCREENSHOT_PAYLOAD,
				'{"tool":"search","args":{}}',
				SCREENSHOT_PAYLOAD,
				'{"final":"never asked"}',
			]);
			const result = await runAgentLoop(ports, config());
			expect(result.finalAnswer).toBe("");
			expect(result.iterations).toBe(3);
		});

		it("an iteration ceiling reached on a tool call reports no answer, not the tool JSON", async () => {
			const ports = scriptedPorts(['{"tool":"search","args":{}}']);
			const result = await runAgentLoop(ports, config({ maxIterations: 2 }));
			expect(result.stopReason).toBe(AgentStopReason.MaxIterations);
			expect(result.finalAnswer).toBe("");
		});
	});
});
