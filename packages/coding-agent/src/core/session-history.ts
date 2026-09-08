import type { HostRequestHandlers } from "./kernel/index.js";
import type { SessionEntry, SessionManager } from "./session-manager.js";

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return value;
}

function metadata(entry: SessionEntry) {
	return {
		id: entry.id,
		parent_id: entry.parentId,
		timestamp: entry.timestamp,
		type: entry.type,
		role: entry.type === "message" ? entry.message.role : entry.type === "custom_message" ? "custom" : entry.type,
		...(entry.type === "custom_message" ? { custom_type: entry.customType } : {}),
	};
}

/** The kernel reads the full current branch, including entries hidden by compaction. */
export function createSessionHistoryHandlers(manager: SessionManager): HostRequestHandlers {
	return {
		"history.search": async ({ query = "", limit, before }) => {
			if (typeof query !== "string") throw new Error("query must be a string");
			const count = integer(limit, 20, 1, 50, "limit");
			const branch = manager.getBranch();
			let end = branch.length;
			if (before !== undefined) {
				end = branch.findIndex((entry) => entry.id === before);
				if (end < 0) throw new Error("before must identify an entry in this session branch");
			}
			const entries = [];
			for (let i = end - 1; i >= 0; i--) {
				const entry = branch[i];
				if (!["message", "custom_message", "branch_summary", "compaction"].includes(entry.type)) continue;
				const json = JSON.stringify(entry);
				const match = json.toLowerCase().indexOf(query.toLowerCase());
				if (match < 0) continue;
				const offset = Math.max(0, match - 80);
				entries.push({ ...metadata(entry), excerpt: json.slice(offset, offset + 400) });
				if (entries.length === count) break;
			}
			return { entries, next_before: entries.length === count ? entries.at(-1)!.id : null };
		},
		"history.read": async ({ entry_id, offset, max_chars }) => {
			if (typeof entry_id !== "string") throw new Error("entry_id must be a string");
			const start = integer(offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
			const count = integer(max_chars, 4000, 1, 16000, "max_chars");
			const entry = manager.getBranch().find((entry) => entry.id === entry_id);
			if (!entry) throw new Error("Entry was not found in this session branch");
			// Escaped surrogate pairs survive page cuts and reconstruction in Python.
			const json = JSON.stringify(entry).replace(
				/[\ud800-\udfff]/g,
				(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
			);
			return {
				...metadata(entry),
				json: json.slice(start, start + count),
				total_chars: json.length,
				next_offset: start + count < json.length ? start + count : null,
			};
		},
	};
}
