import { fauxAssistantMessage, type ModelThinkingLevel, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type SideQuestionEvent, type SideQuestionRun, startSideQuestion } from "../../src/core/side-question.js";
import { createHarness, getMessageText } from "./harness.js";

const THINKING_REQUIRED =
	'400 {"error":{"code":"1210","message":"This model always engages in thinking and cannot be disabled; please use low, high, or max"}}';

describe("side question thinking", () => {
	it.each([
		{ name: "non-reasoning", reasoning: false, map: undefined, expected: "off" },
		{ name: "optional reasoning", reasoning: true, map: undefined, expected: "off" },
		{ name: "mandatory reasoning", reasoning: true, map: { off: null, minimal: null }, expected: "low" },
		{
			name: "single supported effort",
			reasoning: true,
			map: { off: null, minimal: null, low: null, medium: null, high: null, max: "max" },
			expected: "max",
		},
	])("selects the lowest supported level for $name", async ({ reasoning, map, expected }) => {
		const harness = await createHarness({ models: [{ id: "custom-model", reasoning }] });
		try {
			harness.session.agent.state.model.thinkingLevelMap = map;
			harness.session.agent.state.thinkingLevel = "high";
			const observed: (ModelThinkingLevel | undefined)[] = [];
			harness.setResponses([
				(_context, options) => {
					observed.push((options as SimpleStreamOptions)?.reasoning);
					return fauxAssistantMessage("answer");
				},
			]);
			const events: SideQuestionEvent[] = [];
			await startSideQuestion(harness.session.agent, "side", "question", (event) => {
				events.push(event);
			}).done;
			expect(observed).toEqual([expected]);
			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "answer" });
			expect(harness.session.agent.state.thinkingLevel).toBe("high");
		} finally {
			harness.cleanup();
		}
	});

	it.each(["high", "off"] as const)("recovers missing metadata with parent thinking %s", async (parentThinking) => {
		const harness = await createHarness({ models: [{ id: "custom-model", reasoning: true }] });
		try {
			harness.session.agent.state.thinkingLevel = parentThinking;
			harness.session.agent.state.messages = [{ role: "user", content: "main context", timestamp: 1 }];
			const messagesBefore = structuredClone(harness.session.messages);
			const entriesBefore = structuredClone(harness.sessionManager.getEntries());
			const requests: string[][] = [];
			const reasoning: (ModelThinkingLevel | undefined)[] = [];
			harness.setResponses([
				(context, options) => {
					requests.push(context.messages.map(getMessageText));
					reasoning.push((options as SimpleStreamOptions)?.reasoning);
					return fauxAssistantMessage([], { stopReason: "error", errorMessage: THINKING_REQUIRED });
				},
				(context, options) => {
					requests.push(context.messages.map(getMessageText));
					reasoning.push((options as SimpleStreamOptions)?.reasoning);
					expect(context.tools).toEqual([]);
					return fauxAssistantMessage("recovered answer");
				},
			]);
			const events: SideQuestionEvent[] = [];
			await startSideQuestion(
				harness.session.agent,
				"side",
				"follow-up",
				(event) => {
					events.push(event);
				},
				[{ question: "earlier question", answer: "earlier answer" }],
			).done;
			expect(reasoning).toEqual(["off", parentThinking === "off" ? "low" : parentThinking]);
			expect(requests[1]).toEqual(requests[0]);
			expect(requests[1]).toHaveLength(4);
			expect(events.filter((event) => event.status !== "running")).toEqual([
				expect.objectContaining({ status: "complete", answer: "recovered answer" }),
			]);
			expect(harness.session.messages).toEqual(messagesBefore);
			expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
			expect(harness.session.agent.state.thinkingLevel).toBe(parentThinking);
		} finally {
			harness.cleanup();
		}
	});

	it("stops after one unsuccessful recovery", async () => {
		const harness = await createHarness({ models: [{ id: "custom-model", reasoning: true }] });
		try {
			harness.setResponses([
				fauxAssistantMessage([], { stopReason: "error", errorMessage: THINKING_REQUIRED }),
				fauxAssistantMessage([], { stopReason: "error", errorMessage: THINKING_REQUIRED }),
				fauxAssistantMessage("must not run"),
			]);
			const events: SideQuestionEvent[] = [];
			await startSideQuestion(harness.session.agent, "side", "question", (event) => {
				events.push(event);
			}).done;
			expect(harness.faux.state.callCount).toBe(2);
			expect(events.at(-1)).toMatchObject({ status: "error", errorMessage: THINKING_REQUIRED });
		} finally {
			harness.cleanup();
		}
	});

	it.each([
		"401 authentication failed",
		"429 rate limit exceeded",
		"500 server error",
		"400 missing reasoning_content in assistant message",
		"400 invalid thinking budget_tokens",
	])("does not retry unrelated failures: %s", async (errorMessage) => {
		const harness = await createHarness({ models: [{ id: "custom-model", reasoning: true }] });
		try {
			harness.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage })]);
			const events: SideQuestionEvent[] = [];
			await startSideQuestion(harness.session.agent, "side", "question", (event) => {
				events.push(event);
			}).done;
			expect(harness.faux.state.callCount).toBe(1);
			expect(events.at(-1)).toMatchObject({ status: "error", errorMessage });
		} finally {
			harness.cleanup();
		}
	});

	it.each(["text", "thinking", "usage"] as const)("does not retry after partial %s output", async (type) => {
		const harness = await createHarness({ models: [{ id: "custom-model", reasoning: true }] });
		try {
			const response = fauxAssistantMessage(
				type === "text" ? { type, text: "partial" } : type === "thinking" ? { type, thinking: "partial" } : [],
				{ stopReason: "error", errorMessage: THINKING_REQUIRED },
			);
			if (type === "usage") {
				const streamFn = harness.session.agent.streamFn;
				harness.session.agent.streamFn = async (model, context, options) => {
					const stream = await streamFn(model, context, options);
					const result = await stream.result();
					// Faux estimates usage from content; simulate hidden billed output.
					result.usage = { ...result.usage, output: 10, totalTokens: result.usage.totalTokens + 10 };
					return stream;
				};
			}
			harness.setResponses([response]);
			await startSideQuestion(harness.session.agent, "side", "question", () => {}).done;
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("does not retry a cancelled request", async () => {
		const harness = await createHarness({ models: [{ id: "custom-model", reasoning: true }] });
		try {
			let run: SideQuestionRun;
			harness.setResponses([
				() => {
					run.abort();
					return fauxAssistantMessage([], { stopReason: "error", errorMessage: THINKING_REQUIRED });
				},
			]);
			const events: SideQuestionEvent[] = [];
			run = startSideQuestion(harness.session.agent, "side", "question", (event) => {
				events.push(event);
			});
			await run.done;
			expect(harness.faux.state.callCount).toBe(1);
			expect(events.at(-1)).toMatchObject({ status: "cancelled" });
		} finally {
			harness.cleanup();
		}
	});
});
