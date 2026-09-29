import { existsSync } from "node:fs";
import type { AgentContext, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	registerApiProvider,
	type Usage,
	unregisterApiProviders,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import type { ExtensionFactory } from "../../src/core/extensions/types.js";
import { GOAL_CONTINUATION_GUARD_TYPE, GoalContinuationGuard } from "../../src/core/goal-continuation-guard.js";
import { GOAL_STATE_CUSTOM_TYPE } from "../../src/core/goals.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";
import {
	conversationMessages,
	createHarness,
	getAssistantTexts,
	getMessageText,
	type Harness,
	type HarnessOptions,
} from "./harness.js";

function assistantWithUsage(message: string | AssistantMessage, usage: Partial<Usage>): AssistantMessage {
	const base = typeof message === "string" ? fauxAssistantMessage(message) : message;
	return {
		...base,
		usage: { ...base.usage, ...usage, cost: { ...base.usage.cost, ...usage.cost } },
	};
}

function goalContextMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "goal_context",
	);
}

function visibleAssistantTexts(harness: Harness): string[] {
	return getAssistantTexts(harness).filter(Boolean);
}

function currentAgentContext(harness: Harness): AgentContext {
	const state = harness.session.agent.state;
	return {
		systemPrompt: state.systemPrompt,
		messages: [...state.messages],
		tools: [...state.tools],
	};
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition was not met");
}

/**
 * Stand-in for the real ipython tool. Goal calls reach the host over the
 * kernel comm bridge while an ipython cell executes; this stub mirrors that
 * timing by dispatching `goal.*` host requests from inside tool execution.
 *
 * Cell format: `goal.<op>` optionally followed by a JSON payload, e.g.
 * `goal.create {"objective": "write a note"}`.
 */
function createFauxIpythonTool(sessionRef: { current?: AgentSession }): AgentTool {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python code in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId, params) => {
			const session = sessionRef.current;
			if (!session) {
				throw new Error("test session is not initialized");
			}
			const code = (params as { code: string }).code.trim();
			let text = "";
			if (code.startsWith("goal.")) {
				const spaceIndex = code.indexOf(" ");
				const type = spaceIndex < 0 ? code : code.slice(0, spaceIndex);
				const payload = spaceIndex < 0 ? {} : JSON.parse(code.slice(spaceIndex + 1));
				text = JSON.stringify(session.handleGoalHostRequest(type, payload));
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	};
}

const COMPLETE_GOAL_CELL = { code: "goal.complete" };

function completeGoalResponses(): AssistantMessage[] {
	return [
		fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
		fauxAssistantMessage("Goal complete."),
	];
}

function createWaitingTool(): {
	tool: AgentTool;
	release: () => void;
	waitForStart: (harness: Harness) => Promise<void>;
} {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			await new Promise<void>((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				const abort = () => reject(new Error("aborted"));
				signal?.addEventListener("abort", abort, { once: true });
				toolRelease.then(() => {
					signal?.removeEventListener("abort", abort);
					resolve();
				});
			});
			return { content: [{ type: "text", text: "released" }], details: {}, terminate: true };
		},
	};
	return {
		tool,
		release: () => releaseToolExecution?.(),
		waitForStart: (harness) =>
			new Promise<void>((resolve) => {
				const unsubscribe = harness.session.subscribe((event) => {
					if (event.type === "tool_execution_start" && event.toolName === "wait") {
						unsubscribe();
						resolve();
					}
				});
			}),
	};
}

describe("AgentSession goals", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createGoalHarness(
		extraTools: AgentTool[] = [],
		settings?: HarnessOptions["settings"],
	): Promise<Harness> {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({ tools: [createFauxIpythonTool(sessionRef), ...extraTools], settings });
		sessionRef.current = harness.session;
		harnesses.push(harness);
		return harness;
	}

	it.each([
		["", "", ""],
		["Need approval.", "Still waiting for permission.", "Cannot proceed yet."],
	])("pauses after three completed no-tool cycles: %j", async (...texts) => {
		const harness = await createGoalHarness();
		harness.setResponses([...texts.map((text) => fauxAssistantMessage(text)), fauxAssistantMessage("sentinel")]);
		await harness.session.prompt("/goal blocked work");
		expect(harness.session.goalState).toMatchObject({ status: "paused", continuationsUsed: 2 });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not let historical tools exempt later idle cycles", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "pass" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Tool work finished."),
			...Array.from({ length: 3 }, () => fauxAssistantMessage("Waiting.")),
			fauxAssistantMessage("sentinel"),
		]);
		await harness.session.prompt("/goal blocked work");
		expect(harness.session.goalState).toMatchObject({ status: "paused", continuationsUsed: 3 });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("registers goal.pause with the real kernel host handlers and preserves accounting", async () => {
		const harness = await createGoalHarness();
		const handlers = (
			harness.session as unknown as {
				_createKernelHostHandlers(): Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;
			}
		)._createKernelHostHandlers();
		expect(handlers["goal.pause"]).toBeTypeOf("function");
		harness.session.handleGoalHostRequest("goal.create", { objective: "needs approval" });
		const before = harness.session.goalState;
		const paused = await handlers["goal.pause"]({ reason: "  Approval required  " });
		expect(paused).toMatchObject({ goal: { status: "paused", tokens_used: before.tokensUsed } });
		expect(harness.sessionManager.getBranch().at(-1)).toMatchObject({
			data: { status: "paused", lastReason: "Approval required" },
		});
		expect(await handlers["goal.pause"]({ reason: "another reason" })).toEqual(paused);
	});

	it("keeps pause from falling through to autonomous mode but allows user work", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			autonomous: { enabled: true, maxContinuations: 2 },
		});
		sessionRef.current = harness.session;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: 'goal.pause {"reason":"Approval required"}' }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Please approve."),
			fauxAssistantMessage("sentinel"),
		]);
		await harness.session.prompt("/goal needs approval");
		expect(harness.session.goalState.status).toBe("paused");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.getAutonomousStatus()).toMatchObject({ enabled: true, continuationsUsed: 0 });
		harness.setResponses([
			fauxAssistantMessage("Side question answered."),
			fauxAssistantMessage("Independent follow-up."),
			fauxAssistantMessage("Finished."),
			fauxAssistantMessage("sentinel"),
		]);
		await harness.session.prompt("Answer this side question");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.getAutonomousStatus()).toMatchObject({ enabled: true, continuationsUsed: 2 });
		expect(harness.session.goalState.status).toBe("paused");
	});

	it("keeps the pause block across scheduled rpc prompts", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			autonomous: { enabled: true, maxContinuations: 2 },
		});
		sessionRef.current = harness.session;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: 'goal.pause {"reason":"Approval required"}' }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Please approve."),
		]);
		await harness.session.prompt("/goal needs approval");
		expect(harness.session.goalState.status).toBe("paused");
		harness.setResponses([fauxAssistantMessage("Scheduled check done."), fauxAssistantMessage("sentinel")]);

		await harness.session.prompt("scheduled check", { source: "rpc", priority: "background" });

		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.getAutonomousStatus()).toMatchObject({ enabled: true, continuationsUsed: 0 });
	});

	it("drops a pending quota wake when the goal is paused", async () => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "work" });
		const internals = harness.session as unknown as { _quotaPark?: { parkCount: number; resumeAtMs: number } };
		internals._quotaPark = { parkCount: 1, resumeAtMs: Date.now() + 60_000 };

		harness.session.handleGoalHostRequest("goal.pause", { reason: "Approval required" });

		expect(internals._quotaPark).toBeUndefined();
		expect(harness.sessionManager.getBranch()).toContainEqual(
			expect.objectContaining({ customType: "provider_quota_resume", data: { outcome: "goal-paused" } }),
		);
	});

	it("counts tools from an interrupted cycle so the next reply is not idle", async () => {
		const sessionRef: { current?: AgentSession } = {};
		const stopTool: AgentTool = {
			name: "stop",
			label: "stop",
			description: "interrupts the run",
			parameters: Type.Object({}),
			execute: async () => {
				sessionRef.current?.requestAbort();
				return { content: [{ type: "text", text: "interrupted" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [stopTool] });
		sessionRef.current = harness.session;
		harnesses.push(harness);
		harness.session.handleGoalHostRequest("goal.create", { objective: "work" });
		harness.setResponses([fauxAssistantMessage(fauxToolCall("stop", {}), { stopReason: "toolUse" })]);

		await harness.session.prompt("start");
		await harness.session.waitForIdle();

		const guardEntries = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === GOAL_CONTINUATION_GUARD_TYPE);
		expect(guardEntries.at(-1)).toMatchObject({ data: { pendingTools: true, idleCycles: 0 } });
	});

	it("persists the guard across restart and resets it on explicit resume", async () => {
		const original = await createHarness({ persistSession: true });
		harnesses.push(original);
		original.setResponses([
			fauxAssistantMessage("One"),
			fauxAssistantMessage("Two"),
			fauxAssistantMessage("", { stopReason: "aborted" }),
		]);
		await original.session.prompt("/goal blocked work");
		const resumed = await createHarness({ existingSessionFile: original.sessionManager.getSessionFile()! });
		harnesses.push(resumed);
		resumed.setResponses([fauxAssistantMessage("Three"), fauxAssistantMessage("sentinel")]);
		await resumed.session.prompt("continue");
		expect(resumed.session.goalState.status).toBe("paused");
		expect(resumed.getPendingResponseCount()).toBe(1);
		const usage = resumed.session.goalState.tokensUsed;
		resumed.setResponses([
			fauxAssistantMessage("One"),
			fauxAssistantMessage("Two"),
			fauxAssistantMessage("Three"),
			fauxAssistantMessage("sentinel"),
		]);
		await resumed.session.prompt("/goal resume");
		expect(resumed.session.goalState.status).toBe("paused");
		expect(resumed.session.goalState.tokensUsed).toBeGreaterThanOrEqual(usage);
		expect(resumed.getPendingResponseCount()).toBe(1);
	});

	it.each([undefined, "", "   ", 12, "x".repeat(1001)])("rejects invalid pause reason %j", async (reason) => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "work" });
		expect(() => harness.session.handleGoalHostRequest("goal.pause", { reason })).toThrow("goal.pause reason");
		expect(harness.session.goalState.status).toBe("active");
	});

	it("accepts a trimmed 1000-codepoint pause reason", async () => {
		const harness = await createGoalHarness();
		harness.session.handleGoalHostRequest("goal.create", { objective: "work" });
		harness.session.handleGoalHostRequest("goal.pause", { reason: `  ${"\u{1D11E}".repeat(1000)}  ` });
		expect([...harness.session.goalState.lastReason!]).toHaveLength(1000);
	});

	it.each(["idle", "complete", "error", "budget_limited"])("does not downgrade %s through pause", async (status) => {
		const harness = await createGoalHarness();
		if (status !== "idle") harness.session.handleGoalHostRequest("goal.create", { objective: "work" });
		if (status === "complete") harness.session.handleGoalHostRequest("goal.complete");
		if (status === "error") {
			harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminal" })]);
			await harness.session.prompt("work");
		}
		if (status === "budget_limited") {
			harness.setResponses([fauxAssistantMessage("spent"), fauxAssistantMessage("summary")]);
			await harness.session.prompt("/goal --budget 1 work");
		}
		const before = harness.session.goalState;
		expect(() => harness.session.handleGoalHostRequest("goal.pause", { reason: "blocked" })).toThrow(
			`status ${status}`,
		);
		expect(harness.session.goalState).toEqual(before);
	});

	it("retains idle history through reload but resets it for an objective edit", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("", { stopReason: "aborted" }),
		]);
		await harness.session.prompt("/goal first objective");
		const provider = getApiProvider(harness.faux.api)!;
		await harness.session.reload();
		registerApiProvider(provider, "goal-reload-test");
		harness.setResponses([fauxAssistantMessage("three"), fauxAssistantMessage("sentinel")]);
		await harness.session.prompt("continue");
		expect(harness.session.goalState.status).toBe("paused");
		expect(harness.getPendingResponseCount()).toBe(1);
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
			fauxAssistantMessage("sentinel"),
		]);
		await harness.session.prompt("/goal changed objective");
		expect(harness.session.goalState).toMatchObject({
			status: "paused",
			objective: "changed objective",
			continuationsUsed: 2,
		});
		expect(harness.getPendingResponseCount()).toBe(1);
		unregisterApiProviders("goal-reload-test");
	});

	it.each([false, true])(
		"resumes own background work once after settlement (completion notice: %s)",
		async (notice) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const provisioner = (
				harness.session as unknown as {
					_ipythonKernelProvisioner: {
						manager?: { hasBackgroundWork: boolean };
						options: {
							onBackgroundWorkSettled: () => void;
							hostHandlers: Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;
						};
					};
				}
			)._ipythonKernelProvisioner;
			let active = true;
			const manager = vi
				.spyOn(provisioner, "manager", "get")
				.mockImplementation(() => ({ hasBackgroundWork: active }));
			try {
				harness.setResponses([fauxAssistantMessage("Waiting for command.")]);
				await harness.session.prompt("/goal finish command work");
				expect(harness.session.goalState).toMatchObject({ status: "active", continuationsUsed: 0 });
				if (notice) {
					harness.setResponses([fauxAssistantMessage("Command finished; waiting for settlement.")]);
					await provisioner.options.hostHandlers["bash.completed"]({
						pid: 123,
						command: "test command",
						exitCode: 0,
					});
					await harness.session.waitForIdle();
					expect(harness.session.goalState.continuationsUsed).toBe(0);
				}
				harness.setResponses([
					() => {
						harness.session.handleGoalHostRequest("goal.complete");
						return fauxAssistantMessage("Finished after settlement.");
					},
					fauxAssistantMessage("sentinel"),
				]);
				active = false;
				provisioner.options.onBackgroundWorkSettled();
				provisioner.options.onBackgroundWorkSettled();
				await harness.session.waitForIdle();
				expect(harness.session.goalState).toMatchObject({ status: "complete", continuationsUsed: 1 });
				expect(harness.getPendingResponseCount()).toBe(1);
			} finally {
				manager.mockRestore();
			}
		},
	);

	it("lets an accepted completion turn own the wakeup when background work settles", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const provisioner = (
			harness.session as unknown as {
				_ipythonKernelProvisioner: {
					manager?: { hasBackgroundWork: boolean };
					options: {
						onBackgroundWorkSettled: () => void;
						hostHandlers: Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;
					};
				};
			}
		)._ipythonKernelProvisioner;
		let active = true;
		const manager = vi.spyOn(provisioner, "manager", "get").mockImplementation(() => ({ hasBackgroundWork: active }));
		try {
			harness.setResponses([fauxAssistantMessage("Waiting.")]);
			await harness.session.prompt("/goal finish command work");
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			harness.setResponses([
				async () => {
					await gate;
					harness.session.handleGoalHostRequest("goal.complete");
					return fauxAssistantMessage("Done.");
				},
				fauxAssistantMessage("sentinel"),
			]);
			await provisioner.options.hostHandlers["bash.completed"]({ pid: 123, command: "test command", exitCode: 0 });
			active = false;
			provisioner.options.onBackgroundWorkSettled();
			release();
			await harness.session.waitForIdle();
			expect(harness.session.goalState).toMatchObject({ status: "complete", continuationsUsed: 0 });
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			manager.mockRestore();
		}
	});

	it("counts tools in the first cycle of a rehydrated goal without a guard record", async () => {
		const original = await createHarness({ persistSession: true });
		harnesses.push(original);
		original.sessionManager.appendCustomEntryWithRollback(GOAL_STATE_CUSTOM_TYPE, {
			active: true,
			status: "active",
			objective: "legacy work",
			goalId: "legacy-goal",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		});
		const sessionRef: { current?: AgentSession } = {};
		const restored = await createHarness({
			existingSessionFile: original.sessionManager.getSessionFile()!,
			tools: [createFauxIpythonTool(sessionRef)],
		});
		sessionRef.current = restored.session;
		harnesses.push(restored);
		restored.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "pass" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Productive cycle."),
			fauxAssistantMessage("One"),
			fauxAssistantMessage("Two"),
			fauxAssistantMessage("Three"),
			fauxAssistantMessage("sentinel"),
		]);
		await restored.session.prompt("continue work");
		expect(restored.session.goalState).toMatchObject({ status: "paused", continuationsUsed: 3 });
		expect(restored.getPendingResponseCount()).toBe(1);
	});

	it("keeps continuing until the model completes the goal through ipython", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("I need another step."),
			fauxAssistantMessage("The work is complete."),
			...completeGoalResponses(),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(visibleAssistantTexts(harness)).toEqual([
			"I need another step.",
			"The work is complete.",
			"Goal complete.",
		]);
		expect(goalContextMessages(harness)).toHaveLength(3);
		expect(getMessageText(goalContextMessages(harness)[0])).toMatch(/^\[goal: continuation\]\n\n/);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 2,
			lastReason: "Goal achieved",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("returns goal snapshots over the host bridge and allows a fresh goal after completion", async () => {
		const harness = await createGoalHarness();

		expect(harness.session.handleGoalHostRequest("goal.get")).toEqual({
			goal: null,
			remaining_tokens: null,
			completion_budget_report: null,
		});

		const created = harness.session.handleGoalHostRequest("goal.create", {
			objective: "write a benchmark note",
			token_budget: 50,
		});
		expect(created.goal).toMatchObject({
			objective: "write a benchmark note",
			status: "active",
			token_budget: 50,
			tokens_used: 0,
		});
		expect(created.remaining_tokens).toBe(50);

		const completed = harness.session.handleGoalHostRequest("goal.complete");
		expect(completed.goal).toMatchObject({ status: "complete" });
		expect(completed.completion_budget_report).toContain("tokens used: 0 of 50");

		const second = harness.session.handleGoalHostRequest("goal.create", { objective: "second goal" });
		expect(second.goal).toMatchObject({ objective: "second goal", status: "active", tokens_used: 0 });
		expect(second.goal?.goal_id).not.toBe(created.goal?.goal_id);
		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
			objective: "second goal",
			continuationsUsed: 0,
		});
	});

	it.each([
		{
			name: "goal.create without an objective",
			type: "goal.create",
			payload: {},
			active: false,
			error: "goal.create objective must be a string",
		},
		{
			name: "an unknown request type",
			type: "goal.nonsense",
			payload: {},
			active: false,
			error: 'unknown goal request type "goal.nonsense"',
		},
		{
			name: "goal.complete without a goal",
			type: "goal.complete",
			payload: {},
			active: false,
			error: "cannot complete goal because this thread has no goal",
		},
		{
			name: "goal.create while a goal is active",
			type: "goal.create",
			payload: { objective: "second" },
			active: true,
			error: "already has an active goal",
		},
	])("rejects $name", async ({ type, payload, active, error }) => {
		const harness = await createGoalHarness();
		if (active) {
			harness.session.handleGoalHostRequest("goal.create", { objective: "first goal" });
		}

		expect(() => harness.session.handleGoalHostRequest(type, payload)).toThrow(error);
	});

	it("does not count post-completion turns against the finished goal", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{ input: 4, output: 2, totalTokens: 6 },
			),
			assistantWithUsage("Goal complete; here is a long closing summary.", {
				input: 20,
				output: 10,
				totalTokens: 30,
			}),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(harness.session.goalState.status).toBe("complete");
		const completeUpdates = harness.eventsOfType("goal_update").filter((event) => event.goal.status === "complete");
		const tokensAtCompletion = completeUpdates[0]?.goal.tokensUsed ?? 0;
		expect(tokensAtCompletion).toBeGreaterThan(0);
		// The closing-summary turn runs after goal.complete() over the host bridge;
		// it must not increase the finished goal's token usage.
		expect(harness.session.goalState.tokensUsed).toBe(tokensAtCompletion);
	});

	it.each([
		{ name: "without an active goal", withGoal: false, expected: [] as string[] },
		{ name: "with an active goal", withGoal: true, expected: ["ipython"] },
	])("runtime rebuild restores tools $name", async ({ withGoal, expected }) => {
		const harness = await createGoalHarness();
		if (withGoal) {
			harness.session.handleGoalHostRequest("goal.create", { objective: "finish the active goal" });
		} else {
			harness.session.setActiveToolsByName([]);
		}

		await harness.session.reload();

		expect(harness.session.getActiveToolNames()).toEqual(expected);
	});

	it("reloads goal state after tree navigation", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([fauxAssistantMessage("before goal")]);
		await harness.session.prompt("normal prompt");
		const beforeGoalEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!beforeGoalEntry) {
			throw new Error("expected assistant entry before goal");
		}

		harness.setResponses(completeGoalResponses());
		await harness.session.prompt("/goal finish the task");
		expect(harness.session.goalState.status).toBe("complete");

		await harness.session.navigateTree(beforeGoalEntry.id, { summarize: false });

		expect(harness.session.goalState).toMatchObject({ active: false, status: "idle" });
	});

	it.each([
		{ command: "/goal clear", status: "idle" },
		{ command: "/goal pause", status: "paused" },
	])("removes queued goal context after $command while streaming", async ({ command, status }) => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("stale goal response"),
		]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("start a blocking turn");
		await waitForStart;
		await harness.session.prompt("/goal stale goal");
		await harness.session.prompt(command);
		waiting.release();
		await promptPromise;

		expect(goalContextMessages(harness)).toHaveLength(0);
		expect(visibleAssistantTexts(harness)).toEqual([]);
		expect(harness.session.goalState.status).toBe(status);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("pauses a goal, rejects a replacement, then resumes it with /goal resume", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.prompt("/goal pause");
		waiting.release();
		await promptPromise;

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "paused",
			lastReason: "Paused by user",
		});
		expect(() => harness.session.handleGoalHostRequest("goal.create", { objective: "replacement" })).toThrow(
			"a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
		);

		harness.setResponses(completeGoalResponses());
		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			continuationsUsed: 0,
		});
	});

	it.each([
		{
			name: "completed",
			status: "complete",
			start: async (harness: Harness) => {
				harness.setResponses([...completeGoalResponses(), fauxAssistantMessage("should not run")]);
				await harness.session.prompt("/goal finish the task");
			},
			expected: {},
		},
		{
			name: "errored",
			status: "error",
			start: async (harness: Harness) => {
				harness.setResponses([
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
					fauxAssistantMessage("should not run"),
				]);
				await harness.session.prompt("/goal do work");
			},
			expected: { lastError: "invalid_api_key\n\nRun /login to update credentials." },
		},
	])("does not resume a $name goal", async ({ status, start, expected }) => {
		const harness = await createGoalHarness([], { retry: { enabled: false } });
		await start(harness);

		await harness.session.prompt("/goal resume");

		expect(harness.session.goalState).toMatchObject({ active: false, status, ...expected });
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["/goal clear", "/goal status"])("runs %s without consuming a provider response", async (command) => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		await harness.session.prompt(command);

		expect(
			conversationMessages(harness.session).map((message) =>
				message.role === "custom" ? message.customType : message.role,
			),
		).toEqual(["session_slash_command", "session_slash_command_result"]);
		expect(harness.eventsOfType("goal_update").at(-1)?.goal.status).toBe("idle");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["/goal --budget=1abc task", "/goal --budget 1.5 task", "/goal --budget 1e6 task"])(
		"rejects malformed goal budget %s",
		async (command) => {
			const harness = await createHarness();
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("unused")]);

			await harness.session.prompt(command);

			expect(harness.session.messages.at(-1)).toMatchObject({
				role: "custom",
				customType: "session_slash_command_result",
				details: { success: false, error: "Goal token budget must be a positive integer." },
			});
			expect(harness.session.goalState).toMatchObject({ active: false, status: "idle" });
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("does not persist a goal when start preflight fails", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await harness.session.prompt("/goal do task");

		expect(harness.session.goalState).toMatchObject({ active: false, status: "idle" });
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "session_slash_command_result",
			details: { success: false },
		});
	});

	it("completes a goal whose completing turn crosses the budget without a stale budget-limit steer", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			assistantWithUsage(
				fauxAssistantMessage(fauxToolCall("ipython", COMPLETE_GOAL_CELL), { stopReason: "toolUse" }),
				{ input: 6, output: 5, totalTokens: 11 },
			),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal --budget 10 finish the task");

		const contextKinds = goalContextMessages(harness).map(
			(message) => (message as { details?: { kind?: string } }).details?.kind,
		);
		expect(contextKinds).not.toContain("budget_limit");
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "complete",
			tokenBudget: 10,
			lastReason: "Goal achieved",
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("checks goal budget before continuation while event processing is delayed", async () => {
		let releaseMessageEnd: (() => void) | undefined;
		const blockedMessageEnd = new Promise<void>((resolve) => {
			releaseMessageEnd = resolve;
		});
		let didBlock = false;
		const extension: ExtensionFactory = (pi) => {
			pi.on("message_end", async (event) => {
				if (event.message.role === "assistant" && !didBlock) {
					didBlock = true;
					await blockedMessageEnd;
				}
			});
		};
		const harness = await createHarness({ extensionFactories: [extension] });
		harnesses.push(harness);
		harness.setResponses([
			assistantWithUsage("Spent the budget.", { input: 6, output: 5, totalTokens: 11 }),
			fauxAssistantMessage("Wrapping up."),
			fauxAssistantMessage("Should not continue."),
		]);

		const promptPromise = harness.session.prompt("/goal --budget 10 do work");
		try {
			await waitForCondition(() => harness.session.goalState.status === "budget_limited");
		} finally {
			releaseMessageEnd?.();
		}
		await promptPromise;
		await harness.session.waitForIdle();
		await vi.waitFor(() => expect(visibleAssistantTexts(harness)).toHaveLength(2));

		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.goalState).toMatchObject({
			active: false,
			status: "budget_limited",
			tokenBudget: 10,
			continuationsUsed: 0,
		});
	});

	it("lets the user abort a goal turn, prompt in between, then resume the goal", async () => {
		const waiting = createWaitingTool();
		const harness = await createGoalHarness([waiting.tool]);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);

		const waitForStart = waiting.waitForStart(harness);
		const promptPromise = harness.session.prompt("/goal complete the long task");
		await waitForStart;
		await harness.session.abort();
		await promptPromise;

		// An aborted provider turn leaves the goal active.
		expect(harness.session.goalState).toMatchObject({ active: true, status: "active" });

		harness.setResponses([fauxAssistantMessage("answered the interjection"), ...completeGoalResponses()]);
		await harness.session.prompt("answer this before continuing the goal");

		expect(visibleAssistantTexts(harness)).toEqual(["answered the interjection", "Goal complete."]);
		expect(harness.session.goalState).toMatchObject({ active: false, status: "complete" });
	});
});

describe("initial goal seeding from config", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/** Reopen the persisted session file with a fresh AgentSession, as a restart does. */
	function createRestartSession(harness: Harness): AgentSession {
		const sessionFile = harness.sessionManager.getSessionFile()!;
		expect(existsSync(sessionFile)).toBe(true);
		const newSessionManager = SessionManager.open(sessionFile);
		const model = harness.getModel();
		const newAuth = AuthStorage.inMemory();
		newAuth.setRuntimeApiKey(model.provider, "faux-key");

		return new AgentSession({
			agent: new Agent({
				getApiKey: () => "faux-key",
				initialState: { model, systemPrompt: "You are a test assistant.", tools: [] },
			}),
			sessionManager: newSessionManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: harness.tempDir,
			modelRegistry: ModelRegistry.inMemory(newAuth),
			resourceLoader: createTestResourceLoader(),
			rlmDepth: 0,
			initialGoal: { objective: "Should not reseed" },
		});
	}

	it("seeds and persists an active goal from initialGoal config on a fresh top-level session", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "Write tests", tokenBudget: 50000 },
		});
		harnesses.push(harness);

		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
			objective: "Write tests",
			tokenBudget: 50000,
		});
		// The goal reaches disk before the first prompt.
		expect(
			harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_CUSTOM_TYPE),
		).toBeDefined();

		// The seeded goal context must reach the model before its first reply.
		harness.setResponses([fauxAssistantMessage("ack")]);
		await harness.session.prompt("hello");
		const messages = harness.session.messages;
		const firstContextIndex = messages.findIndex(
			(message) => message.role === "custom" && message.customType === "goal_context",
		);
		expect(firstContextIndex).toBeGreaterThanOrEqual(0);
		expect(firstContextIndex).toBeLessThan(messages.findIndex((message) => message.role === "assistant"));
		expect(getMessageText(messages[firstContextIndex])).toContain("Write tests");
		expect(currentAgentContext(harness).messages).toContain(messages[firstContextIndex]);
	});

	it("drops the seeded goal context when the goal is cleared before the first prompt", async () => {
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "Write tests", tokenBudget: 50000 },
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("ack")]);
		await harness.session.prompt("/goal clear");
		expect(harness.session.goalState.status).toBe("idle");

		await harness.session.prompt("hello");
		expect(goalContextMessages(harness)).toHaveLength(0);
	});

	it("does not seed initialGoal for subagent sessions (rlmDepth > 0)", async () => {
		const harness = await createHarness({
			persistSession: true,
			rlmDepth: 1,
			initialGoal: { objective: "Subagent goal" },
		});
		harnesses.push(harness);

		expect(harness.session.goalState).toMatchObject({ status: "idle", active: false });
	});

	it.each([
		{
			name: "cleared",
			objective: "Initial goal",
			prepare: async (harness: Harness) => {
				harness.setResponses([fauxAssistantMessage("unused")]);
				await harness.session.prompt("/goal clear");
				expect(harness.session.goalState.status).toBe("idle");
			},
			expected: { status: "idle", objective: undefined },
		},
		{
			name: "completed",
			objective: "Complete me",
			prepare: async (harness: Harness) => {
				harness.session.handleGoalHostRequest("goal.complete");
			},
			expected: { status: "complete", objective: "Complete me" },
		},
		{
			name: "used (the branch already has messages)",
			objective: "Initial goal",
			prepare: async (harness: Harness) => {
				// Append directly so no autonomous goal continuation runs.
				harness.sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "do something" }],
					timestamp: Date.now(),
				});
			},
			expected: { status: "active", objective: "Initial goal" },
		},
	])(
		"does not reseed initialGoal after the goal was $name (idempotent restart)",
		async ({ objective, prepare, expected }) => {
			const harness = await createHarness({ persistSession: true, initialGoal: { objective } });
			harnesses.push(harness);
			expect(harness.session.goalState.status).toBe("active");

			await prepare(harness);
			const restarted = createRestartSession(harness);

			try {
				expect(restarted.goalState.status).toBe(expected.status);
				expect(restarted.goalState.objective).toBe(expected.objective);
			} finally {
				restarted.dispose();
			}
		},
	);
});

describe("goal continuation guard persistence failures", () => {
	it.each(["complete", "tools", "reset"])("retries a failed %s write without losing state", (operation) => {
		const persisted: unknown[] = [];
		let fail = false;
		const guard = new GoalContinuationGuard((state) => {
			if (fail) throw new Error("disk write failed");
			persisted.push({ ...state });
		});
		guard.reset("goal");
		const final = fauxAssistantMessage("final");
		const messages = [
			{
				role: "toolResult" as const,
				toolCallId: "call",
				toolName: "test",
				content: [],
				isError: false,
				timestamp: 1,
			},
		];
		const act = () =>
			operation === "complete"
				? guard.complete("goal", final)
				: operation === "tools"
					? guard.observe(messages)
					: guard.reset("new-goal");
		fail = true;
		expect(act).toThrow("disk write failed");
		fail = false;
		act();
		if (operation === "tools") {
			expect(persisted.at(-1)).toMatchObject({ pendingTools: true });
			guard.complete("goal", final);
		}
		expect(persisted.at(-1)).toMatchObject({
			goalId: operation === "reset" ? "new-goal" : "goal",
			idleCycles: operation === "complete" ? 1 : 0,
		});
		if (operation === "complete") expect(persisted.at(-1)).toHaveProperty("completedCycleId");
	});
});
