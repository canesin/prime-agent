import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionForkTarget } from "../src/core/session-editor/fork.js";
import { deleteSessionFile } from "../src/core/session-file-actions.js";
import {
	parseSessionFileContents,
	type SessionEntry,
	type SessionHeader,
	serializeSessionFile,
} from "../src/core/session-manager.js";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "01a00000-0000-7000-8000-000000000000",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp/session-fork-test",
};

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	const message: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: 1 };
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message };
}

let directory: string;
let sourcePath: string;
const entries = [userEntry("aaaa0001", null, "first"), userEntry("aaaa0002", "aaaa0001", "second")];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "session-fork-edit-"));
	sourcePath = join(directory, "01a00000-0000-7000-8000-000000000000.jsonl");
	writeFileSync(sourcePath, serializeSessionFile(header, entries));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("session fork edit target", () => {
	it("allocates a new session file that continues the source and copies its entries", () => {
		const target = createSessionForkTarget(sourcePath, "/tmp/project", directory);

		expect(target.sourceHeader).toEqual(header);
		expect(target.sourceEntries).toEqual(entries);
		expect(target.forkPath).not.toBe(sourcePath);
		expect(existsSync(target.forkPath)).toBe(true);
		expect(target.forkHeader.id).not.toBe(header.id);
		expect(target.forkHeader.parentSession).toBe(sourcePath);
		expect(target.forkHeader.cwd).toBe("/tmp/project");
		expect(parseSessionFileContents(readFileSync(target.forkPath, "utf8")).entries).toEqual(entries);
		expect(readFileSync(sourcePath, "utf8")).toBe(serializeSessionFile(header, entries));
	});

	it("does not overwrite an existing fork file", () => {
		const first = createSessionForkTarget(sourcePath, "/tmp/project", directory);
		const second = createSessionForkTarget(sourcePath, "/tmp/project", directory);
		expect(second.forkPath).not.toBe(first.forkPath);
		expect(existsSync(first.forkPath)).toBe(true);
		expect(existsSync(second.forkPath)).toBe(true);
	});

	it("rejects a source file without a session header", () => {
		const broken = join(directory, "broken.jsonl");
		writeFileSync(broken, '{"type":"message","id":"aaaa0001","message":{}}\n');
		expect(() => createSessionForkTarget(broken, "/tmp/project", directory)).toThrow(/no header/i);
	});

	it("removes an unused fork without touching the source", async () => {
		const target = createSessionForkTarget(sourcePath, "/tmp/project", directory);
		const result = await deleteSessionFile(target.forkPath);
		expect(result.ok).toBe(true);
		expect(existsSync(target.forkPath)).toBe(false);
		expect(existsSync(sourcePath)).toBe(true);
	});
});
