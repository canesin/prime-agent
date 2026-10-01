import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SessionEditModel } from "../src/core/session-editor/model.js";
import type { SessionEntry, SessionHeader } from "../src/core/session-manager.js";
import { emptyUsage } from "../src/core/usage.js";
import { SessionEditorMode, type SessionEditorModeOptions } from "../src/modes/session-editor/session-editor-mode.js";

const header: SessionHeader = {
	type: "session",
	version: 3,
	id: "01a00000-0000-7000-8000-000000000000",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/tmp/session-editor-mode-test",
};

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
	const message: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: 1 };
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:01.000Z", message };
}

function assistantEntry(id: string, parentId: string | null, content: AssistantMessage["content"]): SessionEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 2,
	};
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:02.000Z", message };
}

function toolResultEntry(id: string, parentId: string | null, toolCallId: string, text: string): SessionEntry {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId,
		toolName: "ipython",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:03.000Z", message };
}

function sampleEntries(): SessionEntry[] {
	return [
		userEntry("aaaa0001", null, "run it"),
		assistantEntry("aaaa0002", "aaaa0001", [
			{ type: "toolCall", id: "call_1", name: "ipython", arguments: { code: "1+1" } },
		]),
		toolResultEntry("aaaa0003", "aaaa0002", "call_1", "2"),
		userEntry("aaaa0004", "aaaa0003", "thanks"),
	];
}

interface FakeUi {
	terminal: { rows: number; columns: number; drainInput: () => Promise<void> };
	requestRender: () => void;
	addChild: () => void;
	setFocus: () => void;
	start: () => void;
	stop: () => void;
	enterFullscreen: () => void;
}

function createFakeUi(rows = 24): FakeUi {
	return {
		terminal: { rows, columns: 100, drainInput: async () => undefined },
		requestRender: () => undefined,
		addChild: () => undefined,
		setFocus: () => undefined,
		start: () => undefined,
		stop: () => undefined,
		enterFullscreen: () => undefined,
	};
}

function createMode(entries: SessionEntry[], overrides: Partial<SessionEditorModeOptions> = {}, rows = 24) {
	const ui = createFakeUi(rows);
	const model = new SessionEditModel({ header, entries, filePath: "/tmp/session.jsonl" });
	const mode = new SessionEditorMode({
		sessionPath: "/tmp/session.jsonl",
		model,
		ui: ui as unknown as TUI,
		keybindings: new KeybindingsManager({}),
		writeSession: () => ({ written: true, backupPath: "/tmp/session.jsonl.bak-test", issues: [] }),
		...overrides,
	});
	return { mode, model, ui };
}

function screen(mode: SessionEditorMode): string {
	return [...mode.render(100), ...mode.dock.render(100)].join("\n");
}

function userText(model: SessionEditModel, id: string): string {
	const entry = model.entry(id);
	if (entry?.type !== "message" || entry.message.role !== "user") throw new Error(`${id} is not a user entry`);
	const content = entry.message.content;
	return typeof content === "string"
		? content
		: content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("session editor mode", () => {
	it("renders the transcript with the selected entry in the detail pane", () => {
		const { mode } = createMode(sampleEntries());
		const view = screen(mode);
		expect(view).toContain("Prime Agent session editor");
		expect(view).toContain("run it");
		expect(view).toContain("1/4");
		mode.handleInput("j");
		expect(screen(mode)).toContain("2/4");
		mode.handleInput("g");
		expect(screen(mode)).toContain("1/4");
	});

	it("edits the selected entry through the editor seam", () => {
		const editText = vi.fn((text: string) => ({
			ran: true,
			status: 0,
			text: text.replace("run it", "run it twice"),
		}));
		const { mode, model } = createMode(sampleEntries(), { editText });
		mode.handleInput("e");
		expect(editText).toHaveBeenCalledTimes(1);
		expect(userText(model, "aaaa0001")).toBe("run it twice");
		expect(model.dirty).toBe(true);
	});

	it("deletes entries with cascade and restores them with undo", () => {
		const { mode, model } = createMode(sampleEntries());
		mode.handleInput("j");
		expect(screen(mode)).toContain("aaaa0002");
		mode.handleInput("d");
		expect(model.allEntries.map((entry) => entry.id)).toEqual(["aaaa0001", "aaaa0004"]);
		expect(screen(mode)).toContain("undo with");
		mode.handleInput("u");
		expect(model.allEntries.map((entry) => entry.id)).toEqual(["aaaa0001", "aaaa0002", "aaaa0003", "aaaa0004"]);
	});

	it("inserts a user message through the editor seam", () => {
		const editText = (text: string) => ({ ran: true, status: 0, text: `${text}hello from the editor\n` });
		// insertEntry seeds an empty user message; the seam supplies the text.
		const { mode, model } = createMode(sampleEntries(), { editText });
		mode.handleInput("o");
		expect(model.length).toBe(5);
		const added = model.allEntries[1]!;
		expect(userText(model, added.id)).toBe("hello from the editor");
		expect(model.allEntries[2]!.parentId).toBe(added.id);
		expect(screen(mode)).toContain("hello from the editor");
	});

	it("discards an inserted entry when the editor leaves it empty", () => {
		const editText = (text: string) => ({ ran: true, status: 0, text });
		const { mode, model } = createMode(sampleEntries(), { editText });
		mode.handleInput("o");
		expect(model.length).toBe(4);
		expect(screen(mode)).toContain("empty entry discarded");
	});

	it("saves through the write seam and clears the dirty state", () => {
		const writeSession = vi.fn(() => ({ written: true, backupPath: "/tmp/session.jsonl.bak-test", issues: [] }));
		const { mode, model } = createMode(sampleEntries(), { writeSession });
		mode.handleInput("d");
		expect(model.dirty).toBe(true);
		mode.handleInput("\x13");
		expect(writeSession).toHaveBeenCalledTimes(1);
		expect(model.dirty).toBe(false);
		expect(screen(mode)).toContain("backup /tmp/session.jsonl.bak-test");
	});

	it("reports a failed save instead of quitting", () => {
		const writeSession = () => ({
			written: false,
			issues: [{ level: "error" as const, message: "session file changed while it was open" }],
		});
		const { mode, model } = createMode(sampleEntries(), { writeSession });
		mode.handleInput("d");
		mode.handleInput("\x13");
		expect(model.dirty).toBe(true);
		expect(screen(mode)).toContain("changed while it was open");
	});

	it("asks before quitting with unsaved changes and cancels on escape", () => {
		const { mode } = createMode(sampleEntries());
		mode.handleInput("d");
		mode.handleInput("q");
		expect(screen(mode)).toContain("Unsaved changes.");
		mode.handleInput("\x1b");
		expect(screen(mode)).not.toContain("Unsaved changes.");
		mode.handleInput("\x03");
		expect(screen(mode)).toContain("Unsaved changes.");
	});

	it("fits the frame to a small terminal", () => {
		const { mode } = createMode(sampleEntries(), {}, 8);
		const lines = mode.render(80);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThanOrEqual(8);
		expect(lines[0]).toContain("Prime Agent session editor");
		expect(lines.some((line) => line.includes("─"))).toBe(true);
	});

	it("shows configurable key hints in the dock", () => {
		const { mode } = createMode(sampleEntries());
		expect(screen(mode)).toContain("Ctrl+S save");
		const custom = createMode(sampleEntries(), {
			keybindings: new KeybindingsManager({ "app.sessionEdit.save": "ctrl+y" }),
		});
		expect(screen(custom.mode)).toContain("Ctrl+Y save");
	});

	it("searches the transcript while typing and jumps to the match", () => {
		const { mode, model } = createMode(sampleEntries());
		mode.handleInput("/");
		for (const char of "THANKS") mode.handleInput(char);
		expect(screen(mode)).toContain("/THANKS");
		mode.handleInput("\r");
		expect(model.entryAt(model.length - 1)?.id).toBe("aaaa0004");
		expect(screen(mode)).toContain('match for "THANKS"');
		mode.handleInput("\x1b");
		expect(screen(mode)).toContain("4/4");
	});

	it("toggles raw JSON details and shows validation issues", () => {
		const dangling = [
			assistantEntry("bbbb0001", null, [{ type: "toolCall", id: "call_x", name: "ipython", arguments: {} }]),
		];
		const { mode } = createMode(dangling);
		expect(screen(mode)).toContain("no tool result");
		mode.handleInput("v");
		expect(screen(mode)).toContain('"role": "assistant"');
		mode.handleInput("?");
		expect(screen(mode)).toContain("select previous entry");
	});
});
