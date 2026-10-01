import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_DOCUMENT_MARKER as M } from "../src/core/session-editor/document.js";
import { editSession, type SessionEditOptions, type SessionEditOutcome } from "../src/core/session-editor/index.js";
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
	cwd: "/tmp/session-editor-flow-test",
};

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	const message: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: 1_700_000_000_000 };
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message };
}

const originalEntries = [userEntry("aaaa0001", null, "first question"), userEntry("aaaa0002", "aaaa0001", "second")];

let directory: string;
let sessionPath: string;
let originalFile: string;

/** Runs the editor with a hermetic environment: no session leases in the test directory. */
function edit(overrides: Partial<SessionEditOptions>): SessionEditOutcome {
	return editSession({ sessionPath, agentDir: directory, env: {}, ...overrides });
}

function editorWriting(transform: (document: string) => string) {
	return (_command: string, file: string) => {
		writeFileSync(file, transform(readFileSync(file, "utf8")));
		return { status: 0 };
	};
}

function rewriteQuestion(document: string, text: string): string {
	return document.replace(`${M} user index=0\nfirst question`, `${M} user index=0\n${text}`);
}

function firstUserText(entries: readonly SessionEntry[]): string {
	const entry = entries[0];
	if (entry?.type !== "message" || entry.message.role !== "user") throw new Error("first entry is not a user message");
	const content = entry.message.content;
	return typeof content === "string"
		? content
		: content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "session-editor-flow-"));
	sessionPath = join(directory, "01a00000.jsonl");
	originalFile = serializeSessionFile(header, originalEntries);
	writeFileSync(sessionPath, originalFile);
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("session edit file flow", () => {
	it("writes edits, keeps a backup, and preserves the header", () => {
		const outcome = edit({
			runEditor: editorWriting((document) => rewriteQuestion(document, "edited question")),
		});
		expect(outcome.written).toBe(true);
		expect(outcome.stats).toEqual({ total: 2, edited: 1, added: 0, removed: 0, unchanged: 1 });
		expect(outcome.backupPath).toBe(`${sessionPath}.bak-${outcome.backupPath!.split(".bak-")[1]}`);
		expect(readFileSync(outcome.backupPath!, "utf8")).toBe(originalFile);
		const written = parseSessionFileContents(readFileSync(sessionPath, "utf8"));
		expect(written.header).toEqual(header);
		expect(firstUserText(written.entries)).toBe("edited question");
		expect(written.entries[1]!.parentId).toBe("aaaa0001");
		expect(readdirSync(directory).sort()).toEqual([
			"01a00000.jsonl",
			`01a00000.jsonl.bak-${outcome.backupPath!.split(".bak-")[1]}`,
		]);
	});

	it("skips the write and the backup when the document is unchanged", () => {
		const outcome = edit({ runEditor: editorWriting((document) => document) });
		expect(outcome.written).toBe(false);
		expect(outcome.changes).toEqual([]);
		expect(outcome.backupPath).toBeUndefined();
		expect(readFileSync(sessionPath, "utf8")).toBe(originalFile);
		expect(readdirSync(directory)).toEqual(["01a00000.jsonl"]);
	});

	it("does not write when the document has errors and keeps it for repair", () => {
		const outcome = edit({
			runEditor: editorWriting((document) => document.replace(`${M} entry aaaa0002 `, `${M} entry zzzz9999 `)),
		});
		expect(outcome.written).toBe(false);
		expect(outcome.issues).toEqual([
			expect.objectContaining({ level: "error", message: expect.stringContaining("unknown entry id zzzz9999") }),
		]);
		expect(outcome.keptDocumentPath).toBeDefined();
		expect(existsSync(outcome.keptDocumentPath!)).toBe(true);
		expect(readFileSync(sessionPath, "utf8")).toBe(originalFile);
	});

	it("writes despite an invalid time attribute when forced", () => {
		const editDocument = (document: string) =>
			rewriteQuestion(document, "edited question").replace(new RegExp(`^${M} entry aaaa0001 .*$`, "m"), (line) =>
				line.replace(/time=\S+/, "time=not-a-time"),
			);
		const blocked = edit({ runEditor: editorWriting(editDocument) });
		expect(blocked.written).toBe(false);
		expect(blocked.issues).toEqual([
			expect.objectContaining({ level: "error", message: expect.stringContaining("invalid time") }),
		]);
		const forced = edit({ runEditor: editorWriting(editDocument), force: true });
		expect(forced.written).toBe(true);
		const written = parseSessionFileContents(readFileSync(sessionPath, "utf8"));
		expect(firstUserText(written.entries)).toBe("edited question");
		expect(written.entries[0]!.timestamp).toBe("2026-01-01T00:00:01.000Z");
	});

	it("applies edits from a document file without an editor", () => {
		const documentPath = join(directory, "edits.txt");
		const preview = edit({ print: true });
		writeFileSync(documentPath, rewriteQuestion(preview.document, "from document"));
		const outcome = edit({
			editorDocumentPath: documentPath,
			runEditor: () => {
				throw new Error("editor must not run");
			},
		});
		expect(outcome.written).toBe(true);
		expect(firstUserText(parseSessionFileContents(readFileSync(sessionPath, "utf8")).entries)).toBe("from document");
	});

	it("does not write when the session file changes during the edit", () => {
		const outcome = edit({
			runEditor: (_command, file) => {
				writeFileSync(
					sessionPath,
					`${originalFile}${JSON.stringify(userEntry("aaaa0003", "aaaa0002", "appended"))}\n`,
				);
				writeFileSync(file, rewriteQuestion(readFileSync(file, "utf8"), "racing edit"));
				return { status: 0 };
			},
		});
		expect(outcome.written).toBe(false);
		expect(outcome.issues).toEqual([
			expect.objectContaining({ level: "error", message: expect.stringContaining("changed while it was open") }),
		]);
		expect(readFileSync(sessionPath, "utf8")).toContain('"appended"');
	});

	it("reports dry-run changes without writing", () => {
		const outcome = edit({
			dryRun: true,
			runEditor: editorWriting((document) => rewriteQuestion(document, "preview only")),
		});
		expect(outcome.written).toBe(false);
		expect(outcome.dryRun).toBe(true);
		expect(outcome.stats.edited).toBe(1);
		expect(readFileSync(sessionPath, "utf8")).toBe(originalFile);
		expect(outcome.backupPath).toBeUndefined();
	});

	it("reports damaged session lines as a warning", () => {
		writeFileSync(sessionPath, `${originalFile}{not json}\n`);
		const outcome = editSession({
			sessionPath,
			agentDir: directory,
			runEditor: editorWriting((document) => document),
		});
		expect(outcome.written).toBe(false);
		expect(outcome.issues).toEqual([
			expect.objectContaining({ level: "warning", message: expect.stringContaining("unreadable line") }),
		]);
	});
});
