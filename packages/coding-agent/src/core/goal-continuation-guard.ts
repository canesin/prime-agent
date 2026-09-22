import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.js";

export const GOAL_CONTINUATION_GUARD_TYPE = "thread_goal_continuation_guard";

interface GuardState {
	version: 1;
	goalId: string;
	idleCycles: number;
	completedCycleId?: string;
	completedMessageEntryId?: string;
	pendingTools: boolean;
}

function isGuardState(value: unknown): value is GuardState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<GuardState>;
	return (
		state.version === 1 &&
		typeof state.goalId === "string" &&
		Number.isInteger(state.idleCycles) &&
		state.idleCycles! >= 0 &&
		state.idleCycles! <= 3 &&
		typeof state.pendingTools === "boolean" &&
		(state.completedCycleId === undefined || typeof state.completedCycleId === "string") &&
		(state.completedMessageEntryId === undefined || typeof state.completedMessageEntryId === "string")
	);
}

/** A cycle spans tool turns and ends only at a continuation decision. */
export class GoalContinuationGuard {
	private state: GuardState | undefined;
	private cursors = new WeakMap<AgentMessage[], number>();
	private identities = new WeakMap<AssistantMessage, string>();
	private entryIds = new WeakMap<AssistantMessage, string>();

	constructor(private readonly persist: (state: GuardState) => void) {}

	reset(goalId: string): void {
		this.commit({ version: 1, goalId, idleCycles: 0, pendingTools: false });
	}

	restore(branch: SessionEntry[], goalId: string | undefined): void {
		this.state = goalId ? { version: 1, goalId, idleCycles: 0, pendingTools: false } : undefined;
		this.cursors = new WeakMap();
		this.identities = new WeakMap();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (
				entry.type !== "custom" ||
				entry.customType !== GOAL_CONTINUATION_GUARD_TYPE ||
				!isGuardState(entry.data) ||
				entry.data.goalId !== goalId
			)
				continue;
			this.state = { ...entry.data };
			if (this.state.completedCycleId && this.state.completedMessageEntryId) {
				const completed = branch.find((candidate) => candidate.id === this.state?.completedMessageEntryId);
				if (completed?.type === "message" && completed.message.role === "assistant") {
					this.identities.set(completed.message, this.state.completedCycleId);
				}
			}
			return;
		}
	}

	bindMessageEntry(message: AssistantMessage, entryId: string): void {
		this.entryIds.set(message, entryId);
		const identity = this.identities.get(message);
		if (identity && identity === this.state?.completedCycleId && this.state.completedMessageEntryId !== entryId) {
			this.commit({ ...this.state, completedMessageEntryId: entryId });
		}
	}

	observe(messages: AgentMessage[] | undefined): void {
		// Callers may supply a partial context (cast in callers/tests) without newMessages.
		if (!messages) return;
		const cursor = this.cursors.get(messages) ?? 0;
		if (
			this.state &&
			!this.state.pendingTools &&
			messages.slice(cursor).some((message) => message.role === "toolResult")
		) {
			this.commit({ ...this.state, pendingTools: true });
		}
		this.cursors.set(messages, messages.length);
	}

	private commit(state: GuardState): void {
		this.persist(state);
		this.state = state;
	}

	complete(goalId: string, message: AssistantMessage): boolean {
		if (this.state?.goalId !== goalId) this.reset(goalId);
		const state = this.state!;
		let identity = this.identities.get(message);
		if (!identity) {
			identity = randomUUID();
			this.identities.set(message, identity);
		}
		if (state.completedCycleId !== identity) {
			this.commit({
				...state,
				idleCycles: state.pendingTools ? 0 : Math.min(3, state.idleCycles + 1),
				completedCycleId: identity,
				completedMessageEntryId: this.entryIds.get(message),
				pendingTools: false,
			});
		}
		return this.state!.idleCycles >= 3;
	}
}
