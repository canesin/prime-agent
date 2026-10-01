import { chownSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "../../config.js";
import { backupFileSync, realpathIfPresentSync, writeFileAtomicSync } from "../../utils/atomic-file.js";
import { type EditorRunResult, resolveEditorCommand, runEditorCommand } from "../../utils/external-editor.js";
import {
	acquireSessionLease,
	SESSION_LEASES_ENABLED_ENV,
	SessionAlreadyActiveError,
	type SessionLease,
} from "../session-lease.js";
import {
	parseSessionFileContents,
	type SessionEntry,
	type SessionHeader,
	serializeSessionFile,
} from "../session-manager.js";
import {
	hasErrors,
	parseSessionDocument,
	renderSessionDocument,
	type SessionDocumentChange,
	type SessionDocumentIssue,
	type SessionDocumentStats,
	validateEntries,
} from "./document.js";

export interface SessionEditOptions {
	sessionPath: string;
	/** Editor command line. Defaults to $VISUAL, then $EDITOR, then `vim`. */
	editor?: string;
	/** Apply edits from this document instead of opening an editor. */
	editorDocumentPath?: string;
	/** Render the document and return it without opening an editor or writing. */
	print?: boolean;
	/** Parse and validate, but do not write. */
	dryRun?: boolean;
	/** Write even when validation finds errors or the session is active. */
	force?: boolean;
	/** Copy the session file to `<file>.bak-<timestamp>` before writing. Defaults to true. */
	backup?: boolean;
	/** Keep the generated document file after a successful write. */
	keepTemp?: boolean;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	/** Test seam: replaces the editor process. Return status 0 for success. */
	runEditor?: (command: string, file: string) => EditorRunResult;
	/** Called when the document has validation errors; return true to open the editor again. */
	retryOnError?: (documentPath: string, issues: readonly SessionDocumentIssue[]) => boolean;
}

export interface SessionEditOutcome {
	sessionPath: string;
	header: SessionHeader;
	document: string;
	documentPath?: string;
	keptDocumentPath?: string;
	backupPath?: string;
	written: boolean;
	dryRun: boolean;
	stats: SessionDocumentStats;
	changes: SessionDocumentChange[];
	issues: SessionDocumentIssue[];
}

const MAX_VALIDATION_ATTEMPTS = 10;

export interface SessionWriteOptions {
	sessionPath: string;
	header: SessionHeader;
	entries: readonly SessionEntry[];
	/** Write even when validation finds errors or the session is active. */
	force?: boolean;
	/** Copy the session file to `<file>.bak-<timestamp>` before writing. Defaults to true. */
	backup?: boolean;
	/** Reject the write when the file no longer matches this stat. */
	expectedStat?: { size: number; mtimeMs: number };
	/** Caller already holds the session lease, so do not acquire it again. */
	leaseHeld?: boolean;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
}

export interface SessionWriteResult {
	written: boolean;
	backupPath?: string;
	/** Stat of the rewritten file, for a caller that writes again in the same session. */
	stat?: { size: number; mtimeMs: number };
	issues: SessionDocumentIssue[];
}

/**
 * Validates and writes a full session transcript: lease check, optional
 * timestamped backup, then one atomic replace. Shared by the document editor
 * and the interactive transcript editor.
 */
export function writeSessionEntries(options: SessionWriteOptions): SessionWriteResult {
	const env = options.env ?? process.env;
	const agentDir = options.agentDir ?? getAgentDir();
	const sessionPath = resolve(options.sessionPath);
	const issues: SessionDocumentIssue[] = [];
	validateEntries(options.entries, issues);
	if (hasErrors(issues) && options.force !== true) {
		return { written: false, issues };
	}
	if (!existsSync(sessionPath)) {
		throw new Error(`Session file not found: ${sessionPath}`);
	}
	const lease = options.leaseHeld
		? undefined
		: acquireSessionEditLease(sessionPath, agentDir, env, options.force, issues);
	try {
		const currentStat = statSync(sessionPath);
		if (
			options.expectedStat !== undefined &&
			(currentStat.size !== options.expectedStat.size || currentStat.mtimeMs !== options.expectedStat.mtimeMs)
		) {
			issues.push({
				level: "error",
				message: "session file changed while it was open in the editor; nothing was written",
			});
			return { written: false, issues };
		}
		const backupPath = options.backup === false ? undefined : backupFileSync(sessionPath);
		// Write through symlinks and keep ownership, exactly like the session writer.
		const targetPath = realpathIfPresentSync(sessionPath);
		const metadata = { mode: currentStat.mode & 0o777, uid: currentStat.uid, gid: currentStat.gid };
		writeFileAtomicSync(targetPath, serializeSessionFile(options.header, options.entries), {
			mode: metadata.mode,
			fsync: true,
			beforeRename: (tempPath) => {
				try {
					chownSync(tempPath, metadata.uid, metadata.gid);
				} catch {
					// Ownership changes need privileges; the mode bits are already set.
				}
			},
		});
		const writtenStat = statSync(sessionPath);
		return { written: true, backupPath, stat: { size: writtenStat.size, mtimeMs: writtenStat.mtimeMs }, issues };
	} finally {
		lease?.release();
	}
}

/** Editing must honor worker leases even when invoked from an ordinary shell. */
export function acquireSessionEditLease(
	sessionPath: string,
	agentDir: string,
	env: NodeJS.ProcessEnv,
	force: boolean | undefined,
	issues: SessionDocumentIssue[],
): SessionLease | undefined {
	try {
		return acquireSessionLease(sessionPath, agentDir, { ...env, [SESSION_LEASES_ENABLED_ENV]: "1" });
	} catch (error) {
		if (!(error instanceof SessionAlreadyActiveError)) throw error;
		if (!force) {
			throw new Error(
				`Session is active in another agent: ${sessionPath}. Stop it first, or pass --force to edit anyway.`,
			);
		}
		issues.push({ level: "warning", message: "session is active in another agent; editing anyway" });
		return undefined;
	}
}

export function editSession(options: SessionEditOptions): SessionEditOutcome {
	const env = options.env ?? process.env;
	const agentDir = options.agentDir ?? getAgentDir();
	const sessionPath = resolve(options.sessionPath);
	if (!existsSync(sessionPath)) {
		throw new Error(`Session file not found: ${options.sessionPath}`);
	}
	const initialStat = statSync(sessionPath);
	const { header, entries, skippedLines } = parseSessionFileContents(readFileSync(sessionPath, "utf8"));
	if (!header) {
		throw new Error(`Session file has no header: ${sessionPath}`);
	}
	const issues: SessionDocumentIssue[] = [];
	if (skippedLines > 0) {
		issues.push({ level: "warning", message: `${skippedLines} unreadable line(s) in the session file were skipped` });
	}
	if (!isLinear(entries)) {
		issues.push({
			level: "warning",
			message: "session is not a single parent chain; saving rewrites the chain in document order",
		});
	}
	const editor = resolveEditorCommand(options.editor, env) ?? "vim";
	const document = renderSessionDocument({ header, entries, filePath: sessionPath, editorHint: editor });
	const emptyStats: SessionDocumentStats = {
		total: entries.length,
		edited: 0,
		added: 0,
		removed: 0,
		unchanged: entries.length,
	};
	if (options.print) {
		return {
			sessionPath,
			header,
			document,
			written: false,
			dryRun: true,
			stats: emptyStats,
			changes: [],
			issues,
		};
	}

	const lease = acquireSessionEditLease(sessionPath, agentDir, env, options.force, issues);

	let tempDirectory: string | undefined;
	let preserveTemp = false;
	try {
		let documentPath = options.editorDocumentPath;
		if (documentPath === undefined) {
			tempDirectory = mkdtempSync(join(tmpdir(), "prime-agent-session-edit-"));
			documentPath = join(tempDirectory, `${basename(sessionPath, ".jsonl")}.session.txt`);
			writeFileSync(documentPath, document);
		}
		let result: SessionEditOutcome | undefined;
		for (let attempt = 0; attempt < MAX_VALIDATION_ATTEMPTS; attempt++) {
			if (options.editorDocumentPath === undefined) {
				const run = (options.runEditor ?? runEditorCommand)(editor, documentPath);
				if (run.error) {
					throw new Error(`Could not run editor ${JSON.stringify(editor)}: ${run.error.message}`);
				}
				if (run.status !== 0) {
					throw new Error(`Editor ${JSON.stringify(editor)} exited with status ${run.status}`);
				}
			}
			const editedText = readFileSync(documentPath, "utf8");
			const parsed = parseSessionDocument(editedText, entries);
			const allIssues = [...issues, ...parsed.issues];
			if (!hasErrors(parsed.issues) || options.force) {
				const currentStat = statSync(sessionPath);
				const changedOnDisk = currentStat.size !== initialStat.size || currentStat.mtimeMs !== initialStat.mtimeMs;
				if (changedOnDisk) {
					allIssues.push({
						level: "error",
						message: "session file changed while it was open in the editor; nothing was written",
					});
					result = buildOutcome({
						sessionPath,
						header,
						document,
						documentPath,
						parsed,
						issues: allIssues,
						written: false,
						dryRun: options.dryRun === true,
					});
				} else if (options.dryRun) {
					result = buildOutcome({
						sessionPath,
						header,
						document,
						documentPath,
						parsed,
						issues: allIssues,
						written: false,
						dryRun: true,
					});
				} else if (!hasChanges(parsed)) {
					result = buildOutcome({
						sessionPath,
						header,
						document,
						documentPath,
						parsed,
						issues: allIssues,
						written: false,
						dryRun: false,
					});
				} else {
					const write = writeSessionEntries({
						sessionPath,
						header,
						entries: parsed.entries,
						backup: options.backup,
						force: options.force,
						expectedStat: initialStat,
						leaseHeld: true,
						agentDir,
						env,
					});
					allIssues.push(...write.issues);
					result = buildOutcome({
						sessionPath,
						header,
						document,
						documentPath,
						parsed,
						issues: allIssues,
						written: write.written,
						dryRun: false,
					});
					result.backupPath = write.backupPath;
				}
				break;
			}
			if (attempt + 1 >= MAX_VALIDATION_ATTEMPTS || !options.retryOnError?.(documentPath, parsed.issues)) {
				result = buildOutcome({
					sessionPath,
					header,
					document,
					documentPath,
					parsed,
					issues: allIssues,
					written: false,
					dryRun: options.dryRun === true,
				});
				break;
			}
		}
		if (!result) {
			throw new Error("Session edit did not produce a result");
		}
		if (!result.written && hasErrors(result.issues)) {
			result.keptDocumentPath = documentPath;
			preserveTemp = true;
		}
		return result;
	} finally {
		lease?.release();
		if (tempDirectory !== undefined && options.keepTemp !== true && !preserveTemp) {
			rmSync(tempDirectory, { recursive: true, force: true });
		}
	}
}

interface BuildOutcomeInput {
	sessionPath: string;
	header: SessionHeader;
	document: string;
	documentPath: string;
	parsed: ReturnType<typeof parseSessionDocument>;
	issues: SessionDocumentIssue[];
	written: boolean;
	dryRun: boolean;
}

function buildOutcome(input: BuildOutcomeInput): SessionEditOutcome {
	return {
		sessionPath: input.sessionPath,
		header: input.header,
		document: input.document,
		documentPath: input.documentPath,
		written: input.written,
		dryRun: input.dryRun,
		stats: input.parsed.stats,
		changes: input.parsed.changes,
		issues: input.issues,
	};
}

function hasChanges(parsed: ReturnType<typeof parseSessionDocument>): boolean {
	return parsed.stats.edited > 0 || parsed.stats.added > 0 || parsed.stats.removed > 0;
}

function isLinear(entries: readonly SessionEntry[]): boolean {
	return entries.every((entry, index) => (entry.parentId ?? null) === (index === 0 ? null : entries[index - 1]!.id));
}
