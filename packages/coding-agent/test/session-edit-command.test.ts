import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSessionEditOptions, runSessionEditCommand } from "../src/cli/session-edit-command.js";
import { type SessionEntry, type SessionHeader, serializeSessionFile } from "../src/core/session-manager.js";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "01a00000-0000-7000-8000-000000000000",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp/session-edit-command-test",
};

const entry: SessionEntry = {
	type: "message",
	id: "aaaa0001",
	parentId: null,
	timestamp: "2026-01-01T00:00:01.000Z",
	message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1_700_000_000_000 },
};

let directory: string;
let sessionPath: string;
let originalFile: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "session-edit-command-"));
	sessionPath = join(directory, "01a00000.jsonl");
	originalFile = serializeSessionFile(header, [entry]);
	writeFileSync(sessionPath, originalFile);
	process.exitCode = undefined;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	process.exitCode = undefined;
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

describe("session edit command", () => {
	it.each<[string[], Record<string, unknown>]>([
		[[], { print: false, dryRun: false, force: false, backup: true, keepTemp: false, json: false }],
		[["01a0f899"], { selector: "01a0f899" }],
		[["--editor", "vim -u NONE"], { editor: "vim -u NONE" }],
		[["--editor=vim -u NONE"], { editor: "vim -u NONE" }],
		[["--document", "edits.txt"], { documentPath: "edits.txt" }],
		[["--document=edits.txt"], { documentPath: "edits.txt" }],
		[["--text"], { text: true }],
		[
			["01a0f899", "--print", "--dry-run", "--force", "--no-backup", "--keep-temp", "--json"],
			{ selector: "01a0f899", print: true, dryRun: true, force: true, backup: false, keepTemp: true, json: true },
		],
	])("parses %j", (args, expected) => {
		const parsed = parseSessionEditOptions(args);
		expect(parsed).toMatchObject({ options: expect.objectContaining(expected) });
	});

	it.each<[string[], string]>([
		[["--nope"], "Unknown option"],
		[["one", "two"], "Too many arguments"],
		[["--editor"], "--editor needs a value"],
		[["--document", "--print"], "--document needs a value"],
	])("rejects %j", (args, message) => {
		const parsed = parseSessionEditOptions(args);
		expect(parsed).toEqual({
			error: expect.stringContaining(message),
			hint: expect.stringContaining("session edit"),
		});
	});

	it("prints the editable document without writing", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		await runSessionEditCommand([sessionPath, "--print"]);
		const printed = write.mock.calls.map((call) => String(call[0])).join("");
		expect(printed).toContain("# prime-agent session editor");
		expect(printed).toContain("@@@@ entry aaaa0001");
		expect(printed).toContain("hello");
		expect(readFileSync(sessionPath, "utf8")).toBe(originalFile);
		expect(process.exitCode).toBeUndefined();
	});

	it("reports unknown options, missing sessions, and missing terminals as failures", async () => {
		await runSessionEditCommand(["--nope"]);
		expect(process.exitCode).toBe(1);
		await runSessionEditCommand([join(directory, "missing.jsonl"), "--text"]);
		expect(process.exitCode).toBe(1);
		expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("Session file not found");
		await runSessionEditCommand([sessionPath]);
		expect(process.exitCode).toBe(1);
		expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain("interactive terminal");
	});
});
