import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";

describe("conditional cron follow-up persistence", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists follow-up delivery only for a fenced cron job", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-conditional-follow-up-store-"));
		tempDirs.push(tempDir);
		const store = new AgentCronJobStore(join(tempDir, "jobs.json"));
		const job = store.create({
			activeSessionId: "active-1",
			sessionId: "session-1",
			sessionFile: join(tempDir, "session.jsonl"),
			cwd: tempDir,
			scheduleText: "in 1m",
			prompt: "[cto:peer-dispatch:recovery]\nContinue.",
			deliveryMode: "follow_up",
			deliveryFence: {
				version: 1,
				activeSessionId: "active-1",
				sessionName: "kene",
				cwd: tempDir,
				model: { provider: "openai", id: "gpt-5.6" },
				thinkingLevel: "xhigh",
				messageCount: 2,
				lastActivityAt: "2026-09-01T10:00:00.000Z",
				taskState: "needs_input",
				goal: {
					active: true,
					status: "active",
					goalId: "goal-1",
					updatedAt: 1,
					followUpDispatchReceiptId: "prior-follow-up",
					followUpDispatchPhase: "provider_committed",
				},
			},
		});

		expect(job).toMatchObject({
			source: "conditional_cron",
			deliveryMode: "follow_up",
			deliveryFence: {
				goal: {
					followUpDispatchReceiptId: "prior-follow-up",
					followUpDispatchPhase: "provider_committed",
				},
			},
		});
		expect(new AgentCronJobStore(join(tempDir, "jobs.json")).list()).toMatchObject([
			{ id: job.id, source: "conditional_cron", deliveryMode: "follow_up" },
		]);
	});

	it("rejects an oversized follow-up receipt in an external delivery fence", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-conditional-follow-up-store-"));
		tempDirs.push(tempDir);
		const store = new AgentCronJobStore(join(tempDir, "jobs.json"));

		expect(() =>
			store.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "in 1m",
				prompt: "continue",
				deliveryMode: "follow_up",
				deliveryFence: {
					version: 1,
					activeSessionId: "active-1",
					sessionName: "kene",
					cwd: tempDir,
					model: { provider: "openai", id: "gpt-5.6" },
					thinkingLevel: "xhigh",
					messageCount: 2,
					lastActivityAt: "2026-09-01T10:00:00.000Z",
					taskState: "needs_input",
					goal: {
						active: true,
						status: "active",
						goalId: "goal-1",
						followUpDispatchReceiptId: "x".repeat(257),
						followUpDispatchPhase: "receipt",
					},
				},
			}),
		).toThrow("Cron delivery fence goal is invalid");
	});
});
