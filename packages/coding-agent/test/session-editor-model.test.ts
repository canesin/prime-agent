import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionEditModel } from "../src/core/session-editor/model.js";
import type { SessionEntry, SessionHeader } from "../src/core/session-manager.js";
import { emptyUsage } from "../src/core/usage.js";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "01a00000-0000-7000-8000-000000000000",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp/session-model-test",
};

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	const message: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: 1 };
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
		stopReason: "stop",
		timestamp: 1,
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
		timestamp: 1,
	};
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:03.000Z", message };
}

function sampleEntries(): SessionEntry[] {
	return [
		userEntry("aaaa0001", null, "run it"),
		assistantEntry("aaaa0002", "aaaa0001", [
			{ type: "toolCall", id: "call_1", name: "ipython", arguments: { code: "1+1" } },
		]),
		toolResultEntry("aaaa0003", "aaaa0002", "call_1", "2"),
		userEntry("aaaa0004", "aaaa0003", "thanks"),
	];
}

function model(entries: SessionEntry[] = sampleEntries()): SessionEditModel {
	return new SessionEditModel({ header, entries, filePath: "/tmp/session.jsonl" });
}

function ids(instance: SessionEditModel): string[] {
	return instance.allEntries.map((entry) => entry.id);
}

function parents(instance: SessionEditModel): Array<string | null> {
	return instance.allEntries.map((entry) => entry.parentId ?? null);
}

function userText(instance: SessionEditModel, id: string): string {
	const entry = instance.entry(id);
	if (entry?.type !== "message" || entry.message.role !== "user") throw new Error(`${id} is not a user entry`);
	const content = entry.message.content;
	return typeof content === "string"
		? content
		: content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("session edit model", () => {
	it("cascades tool results when their assistant message is deleted", () => {
		const instance = model();
		const result = instance.removeEntry("aaaa0002");
		expect(result.removedIds).toEqual(["aaaa0002", "aaaa0003"]);
		expect(ids(instance)).toEqual(["aaaa0001", "aaaa0004"]);
		expect(parents(instance)).toEqual([null, "aaaa0001"]);
		expect(instance.validate().filter((issue) => issue.level === "error")).toEqual([]);
	});

	it("keeps tool results when cascade is disabled", () => {
		const instance = model();
		instance.removeEntry("aaaa0002", { cascade: false });
		expect(ids(instance)).toEqual(["aaaa0001", "aaaa0003", "aaaa0004"]);
		expect(instance.validate().some((issue) => issue.message.includes("unknown tool call"))).toBe(true);
	});

	it("moves an entry and relinks the chain", () => {
		const instance = model();
		expect(instance.moveEntry("aaaa0004", -1)).toBe(true);
		expect(ids(instance)).toEqual(["aaaa0001", "aaaa0002", "aaaa0004", "aaaa0003"]);
		expect(parents(instance)).toEqual([null, "aaaa0001", "aaaa0002", "aaaa0004"]);
		expect(instance.moveEntry("aaaa0001", -1)).toBe(false);
	});

	it("inserts user, assistant, and tool result entries with generated structure", () => {
		const instance = model();
		const userId = instance.insertEntry(1, { kind: "user", text: "inserted" })!;
		expect(userId).toMatch(/^[0-9a-f]{8}$/);
		expect(userText(instance, userId)).toBe("inserted");
		expect(instance.allEntries[1]!.parentId).toBe("aaaa0001");
		expect(instance.allEntries[2]!.parentId).toBe(userId);

		// Assistant identity is inherited from the nearest preceding model reply.
		const assistantId = instance.insertEntry(3, { kind: "assistant", text: "hello", reasoning: "think" })!;
		const assistant = instance.entry(assistantId);
		expect(assistant?.type === "message" && assistant.message.role === "assistant").toBe(true);
		if (assistant?.type === "message" && assistant.message.role === "assistant") {
			expect(assistant.message.provider).toBe("anthropic");
			expect(assistant.message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		}

		const resultId = instance.insertEntry(9, { kind: "toolResult", toolCallId: "call_1", text: "output" })!;
		const result = instance.entry(resultId);
		expect(result?.type === "message" && result.message.role === "toolResult" && result.message.toolName).toBe(
			"ipython",
		);
	});

	it("refuses to insert an assistant entry with no model identity in reach", () => {
		const instance = model([userEntry("bbbb0001", null, "hello")]);
		expect(instance.insertEntry(1, { kind: "assistant", text: "hi" })).toBeUndefined();
		expect(ids(instance)).toEqual(["bbbb0001"]);
	});

	it("duplicates an entry with a new id", () => {
		const instance = model();
		const copyId = instance.duplicateEntry("aaaa0001")!;
		expect(copyId).not.toBe("aaaa0001");
		expect(userText(instance, copyId)).toBe("run it");
		expect(ids(instance)).toEqual(["aaaa0001", copyId, "aaaa0002", "aaaa0003", "aaaa0004"]);
	});

	it("applies per-entry block text and drops an entry whose content was removed", () => {
		const instance = model();
		const text = instance.entryText("aaaa0001")!;
		expect(text).toContain("run it");
		const edited = text.replace("run it", "run it twice");
		expect(instance.applyEntryText("aaaa0001", edited).issues).toEqual([]);
		expect(userText(instance, "aaaa0001")).toBe("run it twice");

		const emptied = text
			.split("\n")
			.filter((line) => !line.startsWith("@@@@ user"))
			.join("\n");
		instance.applyEntryText("aaaa0001", emptied);
		expect(ids(instance)).not.toContain("aaaa0001");
	});

	it("tracks dirty state across undo and redo", () => {
		const instance = model();
		expect(instance.dirty).toBe(false);
		instance.removeEntry("aaaa0004");
		expect(instance.dirty).toBe(true);
		expect(instance.undo()).toBe(true);
		expect(ids(instance)).toEqual(["aaaa0001", "aaaa0002", "aaaa0003", "aaaa0004"]);
		expect(instance.dirty).toBe(false);
		expect(instance.redo()).toBe(true);
		expect(ids(instance)).toEqual(["aaaa0001", "aaaa0002", "aaaa0003"]);
		expect(instance.dirty).toBe(true);
		instance.undo();
		instance.markSaved();
		expect(instance.dirty).toBe(false);
	});

	it("retargets a compaction boundary and drops dependent bookkeeping entries", () => {
		const entries: SessionEntry[] = [
			userEntry("cccc0001", null, "old"),
			userEntry("cccc0002", "cccc0001", "kept"),
			{
				type: "compaction",
				id: "cccc0003",
				parentId: "cccc0002",
				timestamp: "2026-01-01T00:00:04.000Z",
				summary: "summary",
				firstKeptEntryId: "cccc0002",
				tokensBefore: 10,
			},
			{
				type: "label",
				id: "cccc0004",
				parentId: "cccc0003",
				timestamp: "2026-01-01T00:00:05.000Z",
				targetId: "cccc0002",
				label: "keep",
			},
			{
				type: "label",
				id: "cccc0005",
				parentId: "cccc0004",
				timestamp: "2026-01-01T00:00:06.000Z",
				targetId: "cccc0001",
				label: "old",
			},
		];
		const instance = model(entries);
		const result = instance.removeEntry("cccc0002", { cascade: false });
		expect(result.removedIds).toEqual(["cccc0002"]);
		expect(ids(instance)).toEqual(["cccc0001", "cccc0003", "cccc0005"]);
		expect(result.notices).toContain("compaction cccc0003 lost its retained boundary");
		expect(result.notices).toContain("dropped label cccc0004 for a removed entry");
	});

	it("reports change counts and serializes the edited session", () => {
		const instance = model();
		instance.removeEntry("aaaa0004");
		instance.insertEntry(0, { kind: "user", text: "first" });
		expect(instance.diffSummary()).toMatchObject({ added: 1, removed: 1, total: 4 });
		const lines = instance.serialize().trimEnd().split("\n");
		expect(lines).toHaveLength(5);
		expect(JSON.parse(lines[0]!)).toMatchObject({ type: "session", id: header.id });
		expect(instance.renderDocument()).toContain("prime-agent session editor");
	});
});
