import { readFileSync, readSync, statSync } from "node:fs";
import chalk from "chalk";
import { APP_NAME, getAgentDir, getSessionDirEnvOverride } from "../config.js";
import {
	formatChangeSummary,
	formatIssues,
	hasErrors,
	type SessionDocumentIssue,
} from "../core/session-editor/document.js";
import { editSession, type SessionEditOutcome } from "../core/session-editor/index.js";
import { SessionEditModel } from "../core/session-editor/model.js";
import { acquireSessionLease, SessionAlreadyActiveError } from "../core/session-lease.js";
import {
	findMostRecentSessionForCwd,
	getDefaultSessionDir,
	parseSessionFileContents,
} from "../core/session-manager.js";
import { resolveSessionPath, SessionSelectorError, SessionSelectorNotFoundError } from "../core/session-resolver.js";
import { SessionEditorMode } from "../modes/session-editor/session-editor-mode.js";

const SESSION_EDIT_USAGE = `${APP_NAME} session edit [selector] [options]`;

export interface SessionEditCommandOptions {
	selector?: string;
	editor?: string;
	documentPath?: string;
	print: boolean;
	text: boolean;
	dryRun: boolean;
	force: boolean;
	backup: boolean;
	keepTemp: boolean;
	json: boolean;
}

export function parseSessionEditOptions(
	args: string[],
): { options: SessionEditCommandOptions } | { error: string; hint?: string } {
	const options: SessionEditCommandOptions = {
		print: false,
		text: false,
		dryRun: false,
		force: false,
		backup: true,
		keepTemp: false,
		json: false,
	};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--print") {
			options.print = true;
		} else if (arg === "--text") {
			options.text = true;
		} else if (arg === "--dry-run") {
			options.dryRun = true;
		} else if (arg === "--force") {
			options.force = true;
		} else if (arg === "--no-backup") {
			options.backup = false;
		} else if (arg === "--keep-temp") {
			options.keepTemp = true;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--editor" || arg === "--document") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return { error: `${arg} needs a value`, hint: `Usage: ${SESSION_EDIT_USAGE}` };
			}
			index++;
			if (arg === "--editor") options.editor = value;
			else options.documentPath = value;
		} else if (arg.startsWith("--editor=")) {
			options.editor = arg.slice("--editor=".length);
		} else if (arg.startsWith("--document=")) {
			options.documentPath = arg.slice("--document=".length);
		} else if (arg.startsWith("-")) {
			return { error: `Unknown option for session edit: ${arg}`, hint: `Usage: ${SESSION_EDIT_USAGE}` };
		} else if (options.selector === undefined) {
			options.selector = arg;
		} else {
			return { error: `Too many arguments: ${arg}`, hint: `Usage: ${SESSION_EDIT_USAGE}` };
		}
	}
	return { options };
}

export async function runSessionEditCommand(args: string[]): Promise<void> {
	const parsed = parseSessionEditOptions(args);
	if ("error" in parsed) {
		console.error(chalk.red(`Error: ${parsed.error}`));
		if (parsed.hint) console.error(chalk.dim(parsed.hint));
		process.exitCode = 1;
		return;
	}
	const { options } = parsed;
	let sessionPath: string;
	try {
		sessionPath = await resolveSessionEditTarget(options.selector);
	} catch (error) {
		const message = error instanceof SessionSelectorError ? error.message : describeError(error);
		console.error(chalk.red(`Error: ${message}`));
		if (error instanceof SessionSelectorNotFoundError && error.suggestion) {
			console.error(chalk.dim(`Did you mean "${error.suggestion}"?`));
		}
		process.exitCode = 1;
		return;
	}

	const documentMode =
		options.print || options.text || options.editor !== undefined || options.documentPath !== undefined;
	if (!documentMode && process.stdin.isTTY !== true) {
		console.error(chalk.red("Error: session edit needs an interactive terminal."));
		console.error(
			chalk.dim(
				`Use "${APP_NAME} session edit <selector> --print" to write the transcript, or --text to edit it as a document.`,
			),
		);
		process.exitCode = 1;
		return;
	}

	if (documentMode) {
		runDocumentSessionEdit(sessionPath, options);
		return;
	}
	await runInteractiveSessionEdit(sessionPath, options);
}

function runDocumentSessionEdit(sessionPath: string, options: SessionEditCommandOptions): void {
	let outcome: SessionEditOutcome;
	try {
		outcome = editSession({
			sessionPath,
			editor: options.editor,
			editorDocumentPath: options.documentPath,
			print: options.print,
			dryRun: options.dryRun,
			force: options.force,
			backup: options.backup,
			keepTemp: options.keepTemp,
			retryOnError: options.documentPath === undefined ? confirmReedit : undefined,
		});
	} catch (error) {
		console.error(chalk.red(`Error: ${describeError(error)}`));
		process.exitCode = 1;
		return;
	}

	if (options.print) {
		process.stdout.write(outcome.document);
		return;
	}
	if (options.json) {
		const { document: _document, ...rest } = outcome;
		console.log(JSON.stringify(rest, null, 2));
	} else {
		printSessionEditOutcome(outcome);
	}
	if (hasErrors(outcome.issues)) {
		process.exitCode = 1;
	}
}

async function runInteractiveSessionEdit(sessionPath: string, options: SessionEditCommandOptions): Promise<void> {
	const file = readFileSync(sessionPath, "utf8");
	const { header, entries, skippedLines } = parseSessionFileContents(file);
	if (!header) {
		console.error(chalk.red(`Error: session file has no header: ${sessionPath}`));
		process.exitCode = 1;
		return;
	}
	if (options.dryRun) {
		console.error(chalk.red("Error: --dry-run needs a document mode; use --print or --text."));
		process.exitCode = 1;
		return;
	}

	let activeWarning: string | undefined;
	let lease: ReturnType<typeof acquireSessionLease>;
	try {
		lease = acquireSessionLease(sessionPath, getAgentDir(), process.env);
	} catch (error) {
		if (error instanceof SessionAlreadyActiveError) {
			if (!options.force) {
				console.error(chalk.red(`Error: session is active in another agent: ${sessionPath}`));
				console.error(chalk.dim("Stop it first, or pass --force to edit anyway."));
				process.exitCode = 1;
				return;
			}
			activeWarning = "session is active in another agent; editing a copy is safer";
		} else {
			throw error;
		}
	}
	lease?.release();

	const initialStat = statSync(sessionPath);
	const model = new SessionEditModel({ header, entries, filePath: sessionPath });
	const mode = new SessionEditorMode({
		sessionPath,
		model,
		force: options.force,
		backup: options.backup,
		stat: { size: initialStat.size, mtimeMs: initialStat.mtimeMs },
		initialNotice:
			[
				skippedLines > 0 ? `${skippedLines} unreadable line(s) will be dropped when saving` : undefined,
				activeWarning,
			]
				.filter((notice) => notice !== undefined)
				.join(" · ") || undefined,
	});
	const result = await mode.run();
	if (options.json) {
		console.log(JSON.stringify({ sessionPath, ...result }, null, 2));
		return;
	}
	if (result.writes > 0) {
		console.log(`session edit: saved ${model.diffSummary().total} entries`);
		for (const backupPath of result.backups) console.log(`backup ${backupPath}`);
	} else {
		console.log("session edit: closed without saving");
	}
	const issues = model.issues();
	if (issues.length > 0) {
		for (const line of formatIssues(issues).slice(0, 20)) console.log(chalk.yellow(line));
	}
}

export async function resolveSessionEditTarget(selector: string | undefined): Promise<string> {
	if (selector !== undefined) {
		const resolved = await resolveSessionPath(selector, process.cwd());
		return resolved.path;
	}
	const sessionDir = getSessionDirEnvOverride() ?? getDefaultSessionDir(process.cwd());
	const mostRecent = findMostRecentSessionForCwd(sessionDir, process.cwd());
	if (!mostRecent) {
		throw new Error(`No saved session for ${process.cwd()}. Pass a session id, name, or .jsonl path.`);
	}
	return mostRecent;
}

function printSessionEditOutcome(outcome: SessionEditOutcome): void {
	const lines: string[] = [];
	if (outcome.written) {
		lines.push(`session edit: ${formatChangeSummary(outcome.stats)}`);
		lines.push(`wrote ${outcome.sessionPath}`);
	} else if (outcome.dryRun) {
		lines.push(`session edit (dry run): ${formatChangeSummary(outcome.stats)}`);
	} else if (hasErrors(outcome.issues)) {
		lines.push("session edit: not written, the document has errors");
	} else {
		lines.push("session edit: no changes");
	}
	if (outcome.backupPath) lines.push(`backup ${outcome.backupPath}`);
	for (const line of formatIssues(outcome.issues)) {
		lines.push(line.startsWith("warning") ? chalk.yellow(line) : chalk.red(line));
	}
	for (const change of outcome.changes.slice(0, 20)) {
		lines.push(`  ${change.kind.padEnd(7)} ${change.id} ${change.label}`);
	}
	if (outcome.changes.length > 20) {
		lines.push(`  ...and ${outcome.changes.length - 20} more changes`);
	}
	if (outcome.keptDocumentPath) {
		lines.push(`edits kept at ${outcome.keptDocumentPath}`);
		lines.push(
			`fix the document and re-apply with: ${APP_NAME} session edit ${shellQuote(outcome.sessionPath)} --document ${shellQuote(outcome.keptDocumentPath)}`,
		);
	}
	for (const line of lines) console.log(line);
}

function confirmReedit(documentPath: string, issues: readonly SessionDocumentIssue[]): boolean {
	if (!process.stdin.isTTY) return false;
	console.error(chalk.red("The edited document has errors:"));
	for (const line of formatIssues(issues)) {
		console.error(line.startsWith("warning") ? chalk.yellow(line) : chalk.red(line));
	}
	process.stderr.write(`Reopen ${documentPath} for another edit? [Y/n] `);
	const answer = readLineFromStdin();
	return answer === "" || answer.toLowerCase().startsWith("y");
}

function readLineFromStdin(): string {
	const buffer = Buffer.alloc(1024);
	try {
		const bytes = readSync(0, buffer, 0, buffer.length, null);
		return buffer.subarray(0, bytes).toString("utf8").trim();
	} catch {
		return "";
	}
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
