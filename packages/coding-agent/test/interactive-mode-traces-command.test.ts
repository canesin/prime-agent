import { describe, expect, it } from "vitest";
import { ProviderAuthFlows } from "../src/modes/interactive/auth-flows.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("removed trace sharing UI", () => {
	it("has no trace command, autocomplete, or upload handlers", () => {
		for (const method of [
			"handleTracesCommand",
			"getTracesArgumentCompletions",
			"uploadCurrentTraceOnce",
			"uploadAllTraces",
			"askOnboardingTraceOptIn",
		]) {
			expect(Reflect.has(InteractiveMode.prototype, method), method).toBe(false);
		}
	});

	it("has no trace sharing login flow", () => {
		expect(Reflect.has(ProviderAuthFlows.prototype, "runPrimeAgentTracesLogin")).toBe(false);
	});
});
