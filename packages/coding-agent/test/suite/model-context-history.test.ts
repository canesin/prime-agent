import { readFileSync } from "node:fs";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateTokens, findCutPoint, generateSummary } from "../../src/core/compaction/compaction.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

describe("history across context window changes", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("counts custom kernel snapshots when retaining recent context", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "original task", timestamp: 1 });
		for (let i = 0; i < 100; i++) manager.appendCustomMessageEntry("ipython_state", "x".repeat(4000), false);
		manager.appendMessage({ role: "user", content: "continue", timestamp: 2 });
		const entries = manager.getBranch();
		const cut = findCutPoint(entries, 0, entries.length, 2000);
		expect(entries.length - cut.firstKeptEntryIndex).toBeLessThanOrEqual(3);
	});

	it("fits the summary request to the selected model, including a giant message and prior summary", async () => {
		const harness = await createHarness({ models: [{ id: "small", contextWindow: 8192, maxTokens: 2048 }] });
		harnesses.push(harness);
		let requested = false;
		harness.setResponses([
			(context, options) => {
				requested = true;
				const input =
					(context.systemPrompt?.length ?? 0) / 4 + context.messages.reduce((n, m) => n + estimateTokens(m), 0);
				expect(input + (options?.maxTokens ?? 0)).toBeLessThan(8192);
				expect(getMessageText(context.messages.at(-1))).toContain("latest decision");
				return fauxAssistantMessage("checkpoint");
			},
		]);
		await generateSummary(
			[
				{ role: "user", content: "old history ".repeat(100000), timestamp: 1 },
				{ role: "user", content: "latest decision", timestamp: 2 },
			],
			harness.getModel(),
			16384,
			"faux-key",
			undefined,
			undefined,
			undefined,
			"old summary ".repeat(20000),
		);
		expect(requested).toBe(true);
	});

	it("compacts before the first request after switching to a smaller model and preserves the session log", async () => {
		const harness = await createHarness({
			models: [
				{ id: "large", contextWindow: 200000, maxTokens: 4096 },
				{ id: "small", contextWindow: 16000, maxTokens: 2048 },
			],
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("started")]);
		await harness.session.prompt("start");
		const first = harness.sessionManager.appendCustomMessageEntry(
			"ipython_state",
			"archived value ".repeat(3000),
			false,
		);
		for (let i = 0; i < 30; i++)
			harness.sessionManager.appendCustomMessageEntry("ipython_state", "old state ".repeat(2000), false);
		harness.sessionManager.appendCompaction("existing checkpoint", first, 160000);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const sessionFile = harness.sessionManager.getSessionFile()!;
		const original = readFileSync(sessionFile);
		let requests = 0;
		const response: FauxResponseFactory = (context, options) => {
			requests++;
			const input =
				(context.systemPrompt?.length ?? 0) / 4 + context.messages.reduce((n, m) => n + estimateTokens(m), 0);
			expect(input + (options?.maxTokens ?? 0)).toBeLessThan(16000);
			return fauxAssistantMessage("checkpoint or continued work");
		};
		harness.setResponses(Array.from({ length: 5 }, () => response));
		await harness.session.setModel(harness.getModel("small")!);
		await harness.session.prompt("continue the task");
		expect(harness.eventsOfType("compaction_start").length).toBeGreaterThan(0);
		expect(requests).toBeGreaterThanOrEqual(2);
		expect(readFileSync(sessionFile).subarray(0, original.length)).toEqual(original);
		expect(harness.sessionManager.getEntries().find((entry) => entry.id === first)).toBeDefined();
	});

	it.each([true, false])("leaves fitting history intact with automatic compaction %s", async (enabled) => {
		const harness = await createHarness({
			models: [
				{ id: "large", contextWindow: 200000 },
				{ id: "small", contextWindow: 16000 },
			],
			settings: { compaction: { enabled } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("started"), fauxAssistantMessage("continued")]);
		await harness.session.prompt("remember my task");
		await harness.session.setModel(harness.getModel("small")!);
		await harness.session.prompt("continue");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.session.messages.some((message) => getMessageText(message) === "remember my task")).toBe(true);
	});

	it("bounds a single oversized Unicode message without splitting code points", async () => {
		const harness = await createHarness({ models: [{ id: "small", contextWindow: 8192, maxTokens: 2048 }] });
		harnesses.push(harness);
		harness.setResponses([
			(context, options) => {
				const text = context.messages.map(getMessageText).join("");
				expect(
					Buffer.byteLength(text + context.systemPrompt) + (options?.maxTokens ?? 0) + 512,
				).toBeLessThanOrEqual(8192 * 0.9);
				expect(text).toContain("latest decision");
				expect(text).not.toContain("\ufffd");
				return fauxAssistantMessage("checkpoint");
			},
		]);
		await generateSummary(
			[{ role: "user", content: `${"資料🚀".repeat(100000)}latest decision`, timestamp: 1 }],
			harness.getModel(),
			16384,
			"faux-key",
		);
	});

	it("does not send overflowing history after an extension cancels compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "small", contextWindow: 16000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.sessionManager.appendMessage({ role: "user", content: "x".repeat(100000), timestamp: 1 });
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			() => {
				throw new Error("provider must not receive overflowing history");
			},
		]);
		await expect(harness.session.prompt("continue")).rejects.toThrow("Context still exceeds");
		await harness.session.waitForHeadlessIdle();
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
