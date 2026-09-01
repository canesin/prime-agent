import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoalState } from "../../../src/core/goals.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

interface ConditionalFollowUpSession {
	_setGoalState(goal: GoalState): void;
	startGoalFollowUpFromConditionalPrompt(
		text: string,
		options: { admissionCommitted(): void; receiptId: string; signal?: AbortSignal },
	): Promise<void>;
	recoverConditionalGoalFollowUpDelivery(
		receiptId: string,
		text: string,
		options?: { recoveryCommitted?(): void },
	): boolean;
	failConditionalGoalFollowUpDelivery(receiptId: string): boolean;
}

function activeGoal(overrides: Partial<GoalState> = {}): GoalState {
	const now = Date.now();
	return {
		active: true,
		status: "active",
		goalId: "existing-goal",
		objective: "finish the existing project goal",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		continuationsUsed: 0,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("conditional cron follow-up regression", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("delivers an exact non-slash follow-up to the unchanged active goal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session as unknown as ConditionalFollowUpSession;
		session._setGoalState(activeGoal());
		let releaseResponse = () => {};
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		harness.setResponses([
			async () => {
				await responseGate;
				return fauxAssistantMessage("continued");
			},
		]);
		const marker = "[cto:peer-dispatch:recovery-1]\nContinue the stalled implementation.";
		const admissionCommitted = vi.fn();

		await session.startGoalFollowUpFromConditionalPrompt(marker, {
			receiptId: "conditional-follow-up-1",
			admissionCommitted,
		});
		expect(admissionCommitted).toHaveBeenCalled();
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual([marker]));
		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
			goalId: "existing-goal",
			followUpDispatchReceiptId: "conditional-follow-up-1",
			followUpDispatchPhase: "provider_committed",
		});
		releaseResponse();
	});

	it("persists no receipt when the exact admission fence rejects", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session as unknown as ConditionalFollowUpSession;
		session._setGoalState(activeGoal());
		const fenceChanged = new Error("goal generation changed");

		await expect(
			session.startGoalFollowUpFromConditionalPrompt("continue", {
				receiptId: "conditional-follow-up-rejected",
				admissionCommitted: () => {
					throw fenceChanged;
				},
			}),
		).rejects.toBe(fenceChanged);

		expect(harness.session.goalState).not.toHaveProperty("followUpDispatchReceiptId");
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("rebuilds a receipt-phase follow-up once and never replays a provider-committed receipt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session as unknown as ConditionalFollowUpSession;
		const receiptId = "conditional-follow-up-recovery";
		const marker = "[cto:peer-dispatch:recovery-2]\nResume exact work.";
		session._setGoalState(
			activeGoal({
				followUpDispatchReceiptId: receiptId,
				followUpDispatchPhase: "receipt",
			}),
		);
		harness.setResponses([fauxAssistantMessage("recovered")]);
		const recoveryCommitted = vi.fn();

		expect(session.recoverConditionalGoalFollowUpDelivery(receiptId, marker, { recoveryCommitted })).toBe(true);
		await vi.waitFor(() => expect(getAssistantTexts(harness)).toContain("recovered"));

		expect(recoveryCommitted).toHaveBeenCalledOnce();
		expect(getUserTexts(harness)).toEqual([marker]);
		expect(harness.session.goalState.followUpDispatchPhase).toBe("provider_committed");
		expect(session.recoverConditionalGoalFollowUpDelivery(receiptId, marker)).toBe(false);
	});

	it("terminalizes an exhausted follow-up receipt without terminating the active goal", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session as unknown as ConditionalFollowUpSession;
		const receiptId = "conditional-follow-up-exhausted";
		session._setGoalState(
			activeGoal({
				followUpDispatchReceiptId: receiptId,
				followUpDispatchPhase: "receipt",
			}),
		);

		expect(session.failConditionalGoalFollowUpDelivery(receiptId)).toBe(true);
		expect(harness.session.goalState).toMatchObject({
			active: true,
			status: "active",
			goalId: "existing-goal",
			followUpDispatchReceiptId: receiptId,
			followUpDispatchPhase: "failed",
			lastError: "Conditional goal follow-up recovery exhausted",
		});
		expect(session.failConditionalGoalFollowUpDelivery(receiptId)).toBe(false);
	});
});
