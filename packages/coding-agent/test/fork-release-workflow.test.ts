import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
	id?: string;
	name?: string;
	run?: string;
}

interface ForkReleaseWorkflow {
	concurrency: {
		"cancel-in-progress": boolean;
		group: string;
		queue: string;
	};
	jobs: {
		release: {
			if: string;
			steps: WorkflowStep[];
		};
	};
	permissions: Record<string, string>;
}

function loadWorkflow(): ForkReleaseWorkflow {
	const workflowPath = resolve(__dirname, "../../../.github/workflows/fork-release.yml");
	return parse(readFileSync(workflowPath, "utf8")) as ForkReleaseWorkflow;
}

describe("canesin fork release workflow", () => {
	it("serializes every fork-main release without dropping queued runs", () => {
		const workflow = loadWorkflow();

		expect(workflow.concurrency).toEqual({
			"cancel-in-progress": false,
			group: "release-canesin-fork",
			queue: "max",
		});
		expect(workflow.jobs.release.if).toBe("github.repository == 'canesin/prime-agent'");
		expect(workflow.permissions).toEqual({ contents: "write" });
	});

	it("checks immutability and latest precedence before publishing all artifacts", () => {
		const steps = loadWorkflow().jobs.release.steps;
		const latestOutputExpression = ["$", "{{ steps.latest.outputs.flag }}"].join("");
		const immutableIndex = steps.findIndex((step) => step.name === "Require immutable releases");
		const latestIndex = steps.findIndex((step) => step.name === "Select latest release");
		const publishIndex = steps.findIndex((step) => step.name === "Publish fork release");
		const immutableStep = steps[immutableIndex];
		const latestStep = steps[latestIndex];
		const publishStep = steps[publishIndex];

		expect(immutableIndex).toBeGreaterThan(-1);
		expect(latestIndex).toBeGreaterThan(immutableIndex);
		expect(publishIndex).toBeGreaterThan(latestIndex);
		expect(immutableStep?.run).toContain("immutable-releases");
		expect(immutableStep?.run).toContain('if [ "$enabled" != "true" ]');
		expect(latestStep?.id).toBe("latest");
		expect(latestStep?.run).toContain("scripts/release-latest-decision.mjs");
		expect(publishStep?.run).toContain(latestOutputExpression);
		expect(publishStep?.run).toContain("packages/coding-agent/release/fork/artifacts/*");
		expect(publishStep?.run?.split("\n").some((line) => /^--latest(?:\s+\\)?$/.test(line.trim()))).toBe(false);
	});
});
