import { deepEqual } from "../../utils/deep-equal.js";
import { createAssistantMessage, createToolResultMessage, createUserMessage } from "../messages.js";
import { generateEntryId, type SessionEntry, type SessionHeader, serializeSessionFile } from "../session-manager.js";
import {
	describeEntry,
	inferAssistantIdentity,
	parseEntryBlock,
	renderEntryBlock,
	renderSessionDocument,
	type SessionDocumentIssue,
	validateEntries,
} from "./document.js";

/**
 * In-memory session transcript editor.
 *
 * Every mutation keeps the entry chain, ids, timestamps, and dependent
 * references consistent, so a front end (TUI or document editor) never has to
 * hand-edit structure. Entries are replaced, never mutated in place, which
 * keeps undo snapshots cheap: a snapshot is a shallow copy of the entry list.
 */

export interface SessionEditModelInit {
	header: SessionHeader;
	entries: readonly SessionEntry[];
	filePath?: string;
}

export interface NewToolCallDraft {
	id?: string;
	name: string;
	arguments?: Record<string, unknown>;
}

export type NewEntryDraft =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text?: string; reasoning?: string; toolCalls?: NewToolCallDraft[] }
	| { kind: "toolResult"; toolCallId: string; text: string; toolName?: string; isError?: boolean }
	| { kind: "copy"; sourceId: string };

export interface EntryRemovalResult {
	removedIds: string[];
	notices: string[];
}

export interface EntryTextResult {
	entry?: SessionEntry;
	issues: SessionDocumentIssue[];
}

const UNDO_LIMIT = 100;

interface VersionedEntries {
	entries: SessionEntry[];
	version: number;
}

export class SessionEditModel {
	readonly filePath: string | undefined;
	private readonly header: SessionHeader;
	private entries: SessionEntry[];
	private readonly initialEntries: SessionEntry[];
	private undoStack: VersionedEntries[] = [];
	private redoStack: VersionedEntries[] = [];
	private version = 0;
	private savedVersion = 0;

	constructor(init: SessionEditModelInit) {
		this.header = structuredClone(init.header);
		this.entries = init.entries.map((entry) => structuredClone(entry));
		this.initialEntries = this.entries.map((entry) => structuredClone(entry));
		this.filePath = init.filePath;
	}

	get sessionId(): string {
		return this.header.id;
	}

	get sessionHeader(): SessionHeader {
		return this.header;
	}

	get allEntries(): readonly SessionEntry[] {
		return this.entries;
	}

	get length(): number {
		return this.entries.length;
	}

	get dirty(): boolean {
		return this.version !== this.savedVersion;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	markSaved(): void {
		this.savedVersion = this.version;
	}

	entryAt(index: number): SessionEntry | undefined {
		return this.entries[index];
	}

	entry(id: string): SessionEntry | undefined {
		return this.entries.find((entry) => entry.id === id);
	}

	indexOf(id: string): number {
		return this.entries.findIndex((entry) => entry.id === id);
	}

	describe(id: string): string {
		const entry = this.entry(id);
		return entry === undefined ? id : describeEntry(entry);
	}

	/** Replaces one entry with an edited copy; returns whether anything changed. */
	replaceEntry(entry: SessionEntry): boolean {
		const index = this.indexOf(entry.id);
		if (index === -1) return false;
		if (deepEqual(this.entries[index], entry)) return false;
		this.pushUndo();
		this.entries[index] = structuredClone(entry);
		return true;
	}

	/** Edits one entry through a callback that receives a deep clone. */
	updateEntry(id: string, update: (draft: SessionEntry) => SessionEntry | undefined): boolean {
		const index = this.indexOf(id);
		if (index === -1) return false;
		const draft = structuredClone(this.entries[index]!);
		const next = update(draft) ?? draft;
		return this.replaceEntry(next);
	}

	/**
	 * Removes an entry and reparents the chain. Deleting an assistant message
	 * also removes the tool results that answered it, which would otherwise be
	 * orphans; dependent references are retargeted or dropped.
	 */
	removeEntry(id: string, options: { cascade?: boolean } = {}): EntryRemovalResult {
		const index = this.indexOf(id);
		if (index === -1) return { removedIds: [], notices: [] };
		const cascade = options.cascade !== false;
		const target = this.entries[index]!;
		const doomed = new Set<string>([id]);
		if (cascade && target.type === "message" && target.message.role === "assistant") {
			const callIds = new Set(
				target.message.content.filter((block) => block.type === "toolCall").map((block) => block.id),
			);
			if (callIds.size > 0) {
				let cursor = index + 1;
				while (cursor < this.entries.length) {
					const candidate = this.entries[cursor]!;
					if (candidate.type !== "message" || candidate.message.role !== "toolResult") break;
					if (!callIds.has(candidate.message.toolCallId)) break;
					doomed.add(candidate.id);
					cursor++;
				}
			}
		}

		this.pushUndo();
		const removedIds = [...doomed];
		this.entries = this.entries.filter((entry) => !doomed.has(entry.id));
		const notices = this.repairReferences(doomed, index);
		this.relink();
		return { removedIds, notices };
	}

	/** Moves an entry by one position; returns whether it moved. */
	moveEntry(id: string, delta: -1 | 1): boolean {
		const index = this.indexOf(id);
		const target = index + delta;
		if (index === -1 || target < 0 || target >= this.entries.length) return false;
		this.pushUndo();
		const [entry] = this.entries.splice(index, 1);
		this.entries.splice(target, 0, entry!);
		this.relink();
		return true;
	}

	/** Inserts a new entry at `index`; returns the new entry id. */
	insertEntry(index: number, draft: NewEntryDraft): string | undefined {
		const used = new Set(this.entries.map((entry) => entry.id));
		const timestamp = new Date().toISOString();
		const time = Date.parse(timestamp);
		const id = generateEntryId({ has: (candidate) => used.has(candidate) });
		let entry: SessionEntry | undefined;
		if (draft.kind === "copy") {
			const source = this.entry(draft.sourceId);
			if (source === undefined) return undefined;
			entry = structuredClone(source);
			entry.id = id;
			entry.timestamp = timestamp;
			entry.parentId = null;
			if (entry.type === "message") {
				entry.message.timestamp = time;
				// A copied reply must not reuse tool-call ids: providers pair results by
				// id, and duplicates would attach the old result to the wrong copy.
				if (entry.message.role === "assistant") {
					entry.message.content = entry.message.content.map((block) => {
						if (block.type !== "toolCall") return block;
						const fresh = generateEntryId({ has: (candidate) => used.has(candidate) });
						used.add(fresh);
						return { ...block, id: `call_${fresh}` };
					});
				}
			}
		} else if (draft.kind === "user") {
			entry = {
				type: "message",
				id,
				parentId: null,
				timestamp,
				message: createUserMessage([{ type: "text", text: draft.text }], time),
			};
		} else if (draft.kind === "assistant") {
			const identity = inferAssistantIdentity(this.entries.slice(0, Math.max(0, index)));
			if (identity?.api === undefined) return undefined;
			const content: Parameters<typeof createAssistantMessage>[0]["content"] = [];
			if (draft.reasoning !== undefined && draft.reasoning.length > 0) {
				content.push({ type: "thinking", thinking: draft.reasoning });
			}
			if (draft.text !== undefined && draft.text.length > 0) content.push({ type: "text", text: draft.text });
			for (const call of draft.toolCalls ?? []) {
				content.push({
					type: "toolCall",
					id: call.id ?? `call_${generateEntryId({ has: (candidate) => used.has(candidate) })}`,
					name: call.name,
					arguments: call.arguments ?? {},
				});
			}
			entry = {
				type: "message",
				id,
				parentId: null,
				timestamp,
				message: createAssistantMessage({
					content,
					api: identity.api,
					provider: identity.provider,
					model: identity.model,
					stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
					timestamp: time,
				}),
			};
		} else {
			const toolName = draft.toolName ?? this.toolNameForCall(draft.toolCallId) ?? "tool";
			entry = {
				type: "message",
				id,
				parentId: null,
				timestamp,
				message: createToolResultMessage({
					toolCallId: draft.toolCallId,
					toolName,
					content: [{ type: "text", text: draft.text }],
					isError: draft.isError ?? false,
					timestamp: time,
				}),
			};
		}
		const clamped = Math.max(0, Math.min(index, this.entries.length));
		this.pushUndo();
		this.entries.splice(clamped, 0, entry);
		this.relink();
		return id;
	}

	/** Replaces the whole transcript, for a document-level edit; supports undo. */
	replaceAllEntries(entries: readonly SessionEntry[]): void {
		if (deepEqual(this.entries, entries)) return;
		this.pushUndo();
		this.entries = entries.map((entry) => structuredClone(entry));
	}
	duplicateEntry(id: string): string | undefined {
		const index = this.indexOf(id);
		if (index === -1) return undefined;
		return this.insertEntry(index + 1, { kind: "copy", sourceId: id });
	}

	/** All entries with this id or, filtered to one id when given. */
	issues(id?: string): SessionDocumentIssue[] {
		const issues: SessionDocumentIssue[] = [];
		validateEntries(this.entries, issues);
		if (id === undefined) return issues;
		return issues.filter((issue) => issue.entryId === id);
	}

	/** The editable block text for one entry, and how to apply an edited block. */
	entryText(id: string): string | undefined {
		const entry = this.entry(id);
		if (entry === undefined) return undefined;
		// The parser drops exactly one trailing newline, so add exactly one: this
		// keeps a cursor out of the last marker line and round-trips content that
		// itself ends with newlines.
		return `${renderEntryBlock(entry)}\n`;
	}

	applyEntryText(id: string, text: string): EntryTextResult {
		const entry = this.entry(id);
		if (entry === undefined) {
			return { issues: [{ level: "error", message: `unknown entry id ${id}`, entryId: id }] };
		}
		const parsed = parseEntryBlock(text, entry);
		if (parsed.entry === undefined) {
			if (parsed.changed) this.removeEntry(id);
			return { issues: parsed.issues };
		}
		this.replaceEntry(parsed.entry);
		return { entry: parsed.entry, issues: parsed.issues };
	}

	validate(): SessionDocumentIssue[] {
		return this.issues();
	}

	serialize(): string {
		return serializeSessionFile(this.header, this.entries);
	}

	renderDocument(): string {
		return renderSessionDocument({ header: this.header, entries: this.entries, filePath: this.filePath });
	}

	/** Entry counts by change kind, for a save summary. */
	diffSummary(): { edited: number; added: number; removed: number; total: number } {
		const initialById = new Map(this.initialEntries.map((entry) => [entry.id, entry]));
		let edited = 0;
		for (const entry of this.entries) {
			const original = initialById.get(entry.id);
			if (original !== undefined && !deepEqual(original, entry)) edited++;
		}
		return {
			edited,
			added: this.entries.filter((entry) => !initialById.has(entry.id)).length,
			removed: this.initialEntries.filter((entry) => this.indexOf(entry.id) === -1).length,
			total: this.entries.length,
		};
	}

	undo(): boolean {
		const previous = this.undoStack.pop();
		if (previous === undefined) return false;
		this.redoStack.push({ entries: this.entries.slice(), version: this.version });
		this.entries = previous.entries;
		this.version = previous.version;
		return true;
	}

	redo(): boolean {
		const next = this.redoStack.pop();
		if (next === undefined) return false;
		this.undoStack.push({ entries: this.entries, version: this.version });
		this.entries = next.entries;
		this.version = next.version;
		return true;
	}

	private pushUndo(): void {
		// Snapshot the list shallowly: entries are replaced, never mutated, so
		// the snapshot stays stable while later edits write new array slots.
		this.undoStack.push({ entries: this.entries.slice(), version: this.version });
		if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
		this.redoStack = [];
		this.version++;
	}

	/** Chains every entry to its predecessor; first entry has no parent. */
	private relink(): void {
		this.entries = this.entries.map((entry, index) => {
			const parentId = index === 0 ? null : this.entries[index - 1]!.id;
			return entry.parentId === parentId ? entry : { ...entry, parentId };
		});
	}

	/**
	 * Repairs references to entries that were just removed: compactions move the
	 * retained boundary forward, labels and usage attributions for a removed
	 * target are dropped, and other references are reported.
	 */
	private repairReferences(removed: ReadonlySet<string>, removalIndex: number): string[] {
		const notices: string[] = [];
		const drop = new Set<string>();
		this.entries = this.entries.map((entry, index) => {
			if (entry.type === "compaction" && removed.has(entry.firstKeptEntryId)) {
				// The retained boundary must stay before the compaction; otherwise the
				// compaction keeps its dangling id and contributes no retained messages.
				const replacement = this.entries.slice(removalIndex, index).find((candidate) => !removed.has(candidate.id));
				if (replacement === undefined) {
					notices.push(`compaction ${entry.id} lost its retained boundary`);
				} else {
					notices.push(`compaction ${entry.id} now keeps from ${replacement.id}`);
					return { ...entry, firstKeptEntryId: replacement.id };
				}
			}
			if (entry.type === "label" && entry.targetId !== undefined && removed.has(entry.targetId)) {
				notices.push(`dropped label ${entry.id} for a removed entry`);
				drop.add(entry.id);
			}
			if (entry.type === "child_usage_attributed" && removed.has(entry.targetId)) {
				notices.push(`dropped usage attribution ${entry.id} for a removed entry`);
				drop.add(entry.id);
			}
			if (entry.type === "branch_summary" && removed.has(entry.fromId)) {
				notices.push(`branch summary ${entry.id} references a removed entry`);
			}
			return entry;
		});
		if (drop.size > 0) this.entries = this.entries.filter((entry) => !drop.has(entry.id));
		return notices;
	}

	private toolNameForCall(toolCallId: string): string | undefined {
		for (let index = this.entries.length - 1; index >= 0; index--) {
			const entry = this.entries[index]!;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall" && block.id === toolCallId) return block.name;
			}
		}
		return undefined;
	}
}
