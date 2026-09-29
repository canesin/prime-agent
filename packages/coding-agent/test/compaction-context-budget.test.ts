import type { Message, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	DEFAULT_COMPACTION_SETTINGS,
	estimateSummaryRequestTokens,
} from "../src/core/compaction/compaction.js";
import { boundedSummaryPrompt, summaryBudget } from "../src/core/compaction/context-budget.js";
import { serializeConversation, serializeConversationParts } from "../src/core/compaction/utils.js";

const render = (conversation: string, previous: string | undefined) =>
	`<conversation>\n${conversation}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}INSTRUCTIONS`;

describe("compaction context budget", () => {
	it("budgets input text in bytes rather than one byte per token", () => {
		const model = { contextWindow: 200_000, maxTokens: 32_000 } as Model<string>;
		const { maxTokens, maxInputBytes } = summaryBudget(model, 13_107);
		expect(maxTokens).toBe(13_107);
		expect(maxInputBytes).toBe((180_000 - 13_107 - 512) * 3);
	});

	it("renders every message through the caller's builder when the request fits", () => {
		const prompt = boundedSummaryPrompt(["[User]: one", "[Assistant]: two"], render, "prior", 10_000);
		expect(prompt).toBe(render("[User]: one\n\n[Assistant]: two", "prior"));
	});

	it("drops the oldest messages first and discloses the omission", () => {
		const old = `[User]: ${"o".repeat(400)}`;
		const recent = "[Assistant]: newest";
		const prompt = boundedSummaryPrompt(
			[old, recent],
			render,
			undefined,
			Buffer.byteLength(render("", undefined)) + 200,
		);
		expect(prompt).toContain("[Older history omitted");
		expect(prompt).toContain(recent);
		expect(prompt).not.toContain(old);
	});

	it("keeps both ends of an over-long previous summary without claiming history was omitted", () => {
		const previous = `## Goal\nship it\n${"middle ".repeat(400)}\n## Next Steps\n1. release`;
		const prompt = boundedSummaryPrompt(["[User]: hi"], render, previous, 1_200);
		expect(prompt).toContain("## Goal");
		expect(prompt).toContain("1. release");
		expect(prompt).toContain("[... earlier summary details omitted ...]");
		expect(prompt).not.toContain("[Older history omitted");
	});

	it("shares tool-call indices across per-message chunks", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } }],
			},
			{
				role: "toolResult",
				toolCallId: "call-a",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
			},
		] as unknown as Message[];
		const parts = serializeConversationParts(messages);
		expect(parts).toHaveLength(2);
		expect(parts[1]).toContain("[Tool result (read) #1]");
		expect(parts.join("\n\n")).toBe(serializeConversation(messages));
	});

	it("sizes the history call a split turn issues for a previous summary alone", () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [],
			turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 1 }],
			isSplitTurn: true,
			tokensBefore: 0,
			previousSummary: "p".repeat(40_000),
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: DEFAULT_COMPACTION_SETTINGS,
		};
		expect(estimateSummaryRequestTokens(preparation)).toBeGreaterThan(10_000);
	});
});
