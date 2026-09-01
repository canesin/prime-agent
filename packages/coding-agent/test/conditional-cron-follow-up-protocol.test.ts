import { describe, expect, it } from "vitest";
import {
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	type DaemonCommand,
	getDaemonCommandCompatibilities,
} from "../src/modes/daemon/daemon-protocol.js";

describe("conditional cron follow-up protocol", () => {
	it("capability-gates follow-up delivery while preserving guarded goal-start compatibility", () => {
		const base = {
			type: "cron_add",
			activeSessionId: "active-1",
			schedule: "in 1m",
			prompt: "continue",
			deliveryFence: {
				version: 1,
				activeSessionId: "active-1",
				sessionName: "kene",
				cwd: "/tmp/kene",
				model: { provider: "openai", id: "gpt-5.6" },
				thinkingLevel: "xhigh",
				messageCount: 4,
				lastActivityAt: "2026-09-01T10:00:00.000Z",
				taskState: "needs_input",
				goal: {
					active: true,
					status: "active",
					goalId: "goal-1",
					updatedAt: 1,
				},
			},
		} as const;
		const goalStart = base as DaemonCommand;
		const followUp = { ...base, deliveryMode: "follow_up" } as DaemonCommand;

		expect(getDaemonCommandCompatibilities(goalStart)).toEqual([
			{ minProtocol: 7, minSchemaRevision: 26, capability: "conditional_cron_delivery" },
			{ minProtocol: 7 },
		]);
		expect(getDaemonCommandCompatibilities(followUp)).toEqual([
			{ minProtocol: 7, minSchemaRevision: 26, capability: "conditional_cron_delivery" },
			{ minProtocol: 7, minSchemaRevision: 28, capability: "conditional_cron_follow_up" },
			{ minProtocol: 7 },
		]);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).toContain("conditional_cron_follow_up");
	});
});
