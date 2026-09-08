import { afterEach, describe, expect, it } from "vitest";
import type { HostRequestHandlers } from "../../src/core/kernel/index.js";
import { createHarness, type Harness } from "./harness.js";

describe("RLM historical context", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());
	it("recovers archived messages in bounded pages from the current session", async () => {
		harness = await createHarness();
		const manager = harness.sessionManager;
		const old = manager.appendMessage({ role: "user", content: `needle ${"x".repeat(50000)}`, timestamp: 1 });
		const recent = manager.appendMessage({ role: "user", content: "current task", timestamp: 2 });
		manager.appendCompaction("checkpoint", recent, 20000);
		const handlers = (
			harness.session as unknown as { _createKernelHostHandlers(): HostRequestHandlers }
		)._createKernelHostHandlers();
		expect(handlers["history.search"]).toBeTypeOf("function");
		const results = await handlers["history.search"]({ query: "needle", limit: 2 });
		expect(results).toMatchObject({ entries: [{ id: old, role: "user" }] });
		expect(JSON.stringify(results).length).toBeLessThan(1000);
		const first = (await handlers["history.read"]({ entry_id: old, max_chars: 100 })) as {
			json: string;
			next_offset: number;
		};
		const second = (await handlers["history.read"]({ entry_id: old, offset: first.next_offset, max_chars: 100 })) as {
			json: string;
		};
		expect(first.json + second.json).toBe(JSON.stringify(manager.getEntry(old)).slice(0, 200));
		await expect(handlers["history.read"]({ entry_id: "another-session" })).rejects.toThrow();
		await expect(handlers["history.search"]({ query: "", limit: 10000 })).rejects.toThrow();
	});
});
