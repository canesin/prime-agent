import { describe, expect, it } from "vitest";
import { type GoalState, isPersistedGoalState, normalizeGoalState } from "../src/core/goals.js";

const activeGoal: GoalState = {
	active: true,
	status: "active",
	goalId: "goal-1",
	objective: "finish the project",
	tokensUsed: 0,
	timeUsedSeconds: 0,
	continuationsUsed: 0,
	createdAt: 1,
	updatedAt: 2,
};

describe("conditional goal follow-up state", () => {
	it("persists a bounded two-phase follow-up receipt", () => {
		const state = normalizeGoalState({
			...activeGoal,
			followUpDispatchReceiptId: "receipt-1",
			followUpDispatchPhase: "receipt",
		});

		expect(isPersistedGoalState(state)).toBe(true);
		expect(state).toMatchObject({
			followUpDispatchReceiptId: "receipt-1",
			followUpDispatchPhase: "receipt",
		});
	});

	it("rejects a follow-up phase without its durable receipt", () => {
		expect(isPersistedGoalState({ ...activeGoal, followUpDispatchPhase: "provider_committed" })).toBe(false);
		expect(
			isPersistedGoalState({
				...activeGoal,
				followUpDispatchReceiptId: "x".repeat(257),
				followUpDispatchPhase: "receipt",
			}),
		).toBe(false);
	});
});
