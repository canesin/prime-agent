import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSessionHeader } from "../src/core/session-editor/fork.js";
import { type SessionEntry, type SessionHeader, serializeSessionFile } from "../src/core/session-manager.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import type { SessionEditorModeOptions } from "../src/modes/session-editor/session-editor-mode.js";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "01a00000-0000-7000-8000-000000000000",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp/fork-edit-command-test",
};

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	const message: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: 1 };
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message };
}

interface HandlerSelf {
	connectionState?: { sessionFile?: string; cwd?: string };
	ui: { stop: () => void; start: () => void; requestRender: () => void };
	fullscreenEnabled: boolean;
	applyFullscreen: (enabled: boolean) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	createSessionEditorMode: (options: SessionEditorModeOptions) => { run: () => Promise<{ writes: number }> };
}

function invokeForkEdit(self: HandlerSelf): Promise<void> {
	const handler = Reflect.get(InteractiveMode.prototype, "handleForkEditCommand") as (
		this: HandlerSelf,
	) => Promise<void>;
	return handler.call(self);
}

let directory: string;
let sessionPath: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "fork-edit-command-"));
	sessionPath = join(directory, "01a00000-0000-7000-8000-000000000000.jsonl");
	writeFileSync(sessionPath, serializeSessionFile(header, [userEntry("aaaa0001", null, "hello")]));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function createSelf(writes: number): {
	self: HandlerSelf;
	statuses: string[];
	errors: string[];
	captured: SessionEditorModeOptions[];
	stops: () => number;
} {
	const statuses: string[] = [];
	const errors: string[] = [];
	const captured: SessionEditorModeOptions[] = [];
	let stopCalls = 0;
	const self: HandlerSelf = {
		connectionState: { sessionFile: sessionPath, cwd: directory },
		ui: {
			stop: () => {
				stopCalls++;
			},
			start: () => undefined,
			requestRender: () => undefined,
		},
		fullscreenEnabled: false,
		applyFullscreen: () => undefined,
		showStatus: (message) => statuses.push(message),
		showError: (message) => errors.push(message),
		createSessionEditorMode: (options) => {
			captured.push(options);
			return { run: async () => ({ writes }) };
		},
	};
	return { self, statuses, errors, captured, stops: () => stopCalls };
}

describe("/fork-edit command", () => {
	it("edits a copy and reports how to resume it", async () => {
		const { self, statuses, errors, captured, stops } = createSelf(1);
		await invokeForkEdit(self);

		expect(errors).toEqual([]);
		expect(captured).toHaveLength(1);
		const options = captured[0]!;
		expect(options.sessionPath).not.toBe(sessionPath);
		expect(options.sessionPath.startsWith(directory)).toBe(true);
		expect(options.model.allEntries.map((entry) => entry.id)).toEqual(["aaaa0001"]);
		expect(existsSync(options.sessionPath)).toBe(true);
		expect(readSessionHeader(options.sessionPath)?.parentSession).toBe(sessionPath);
		expect(stops()).toBe(1);
		expect(statuses.join("\n")).toContain("resume it with /resume");
		expect(statuses.join("\n")).toContain(options.model.sessionId);
		expect(readFileSync(sessionPath, "utf8")).toBe(
			serializeSessionFile(header, [userEntry("aaaa0001", null, "hello")]),
		);
	});

	it("deletes the copy when the editor closes without saving", async () => {
		const { self, statuses, captured } = createSelf(0);
		await invokeForkEdit(self);

		const options = captured[0]!;
		expect(existsSync(options.sessionPath)).toBe(false);
		expect(statuses).toEqual(["Fork edit cancelled; no copy kept"]);
		expect(existsSync(sessionPath)).toBe(true);
	});

	it("reports a session without a saved file", async () => {
		const { self, errors, captured } = createSelf(1);
		self.connectionState = { cwd: directory };
		await invokeForkEdit(self);
		expect(errors).toEqual([expect.stringContaining("not saved to disk")]);
		expect(captured).toEqual([]);
	});

	it("reports a missing source file", async () => {
		const { self, errors, captured } = createSelf(1);
		self.connectionState = { sessionFile: join(directory, "missing.jsonl"), cwd: directory };
		await invokeForkEdit(self);
		expect(errors).toHaveLength(1);
		expect(captured).toEqual([]);
	});
});
