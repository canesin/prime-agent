import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";
import { streamSimpleAnthropic } from "../src/providers/anthropic.js";
import { streamOpenAICompletions, streamSimpleOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamOpenAIResponses, streamSimpleOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model, ModelThinkingLevel, SimpleStreamOptions } from "../src/types.js";

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

type ZaiApi = "anthropic-messages" | "openai-completions" | "openai-responses";

function customModel<T extends ZaiApi>(api: T, id: string): Model<T> {
	const baseUrls = {
		"anthropic-messages": "https://api.z.ai/api/anthropic",
		"openai-completions": "https://api.z.ai/api/paas/v4",
		"openai-responses": "https://api.z.ai/api/v1",
	};
	return {
		api,
		id,
		name: id,
		provider: "custom-zai",
		baseUrl: baseUrls[api],
		reasoning: true,
		input: ["text"],
		contextWindow: 1000000,
		maxTokens: 131072,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

async function captureCustomPayload(api: ZaiApi, id: string, reasoning?: ModelThinkingLevel): Promise<unknown> {
	let payload: unknown;
	const controller = new AbortController();
	const options: SimpleStreamOptions = {
		apiKey: "fake-key",
		reasoning,
		signal: controller.signal,
		onPayload: (value) => {
			payload = value;
			controller.abort();
			throw new Error("payload captured; no network request");
		},
	};
	if (api === "anthropic-messages") await streamSimpleAnthropic(customModel(api, id), context, options).result();
	else if (api === "openai-completions")
		await streamSimpleOpenAICompletions(customModel(api, id), context, options).result();
	else await streamSimpleOpenAIResponses(customModel(api, id), context, options).result();
	return payload;
}

describe("Z.ai mandatory thinking payload", () => {
	it.each([
		{ requested: undefined, expected: "high" },
		{ requested: "minimal", expected: "low" },
		{ requested: "medium", expected: "high" },
		{ requested: "xhigh", expected: "max" },
	] as const)("clamps direct Responses effort $requested to $expected", async ({ requested, expected }) => {
		let payload: unknown;
		const controller = new AbortController();
		await streamOpenAIResponses(customModel("openai-responses", "glm-5.3"), context, {
			apiKey: "fake-key",
			reasoningEffort: requested,
			reasoningSummary: "auto",
			signal: controller.signal,
			onPayload: (value) => {
				payload = value;
				controller.abort();
				throw new Error("payload captured; no network request");
			},
		}).result();
		expect(payload).toMatchObject({ reasoning: { effort: expected, summary: "auto" } });
	});

	for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
		it.each(["glm-5.3", "glm-5.3-flash"])(`${api} enables thinking for custom %s without metadata`, async (id) => {
			expect(getSupportedThinkingLevels(customModel(api, id))).toEqual(["low", "high", "max"]);
			const payload = await captureCustomPayload(api, id, "off");
			if (api === "anthropic-messages") {
				expect(payload).toMatchObject({ thinking: { type: "enabled", budget_tokens: 2048 } });
			} else if (api === "openai-completions") {
				expect(payload).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low" });
			} else {
				expect(payload).toMatchObject({ reasoning: { effort: "low" } });
			}
		});

		it(`${api} does not implicitly disable mandatory thinking when reasoning is omitted`, async () => {
			const payload = await captureCustomPayload(api, "glm-5.3");
			expect(payload).not.toHaveProperty("thinking");
			expect(payload).not.toHaveProperty("reasoning");
			expect(payload).not.toHaveProperty("enable_thinking");
		});
	}

	it("does not impose Z.ai restrictions on unrelated endpoints or future model families", () => {
		const model = customModel("openai-completions", "glm-5.3");
		for (const baseUrl of ["https://example.com/api.z.ai", "https://api.z.ai.example.com", "invalid-url"]) {
			expect(getSupportedThinkingLevels({ ...model, baseUrl })).toContain("off");
		}
		expect(getSupportedThinkingLevels({ ...model, id: "glm-5.30" })).toContain("off");
		expect(getSupportedThinkingLevels({ ...model, id: "glm-5.2" })).toContain("off");
	});

	it("honors explicit custom capability overrides", () => {
		const model = customModel("openai-completions", "glm-5.3");
		expect(getSupportedThinkingLevels({ ...model, thinkingLevelMap: { off: "none" } })).toContain("off");
	});
	for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-highspeed"] as const) {
		it(`${id} exposes only supported reasoning levels`, () => {
			expect(getSupportedThinkingLevels(getModel("zai", id))).toEqual(["low", "high", "max"]);
		});

		it.each([
			["off", "low"],
			["minimal", "low"],
			["low", "low"],
			["medium", "high"],
			["high", "high"],
			["xhigh", "max"],
			["max", "max"],
		] satisfies [ModelThinkingLevel, string][])(`${id} maps %s to %s`, async (reasoning, effort) => {
			let payload: unknown;
			await streamSimpleOpenAICompletions(getModel("zai", id), context, {
				apiKey: "fake-key",
				reasoning,
				onPayload: (value) => {
					payload = value;
					throw new Error("payload captured; no network request");
				},
			}).result();
			expect(payload).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: effort });
			expect(payload).not.toHaveProperty("enable_thinking");
		});
	}

	it("preserves the model default when reasoning is omitted", async () => {
		let payload: unknown;
		await streamSimpleOpenAICompletions(getModel("zai", "glm-5.3"), context, {
			apiKey: "fake-key",
			onPayload: (value) => {
				payload = value;
				throw new Error("payload captured; no network request");
			},
		}).result();
		expect(payload).not.toHaveProperty("thinking");
		expect(payload).not.toHaveProperty("reasoning_effort");
		expect(payload).not.toHaveProperty("enable_thinking");
	});

	it("honors mandatory thinking in the provider-specific API too", async () => {
		let payload: unknown;
		await streamOpenAICompletions(getModel("zai", "glm-5.3"), context, {
			apiKey: "fake-key",
			reasoningEnabled: false,
			onPayload: (value) => {
				payload = value;
				throw new Error("payload captured; no network request");
			},
		}).result();
		expect(payload).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low" });
	});
});
