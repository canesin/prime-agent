import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { BrandSplashHeader } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type Context = {
	client: { supportsServerCapability: (capability: string) => boolean };
	rows: { summary: Partial<SessionSummary> }[];
	selectedIndex: number;
	options: { uiServices: { getInitialCwd: () => string } };
};

const prototype = AgentsViewMode.prototype as unknown as {
	getSplashCwd(this: Context): string;
	getSplashKernelCwd(this: Context): string | undefined;
};

function context(supportsKernelCwd = true): Context {
	return {
		client: { supportsServerCapability: (capability) => supportsKernelCwd && capability === "kernel_cwd" },
		rows: [{ summary: { activeSessionId: "active", cwd: "/project", kernelCwd: "/project/nested" } }],
		selectedIndex: 0,
		options: { uiServices: { getInitialCwd: () => "/launcher" } },
	};
}

describe("agents view Python directory metadata", () => {
	beforeAll(() => initTheme("dark"));

	it("shows Python's directory separately while keeping the selected project's directory", () => {
		const state = context();
		expect(prototype.getSplashCwd.call(state)).toBe("/project");
		expect(prototype.getSplashKernelCwd.call(state)).toBe("/project/nested");
		const header = new BrandSplashHeader(
			"0.9.3",
			() => "test-model",
			() => prototype.getSplashCwd.call(state),
			undefined,
			{
				getExtraMetadata: () => [
					{ label: "agents", value: "1 running" },
					{ label: "scope", value: "global" },
					{ label: "depth", value: "0" },
					{ label: "cwd (py)", value: prototype.getSplashKernelCwd.call(state)! },
				],
			},
		);
		const output = stripAnsi(header.render(100).join("\n"));
		expect(output).toContain("cwd      /project");
		expect(output).toContain("cwd (py) /project/nested");
		expect(output).toContain("type to search sessions");
	});

	it("degrades locally when an older daemon does not advertise the capability", () => {
		const state = context(false);
		expect(prototype.getSplashKernelCwd.call(state)).toBeUndefined();
		expect(prototype.getSplashCwd.call(state)).toBe("/project");
	});

	it.each([
		{ kernelCwd: undefined },
		{ kernelCwd: "/project" },
		{ activeSessionId: undefined },
		{ lastHeardFromAt: "2026-09-01T00:00:00.000Z" },
		{ workerState: "recovering" },
		{ workerState: "failed" },
	])("omits unavailable, duplicate, or stale Python directory metadata (%j)", (patch) => {
		const state = context();
		Object.assign(state.rows[0]!.summary, patch);
		expect(prototype.getSplashKernelCwd.call(state)).toBeUndefined();
		expect(prototype.getSplashCwd.call(state)).toBe("/project");
	});
});
