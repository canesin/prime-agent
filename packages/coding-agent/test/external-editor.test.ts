import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editTextInExternalEditor, resolveEditorCommand, splitCommandLine } from "../src/utils/external-editor.js";

let directory: string;

function writeEditorScript(name: string, body: string): string {
	const script = join(directory, name);
	writeFileSync(script, body);
	return script;
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "external-editor-test-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("external editor", () => {
	it.each<[string | undefined, NodeJS.ProcessEnv, string | undefined]>([
		["nano", { VISUAL: "vim", EDITOR: "emacs" }, "nano"],
		[undefined, { VISUAL: "vim", EDITOR: "emacs" }, "vim"],
		[undefined, { EDITOR: "emacs" }, "emacs"],
		[undefined, { VISUAL: "  ", EDITOR: "" }, undefined],
		[undefined, {}, undefined],
	])("resolves editor %j", (explicit, env, expected) => {
		expect(resolveEditorCommand(explicit, env)).toBe(expected);
	});

	it.each<[string, string[]]>([
		["vim", ["vim"]],
		["vim -u NONE", ["vim", "-u", "NONE"]],
		['code --wait --user-data-dir "/tmp/my dir"', ["code", "--wait", "--user-data-dir", "/tmp/my dir"]],
		["node -e 'x y'", ["node", "-e", "x y"]],
		["", []],
	])("splits editor command %j", (command, expected) => {
		expect(splitCommandLine(command)).toEqual(expected);
	});

	it("edits text through a spawned editor command", () => {
		const script = writeEditorScript(
			"rewrite.cjs",
			[
				'const { readFileSync, writeFileSync } = require("node:fs");',
				"const file = process.argv[2];",
				'writeFileSync(file, readFileSync(file, "utf8").replace("before", "after"));',
			].join("\n"),
		);
		const result = editTextInExternalEditor({
			contents: "before\n",
			command: `"${process.execPath}" "${script}"`,
		});
		expect(result).toMatchObject({ ran: true, status: 0 });
		expect(result.text).toBe("after\n");
	});

	it("reports no editor when none is configured", () => {
		expect(editTextInExternalEditor({ contents: "x", env: {} })).toEqual({ ran: false, status: null });
	});

	it("returns no text when the editor exits with a failure status", () => {
		const script = writeEditorScript("fail.cjs", "process.exit(3);");
		const result = editTextInExternalEditor({
			contents: "unchanged",
			command: `"${process.execPath}" "${script}"`,
		});
		expect(result.ran).toBe(true);
		expect(result.status).toBe(3);
		expect(result.text).toBeUndefined();
	});

	it("leaves no temp file behind", () => {
		const script = writeEditorScript("touch.cjs", "process.exit(0);");
		editTextInExternalEditor({ contents: "text", command: `"${process.execPath}" "${script}"` });
		expect(readFileSync(script, "utf8")).toBe("process.exit(0);");
	});
});
