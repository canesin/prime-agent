import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * External editor primitives shared by the interactive prompt editor and the
 * session transcript editor.
 */

export interface EditorRunResult {
	status: number | null;
	error?: Error;
}

export interface ExternalEditorOptions {
	contents: string;
	/** Editor command line; falls back to $VISUAL, then $EDITOR. */
	command?: string;
	env?: NodeJS.ProcessEnv;
	/** Temp file suffix, for editor filetype detection. */
	suffix?: string;
}

export interface ExternalEditorResult {
	/** False when no editor is configured, so nothing ran. */
	ran: boolean;
	status: number | null;
	error?: Error;
	/** Edited contents when the editor exited with status 0. */
	text?: string;
}

/** Resolves the editor command from an explicit value, then $VISUAL, then $EDITOR. */
export function resolveEditorCommand(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	for (const candidate of [explicit, env.VISUAL, env.EDITOR]) {
		if (candidate !== undefined && candidate.trim().length > 0) return candidate;
	}
	return undefined;
}

/** Splits a command line into argv, honoring single and double quotes. */
export function splitCommandLine(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (quote !== undefined) {
			if (char === quote) {
				quote = undefined;
			} else if (char === "\\" && quote === '"' && index + 1 < command.length) {
				index++;
				current += command[index]!;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				parts.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current.length > 0) parts.push(current);
	return parts;
}

/** Runs an editor command on a file with inherited stdio. */
export function runEditorCommand(command: string, file: string): EditorRunResult {
	const parts = splitCommandLine(command);
	if (parts.length === 0) throw new Error(`Empty editor command: ${JSON.stringify(command)}`);
	const result = spawnSync(parts[0]!, [...parts.slice(1), file], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	return { status: result.status, error: result.error };
}

/**
 * Writes `contents` to a temp file, opens it in the external editor, and reads
 * it back. The temp file is always removed before returning.
 */
export function editTextInExternalEditor(options: ExternalEditorOptions): ExternalEditorResult {
	const command = resolveEditorCommand(options.command, options.env ?? process.env);
	if (command === undefined) return { ran: false, status: null };
	const file = join(tmpdir(), `pi-editor-${Date.now()}-${randomUUID().slice(0, 8)}${options.suffix ?? ".txt"}`);
	writeFileSync(file, options.contents, "utf8");
	try {
		const result = runEditorCommand(command, file);
		if (result.error !== undefined) return { ran: true, status: result.status, error: result.error };
		if (result.status !== 0) return { ran: true, status: result.status };
		return { ran: true, status: result.status, text: readFileSync(file, "utf8") };
	} finally {
		try {
			unlinkSync(file);
		} catch {
			// The editor already removed it.
		}
	}
}
