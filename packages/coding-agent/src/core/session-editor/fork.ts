import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseSessionFileContents, type SessionEntry, type SessionHeader, SessionManager } from "../session-manager.js";

/** Reads only the header of a session file, without loading its entries. */
export function readSessionHeader(filePath: string): SessionHeader | undefined {
	return parseSessionFileContents(readFileSync(filePath, "utf8")).header;
}

export interface SessionForkTarget {
	sourcePath: string;
	sourceHeader: SessionHeader;
	/**
	 * Entries the editor starts from: the fork's own entries, not the source's.
	 * The fork writer normalizes and rewrites the transcript (it drops entries
	 * the header now carries, and applies migrations), so saving the source's
	 * entries would undo that.
	 */
	forkEntries: SessionEntry[];
	/** New session file that continues the source, for editing without touching it. */
	forkPath: string;
	forkHeader: SessionHeader;
}

/**
 * Allocates a new session file that continues `sourcePath`, so an editor can
 * rewrite the transcript while the source session keeps running. Uses the same
 * fork path as `--fork` (new id, parent session recorded, current version).
 */
export function createSessionForkTarget(sourcePath: string, cwd: string, sessionDir?: string): SessionForkTarget {
	const source = parseSessionFileContents(readFileSync(sourcePath, "utf8"));
	if (source.header === undefined) {
		throw new Error(`Session file has no header: ${sourcePath}`);
	}
	const fork = SessionManager.forkFrom(sourcePath, cwd, sessionDir ?? dirname(sourcePath));
	const forkPath = fork.getSessionFile();
	if (forkPath === undefined) {
		throw new Error(`Could not allocate a fork of ${sourcePath}`);
	}
	const forkContents = parseSessionFileContents(readFileSync(forkPath, "utf8"));
	if (forkContents.header === undefined) {
		throw new Error(`Forked session has no header: ${forkPath}`);
	}
	return {
		sourcePath,
		sourceHeader: source.header,
		forkEntries: forkContents.entries,
		forkPath,
		forkHeader: forkContents.header,
	};
}
