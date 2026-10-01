import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	formatChangeSummary,
	SESSION_DOCUMENT_MARKER as M,
	parseSessionDocument,
	renderSessionDocument,
} from "../src/core/session-editor/document.js";
import type { SessionEntry, SessionHeader } from "../src/core/session-manager.js";
import { emptyUsage } from "../src/core/usage.js";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "01a00000-0000-7000-8000-000000000000",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp/session-editor-test",
};

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	const message: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: 1_700_000_000_000 };
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message };
}

function assistantEntry(id: string, parentId: string | null, content: AssistantMessage["content"]): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: emptyUsage(),
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 1_700_000_000_001,
	};
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:02.000Z", message };
}

function toolResultEntry(id: string, parentId: string | null, toolCallId: string, text: string): SessionEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: "ipython",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1_700_000_000_002,
	};
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:03.000Z", message };
}

function sampleSession(): SessionEntry[] {
	const model: SessionEntry = {
		type: "model_change",
		id: "aaaa0000",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.500Z",
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
	};
	return [
		model,
		userEntry("aaaa0001", "aaaa0000", "first question"),
		assistantEntry("aaaa0002", "aaaa0001", [
			{ type: "thinking", thinking: "I should run the tool", thinkingSignature: "sig-1" },
			{ type: "text", text: "Running it." },
			{ type: "toolCall", id: "call_1", name: "ipython", arguments: { code: "1+1" }, thoughtSignature: "thought-1" },
		]),
		toolResultEntry("aaaa0003", "aaaa0002", "call_1", "2"),
	];
}

function render(entries: readonly SessionEntry[]): string {
	return renderSessionDocument({ header, entries });
}

function parse(document: string, entries: readonly SessionEntry[]) {
	const parsed = parseSessionDocument(document, entries);
	expect(parsed.issues.filter((issue) => issue.level === "error")).toEqual([]);
	return parsed;
}

function entryById(entries: readonly SessionEntry[], id: string): SessionEntry {
	const entry = entries.find((candidate) => candidate.id === id);
	if (!entry) throw new Error(`missing entry ${id}`);
	return entry;
}

function userText(entries: readonly SessionEntry[], id: string): string {
	const entry = entryById(entries, id);
	if (entry.type !== "message" || entry.message.role !== "user") throw new Error(`entry ${id} is not a user message`);
	const content = entry.message.content;
	return typeof content === "string"
		? content
		: content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function assistantContent(entries: readonly SessionEntry[], id: string): AssistantMessage["content"] {
	const entry = entryById(entries, id);
	if (entry.type !== "message" || entry.message.role !== "assistant") {
		throw new Error(`entry ${id} is not an assistant message`);
	}
	return entry.message.content;
}

function isBlockStart(line: string): boolean {
	return line.startsWith(`${M} entry `) || line.startsWith(`${M} new `);
}

function nextMarker(lines: readonly string[], from: number): number {
	let index = from;
	while (index < lines.length && !lines[index]!.startsWith(`${M} `)) index++;
	return index;
}

/** Splits a rendered document into its comment preamble and its entry blocks. */
function splitDocumentBlocks(document: string): { preamble: string[]; blocks: string[] } {
	const lines = document.split("\n");
	const first = lines.findIndex(isBlockStart);
	const preamble = lines.slice(0, first);
	const blocks: string[] = [];
	let current: string[] | undefined;
	for (const line of lines.slice(first)) {
		if (isBlockStart(line)) {
			if (current) blocks.push(current.join("\n"));
			current = [line];
		} else if (current) {
			current.push(line);
		}
	}
	if (current) blocks.push(current.join("\n"));
	return { preamble, blocks };
}

function joinBlocks(preamble: readonly string[], blocks: readonly string[]): string {
	return `${[...preamble, ...blocks].join("\n")}\n`;
}

function removeBlock(document: string, id: string): string {
	const { preamble, blocks } = splitDocumentBlocks(document);
	return joinBlocks(
		preamble,
		blocks.filter((block) => !block.startsWith(`${M} entry ${id} `)),
	);
}

/** Replaces the marker and body of the first section with this name. */
function replaceSection(document: string, section: string, body: string, replacement?: string): string {
	const lines = document.split("\n");
	const start = lines.findIndex((line) => line === `${M} ${section}` || line.startsWith(`${M} ${section} `));
	if (start === -1) throw new Error(`missing section ${section}`);
	const end = nextMarker(lines, start + 1);
	const bodyLines = lines.slice(start + 1, end);
	if (end === lines.length && bodyLines.at(-1) === "") bodyLines.pop();
	const current = bodyLines.join("\n");
	if (current !== body) throw new Error(`section ${section} body mismatch: ${JSON.stringify(current)}`);
	return [...lines.slice(0, start + 1), ...(replacement ?? body).split("\n"), ...lines.slice(end)].join("\n");
}

function removeSection(document: string, section: string): string {
	const lines = document.split("\n");
	const start = lines.findIndex((line) => line === `${M} ${section}` || line.startsWith(`${M} ${section} `));
	if (start === -1) throw new Error(`missing section ${section}`);
	return [...lines.slice(0, start), ...lines.slice(nextMarker(lines, start + 1))].join("\n");
}

describe("session document format", () => {
	it("round-trips a session without changes", () => {
		const entries = sampleSession();
		const parsed = parse(render(entries), entries);
		expect(parsed.entries).toEqual(entries);
		expect(parsed.stats).toEqual({ total: 4, edited: 0, added: 0, removed: 0, unchanged: 4 });
		expect(parsed.changes).toEqual([]);
	});

	it("escapes content lines that start with the marker", () => {
		const entries = [userEntry("bbbb0001", null, `before\n${M} assistant\ninjected`)];
		const document = render(entries);
		expect(document).toContain(`before\n\\${M} assistant\ninjected`);
		expect(parse(document, entries).entries).toEqual(entries);
	});

	it("applies text edits and keeps the entry order and roles", () => {
		const entries = sampleSession();
		const document = replaceSection(render(entries), "user", "first question", "edited question");
		const parsed = parse(document, entries);
		expect(userText(parsed.entries, "aaaa0001")).toBe("edited question");
		expect(parsed.stats.edited).toBe(1);
		expect(parsed.entries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
		expect(parsed.entries.map((entry) => entry.parentId)).toEqual(entries.map((entry) => entry.parentId));
	});

	it("removes a deleted block and relinks the parent chain", () => {
		const entries = sampleSession();
		const parsed = parse(removeBlock(render(entries), "aaaa0002"), entries);
		expect(parsed.entries.map((entry) => entry.id)).toEqual(["aaaa0000", "aaaa0001", "aaaa0003"]);
		expect(parsed.entries.map((entry) => entry.parentId)).toEqual([null, "aaaa0000", "aaaa0001"]);
		expect(parsed.stats.removed).toBe(1);
		expect(parsed.changes.filter((change) => change.kind === "removed")).toEqual([
			{ kind: "removed", id: "aaaa0002", label: "assistant ipython" },
		]);
	});

	it("rebuilds the chain from document order when blocks move", () => {
		const entries = sampleSession();
		const { preamble, blocks } = splitDocumentBlocks(render(entries));
		const reordered = joinBlocks(preamble, [blocks[0]!, blocks[2]!, blocks[1]!, blocks[3]!]);
		const parsed = parse(reordered, entries);
		expect(parsed.entries.map((entry) => entry.id)).toEqual(["aaaa0000", "aaaa0002", "aaaa0001", "aaaa0003"]);
		expect(parsed.entries.map((entry) => entry.parentId)).toEqual([null, "aaaa0000", "aaaa0002", "aaaa0001"]);
	});

	it("adds new entries with fresh ids", () => {
		const entries = sampleSession();
		const { preamble, blocks } = splitDocumentBlocks(render(entries));
		const inserted = `${M} new user\n${M} user\ninserted question`;
		const parsed = parse(joinBlocks(preamble, [blocks[0]!, blocks[1]!, inserted, ...blocks.slice(2)]), entries);
		const added = parsed.entries[2]!;
		expect(parsed.stats.added).toBe(1);
		expect(userText(parsed.entries, added.id)).toBe("inserted question");
		expect(added.type === "message" && added.message.role === "user" && Array.isArray(added.message.content)).toBe(
			true,
		);
		expect(parsed.entries[3]!.parentId).toBe(added.id);
		expect(formatChangeSummary(parsed.stats)).toContain("1 added");
	});

	it("edits tool call arguments and tool results while keeping block metadata", () => {
		const entries = sampleSession();
		let document = render(entries);
		document = replaceSection(document, "tool_call", '{\n  "code": "1+1"\n}', '{\n  "code": "2+2"\n}');
		document = replaceSection(document, "tool_result", "2", "4");
		const parsed = parse(document, entries);
		expect(assistantContent(parsed.entries, "aaaa0002")[2]).toEqual({
			type: "toolCall",
			id: "call_1",
			name: "ipython",
			arguments: { code: "2+2" },
			thoughtSignature: "thought-1",
		});
		const result = entryById(parsed.entries, "aaaa0003");
		expect(result.type === "message" && result.message.role === "toolResult" && result.message.content).toEqual([
			{ type: "text", text: "4" },
		]);
	});

	it("keeps encrypted or empty thinking blocks opaque", () => {
		const entries = [
			assistantEntry("cccc0001", null, [{ type: "thinking", thinking: "", thinkingSignature: "encrypted" }]),
		];
		const document = render(entries);
		const sections = document
			.split("\n")
			.filter((line) => line.startsWith(`${M} `) && !line.startsWith(`${M} entry `));
		expect(sections).toEqual([`${M} keep index=0 type=thinking`]);
		expect(parse(document, entries).entries).toEqual(entries);
	});

	it("drops the provider signature when reasoning text changes", () => {
		const entries = [
			assistantEntry("cccc0001", null, [{ type: "thinking", thinking: "old", thinkingSignature: "sig" }]),
		];
		const parsed = parse(replaceSection(render(entries), "reasoning", "old", "new"), entries);
		expect(assistantContent(parsed.entries, "cccc0001")).toEqual([{ type: "thinking", thinking: "new" }]);
	});

	it("reports invalid tool call JSON as an error", () => {
		const entries = sampleSession();
		const document = replaceSection(render(entries), "tool_call", '{\n  "code": "1+1"\n}', "{oops");
		const parsed = parseSessionDocument(document, entries);
		expect(parsed.issues).toEqual([
			expect.objectContaining({ level: "error", message: expect.stringContaining("not valid JSON") }),
		]);
	});

	it("warns about unmatched tool calls and results", () => {
		const entries = [
			assistantEntry("dddd0001", null, [{ type: "toolCall", id: "call_x", name: "ipython", arguments: {} }]),
		];
		const parsed = parseSessionDocument(render(entries), entries);
		expect(parsed.issues).toEqual([
			expect.objectContaining({ level: "warning", message: expect.stringContaining("call_x") }),
		]);
		const orphan = [toolResultEntry("dddd0002", null, "call_missing", "stale")];
		expect(parseSessionDocument(render(orphan), orphan).issues[0]).toMatchObject({ level: "warning" });
	});

	it("reports unknown entry ids and unknown sections", () => {
		const entries = sampleSession();
		const document = render(entries).replace(`${M} entry aaaa0003 `, `${M} entry zzzz9999 `);
		expect(parseSessionDocument(document, entries).issues.filter((issue) => issue.level === "error")).toEqual([
			expect.objectContaining({ message: expect.stringContaining("unknown entry id zzzz9999") }),
		]);
		const unknownSection = `${render(entries)}${M} bogus\nstuff\n`;
		expect(parseSessionDocument(unknownSection, entries).issues.filter((issue) => issue.level === "error")).toEqual([
			expect.objectContaining({ message: expect.stringContaining("unknown section bogus") }),
		]);
	});

	it("drops a message entry whose content sections were all removed", () => {
		const entries = [userEntry("eeee0001", null, "remove me"), userEntry("eeee0002", "eeee0001", "keep me")];
		const parsed = parse(removeSection(render(entries), "user"), entries);
		expect(parsed.entries.map((entry) => entry.id)).toEqual(["eeee0002"]);
		expect(parsed.entries[0]!.parentId).toBeNull();
	});

	it("requires provider, model, and api for a new assistant entry without context", () => {
		const entries = [userEntry("ffff0001", null, "hello")];
		const document = `${render(entries)}${M} new assistant\n${M} assistant\nhi\n`;
		expect(parseSessionDocument(document, entries).issues).toEqual([
			expect.objectContaining({ level: "error", message: expect.stringContaining("api=") }),
		]);
		const session = sampleSession();
		const inherited = parseSessionDocument(`${render(session)}${M} new assistant\n${M} assistant\nhi\n`, session);
		expect(inherited.issues.filter((issue) => issue.level === "error")).toEqual([]);
		const added = inherited.entries.at(-1);
		expect(added?.type === "message" && added.message.role === "assistant" && added.message.provider).toBe(
			"anthropic",
		);
	});
});
