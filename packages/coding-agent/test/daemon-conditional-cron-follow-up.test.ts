import { mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCronJobStore } from "../src/core/cron-jobs.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand, DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import { summaryForActiveSession } from "../src/modes/daemon/daemon-session-list.js";

describe("daemon conditional cron follow-up", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("routes a fenced non-slash marker to the active-goal follow-up transport", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-conditional-follow-up-"));
		tempDirs.push(tempDir);
		const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
			defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
			createRuntime: vi.fn(),
		});
		const marker = "[cto:peer-dispatch:recovery-3]\nContinue the exact active goal.";
		const startGoalFollowUpFromConditionalPrompt = vi.fn(
			async (_text: string, options: { admissionCommitted(): void; receiptId: string }) => {
				options.admissionCommitted();
			},
		);
		const startGoalFromConditionalPrompt = vi.fn(async () => {
			throw new Error("non-slash follow-up used goal-start transport");
		});
		const model = {
			provider: "openai",
			id: "gpt-5.6",
			name: "test",
			api: "openai-completions",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		} satisfies Model<Api>;
		const lastActivityAt = "2026-09-01T10:00:00.000Z";
		const goalState = {
			active: true,
			status: "active" as const,
			goalId: "goal-1",
			objective: "finish kene",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
			updatedAt: 1,
		};
		const activeSessionId = "active-kene";
		const sessionFile = join(tempDir, "kene.jsonl");
		const state = {
			activeSessionId,
			clients: new Set<DaemonSocketClient>(),
			pendingAttaches: 0,
			lastEventSequence: 0,
			rlmRosterRevision: 0,
			summaryState: { taskState: "needs_input", basedOnMessageCount: 0 },
			runtime: {
				cwd: tempDir,
				diagnostics: [],
				metadata: { kind: "top-level", createdAt: 1 },
				session: {
					sessionId: "session-kene",
					sessionFile,
					sessionName: "kene",
					rlmDepth: 0,
					model,
					thinkingLevel: "xhigh",
					messages: [],
					goalState,
					isStreaming: false,
					isCompacting: false,
					isRetrying: false,
					isBashRunning: false,
					isSessionActive: false,
					unfinishedActionCount: 0,
					state: { pendingToolCalls: new Set(), streamingMessage: undefined },
					sessionManager: {
						getCwd: () => tempDir,
						getHeader: () => ({ timestamp: lastActivityAt }),
					},
					hasRunningRlmChildren: () => false,
					getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
					startGoalFollowUpFromConditionalPrompt,
					startGoalFromConditionalPrompt,
				},
			},
		} as unknown as ActiveSessionState;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			cronStore: AgentCronJobStore;
			cronScheduler: { runDue(now: Date): Promise<number> };
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonOutbound | undefined>;
		};
		internals.sessions.set(activeSessionId, state);
		const baseline = summaryForActiveSession(state);
		const client = {
			id: "client-1",
			socket: { destroyed: false } as Socket,
			attachedActiveSessionIds: new Set([activeSessionId]),
			detachInput: vi.fn(),
			supportsExtensionUi: false,
			capabilities: new Set(),
		} as DaemonSocketClient;

		await internals.handleCommand(client, {
			type: "cron_add",
			activeSessionId,
			schedule: "in 1m",
			prompt: marker,
			deliveryMode: "follow_up",
			deliveryFence: {
				version: 1,
				activeSessionId,
				sessionName: baseline.sessionName!,
				cwd: baseline.cwd,
				model: { provider: baseline.model!.provider, id: baseline.model!.id },
				thinkingLevel: baseline.thinkingLevel!,
				messageCount: baseline.messageCount,
				lastActivityAt: baseline.lastActivityAt!,
				taskState: "needs_input",
				goal: baseline.goal!,
			},
		} as DaemonCommand);
		const job = internals.cronStore.list()[0]!;

		expect(job).toMatchObject({ source: "conditional_cron", deliveryMode: "follow_up" });
		expect(await internals.cronScheduler.runDue(new Date(Date.parse(job.nextRunAt!) + 1))).toBe(1);
		expect(startGoalFollowUpFromConditionalPrompt).toHaveBeenCalledWith(marker, {
			admissionCommitted: expect.any(Function),
			receiptId: job.id,
		});
		expect(startGoalFromConditionalPrompt).not.toHaveBeenCalled();
		expect(internals.cronStore.list()[0]).toMatchObject({ status: "completed", runCount: 1 });
	});

	it("rebuilds a persisted receipt-phase follow-up after daemon interruption", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-conditional-follow-up-recovery-"));
		tempDirs.push(tempDir);
		const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
			defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
			createRuntime: vi.fn(),
		});
		const marker = "[cto:peer-dispatch:recovery-4]\nContinue after restart.";
		const goalState = {
			active: true,
			status: "active" as const,
			goalId: "goal-1",
			objective: "finish kene",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
			followUpDispatchReceiptId: "pending",
			followUpDispatchPhase: "receipt" as const,
		};
		const recoverConditionalGoalFollowUpDelivery = vi.fn(
			(_receiptId: string, _text: string, options: { recoveryCommitted?(): void }) => {
				options.recoveryCommitted?.();
				return true;
			},
		);
		const state = {
			runtime: {
				session: {
					sessionId: "session-kene",
					goalState,
					recoverConditionalGoalFollowUpDelivery,
				},
			},
		} as unknown as ActiveSessionState;
		const internals = daemon as unknown as {
			cronStore: AgentCronJobStore;
			recoverConditionalCronDeliveryForState(state: ActiveSessionState): void;
		};
		const job = internals.cronStore.create({
			activeSessionId: "active-kene",
			sessionId: "session-kene",
			sessionFile: join(tempDir, "kene.jsonl"),
			cwd: tempDir,
			scheduleText: "in 1m",
			prompt: marker,
			deliveryMode: "follow_up",
			deliveryFence: {
				version: 1,
				activeSessionId: "active-kene",
				sessionName: "kene",
				cwd: tempDir,
				model: { provider: "openai", id: "gpt-5.6" },
				thinkingLevel: "xhigh",
				messageCount: 2,
				lastActivityAt: "2026-09-01T10:00:00.000Z",
				taskState: "needs_input",
				goal: { active: true, status: "active", goalId: "goal-1" },
			},
		});
		goalState.followUpDispatchReceiptId = job.id;
		internals.cronStore.rejectDelivery(job.id, "Interrupted before scheduled operation completion");

		internals.recoverConditionalCronDeliveryForState(state);

		expect(recoverConditionalGoalFollowUpDelivery).toHaveBeenCalledWith(job.id, marker, {
			recoveryCommitted: expect.any(Function),
		});
		expect(internals.cronStore.list()[0]).toMatchObject({
			id: job.id,
			status: "cancelled",
			deliveryRecoveryCount: 1,
		});
	});
});
