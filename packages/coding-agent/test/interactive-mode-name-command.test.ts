import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createDeferred } from "./suite/scheduling.js";

type Context = {
	agentConnection: { setSessionName: (name: string) => Promise<void> };
	chatContainer: Container;
	ui: { requestRender: () => void };
	showError: (message: string) => void;
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { getText: () => string; setText: (text: string) => void };
	handleNameCommand: (text: string) => Promise<void>;
	inputSubmissionsPending: number;
};

const prototype = InteractiveMode.prototype as unknown as {
	setupEditorSubmitHandler(this: Context): void;
	handleNameCommand(this: Context, text: string): Promise<void>;
};

function makeContext(setSessionName: Context["agentConnection"]["setSessionName"]): Context {
	let editorText = "";
	const context = {
		agentConnection: { setSessionName },
		chatContainer: new Container(),
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
		defaultEditor: {},
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
			},
		},
		handleNameCommand: (text: string) => prototype.handleNameCommand.call(context, text),
		submittedInputBehavior: "steer",
		inputSubmissionGeneration: 0,
		inputSubmissionsPending: 0,
		pendingPromptStashReleases: [],
		promptStashState: {},
		clearShortcutGuide: vi.fn(),
	};
	prototype.setupEditorSubmitHandler.call(context);
	return context;
}

function renderChat(context: Context): string {
	return context.chatContainer.children.flatMap((child) => child.render(120)).join("\n");
}

describe("InteractiveMode /name", () => {
	beforeAll(() => initTheme("dark"));

	it("reports a duplicate name without rejecting the submit and accepts a subsequent rename", async () => {
		const conflict = new Error('Session name "taken" is already in use');
		const setSessionName = vi
			.fn<Context["agentConnection"]["setSessionName"]>()
			.mockRejectedValueOnce(conflict)
			.mockResolvedValueOnce(undefined);
		const context = makeContext(setSessionName);

		await expect(context.defaultEditor.onSubmit?.("/name taken")).resolves.toBeUndefined();
		expect(context.showError).toHaveBeenCalledExactlyOnceWith(conflict.message);
		expect(renderChat(context)).not.toContain("Session name set:");
		expect(context.inputSubmissionsPending).toBe(0);

		await context.defaultEditor.onSubmit?.("/name available");
		expect(setSessionName.mock.calls).toEqual([["taken"], ["available"]]);
		expect(renderChat(context)).toContain("Session name set: available");
		expect(context.inputSubmissionsPending).toBe(0);
	});

	it.each([false, true])("preserves input typed while a rename is pending (rejected: %s)", async (rejected) => {
		const pending = createDeferred();
		const context = makeContext(() => pending.promise);
		const submission = context.defaultEditor.onSubmit?.("/name chosen");
		context.editor.setText("new draft");
		if (rejected) pending.reject(new Error("Name already in use"));
		else pending.resolve();

		await expect(submission).resolves.toBeUndefined();
		expect(context.editor.getText()).toBe("new draft");
		expect(context.inputSubmissionsPending).toBe(0);
	});
});
