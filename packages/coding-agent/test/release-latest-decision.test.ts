import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(__dirname, "../../../scripts/release-latest-decision.mjs");

function latestFlag(candidate: string, current = ""): string {
	return execFileSync(process.execPath, [scriptPath, candidate, current], { encoding: "utf8" }).trim();
}

describe("fork release latest decision", () => {
	it.each([
		["0.9.1-cto.1.1", "", "flag=--latest"],
		["0.9.2-cto.1.1", "0.9.1-cto.99.9", "flag=--latest"],
		["0.9.1-cto.7.1", "0.9.1-cto.6.1", "flag=--latest"],
		["0.9.1-cto.6.2", "0.9.1-cto.6.1", "flag=--latest"],
		["0.9.1-cto.5.2", "0.9.1-cto.6.1", "flag=--latest=false"],
		["0.9.1-cto.6.1", "0.9.1-cto.6.1", "flag=--latest=false"],
		["0.9.1-cto.7.1", "not-a-fork-release", "flag=--latest=false"],
	])("compares %s against %s", (candidate, current, expected) => {
		expect(latestFlag(candidate, current)).toBe(expected);
	});

	it("rejects malformed candidate versions", () => {
		const result = spawnSync(process.execPath, [scriptPath, "0.9.1", ""], { encoding: "utf8" });

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Invalid candidate fork release version");
	});
});
