import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	ImageContent,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	UserMessage,
} from "@earendil-works/pi-ai";
import { deepEqual } from "../../utils/deep-equal.js";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createAssistantMessage,
	createToolResultMessage,
	createUserMessage,
} from "../messages.js";
import {
	type CustomMessageEntry,
	generateEntryId,
	type SessionEntry,
	type SessionHeader,
	type SessionMessageEntry,
} from "../session-manager.js";

/**
 * Text document format for `prime-agent session edit`.
 *
 * The document is a lossless, line-oriented view of a session JSONL file. Every
 * block maps to one session entry; every section inside a block maps to one
 * piece of that entry. Parsing rebuilds entries in document order and re-chains
 * `parentId` from the block order, so deleting or moving a block edits the
 * message flow the model will see.
 */

export const SESSION_DOCUMENT_MARKER = "@@@@";

const BASE_ENTRY_KEYS = new Set(["id", "parentId", "type", "timestamp"]);
const BASE_MESSAGE_KEYS = new Set(["role", "timestamp"]);
const CONTENT_SECTIONS = new Set([
	"user",
	"assistant",
	"reasoning",
	"tool_call",
	"tool_result",
	"summary",
	"custom",
	"command",
	"output",
]);
const ALL_SECTIONS = new Set([...CONTENT_SECTIONS, "image", "keep", "json"]);
const NEW_ROLES = new Set(["user", "assistant", "toolResult"]);
const STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);
/** Section boundary written after the last block; it keeps the final body line
 *  independent of the file's trailing newline, which editors may normalize. */
const END_SECTION = "end";

export interface SessionDocumentIssue {
	level: "error" | "warning";
	message: string;
	entryId?: string;
}

export interface SessionDocumentStats {
	total: number;
	edited: number;
	added: number;
	removed: number;
	unchanged: number;
}

export interface SessionDocumentChange {
	kind: "edited" | "added" | "removed";
	id: string;
	label: string;
}

export interface ParsedSessionDocument {
	entries: SessionEntry[];
	issues: SessionDocumentIssue[];
	stats: SessionDocumentStats;
	changes: SessionDocumentChange[];
}

export interface RenderSessionDocumentOptions {
	header: SessionHeader;
	entries: readonly SessionEntry[];
	filePath?: string;
	editorHint?: string;
}

export function renderSessionDocument(options: RenderSessionDocumentOptions): string {
	const lines = renderDocumentPreamble(options);
	for (const entry of options.entries) {
		lines.push(...renderEntry(entry));
	}
	lines.push(`${SESSION_DOCUMENT_MARKER} ${END_SECTION}`);
	return `${lines.join("\n")}\n`;
}

function renderDocumentPreamble(options: RenderSessionDocumentOptions): string[] {
	const { header, entries } = options;
	const lines = ["# prime-agent session editor", "#", `# session   ${header.id}`];
	if (options.filePath) {
		lines.push(`# file      ${options.filePath}`);
	}
	lines.push(
		`# cwd       ${header.cwd}`,
		`# created   ${header.timestamp}`,
		`# entries   ${entries.length}`,
		"#",
		"# Edit the blocks below, then save and quit. Nothing is written until the",
		"# document parses and passes validation. A backup of the session file is",
		"# written next to it before the first change.",
		"#",
		"# Blocks:",
		"#   @@@@ entry <id> type=<type> [key=value ...]",
		"#       Existing entry. Delete the whole block to remove the entry. Move",
		"#       blocks to reorder the message flow. The parent chain is rebuilt from",
		"#       the block order.",
		"#   @@@@ new user | new assistant | new toolResult call=<id> [name=<tool>]",
		"#       New entry inserted at this position with a fresh id and timestamp.",
		"#",
		"# Sections inside a block. A section body runs until the next @@@@ line:",
		"#   @@@@ user                          user text",
		"#   @@@@ assistant                     assistant text",
		"#   @@@@ reasoning                     model reasoning (thinking)",
		"#   @@@@ tool_call id=<id> name=<tool> tool call arguments as JSON",
		"#   @@@@ tool_result                   tool output text",
		"#   @@@@ summary                       compaction or branch summary text",
		"#   @@@@ custom                        custom message text",
		"#   @@@@ image index=<n> mimeType=<m>  image kept as-is (delete to drop it)",
		"#   @@@@ keep index=<n> type=<t>       opaque block kept as-is",
		"#   @@@@ json                          remaining entry fields, as JSON",
		"#",
		"# A content line that starts with @@@@ is escaped with one leading backslash",
		"# (\\@@@@). Keep the backslash when you edit that line.",
		"#",
		`# Templates (copy into the document):`,
		"#   @@@@ new user",
		"#   @@@@ user",
		"#   <text>",
		"#   @@@@ new assistant",
		"#   @@@@ assistant",
		"#   <text>",
		"#   @@@@ new toolResult call=<toolCallId> name=<tool>",
		"#   @@@@ tool_result",
		"#   <text>",
	);
	if (options.editorHint) {
		lines.push("#", `# editor    ${options.editorHint}`);
	}
	lines.push("#");
	return lines;
}

function renderEntry(entry: SessionEntry): string[] {
	return [entryHeaderLine(entry), ...renderEntrySections(entry)];
}

/** Renders one entry as a standalone editable block: header line plus sections. */
export function renderEntryBlock(entry: SessionEntry): string {
	return renderEntry(entry).join("\n");
}

export interface ParsedEntryBlock {
	entry?: SessionEntry;
	changed: boolean;
	issues: SessionDocumentIssue[];
}

/** Parses a block from {@link renderEntryBlock} against the entry it edits. */
export function parseEntryBlock(text: string, original: SessionEntry): ParsedEntryBlock {
	const { blocks, issues } = splitDocument(text);
	const block = blocks[0];
	if (block === undefined || block.marker.name !== "entry") {
		issues.push({ level: "error", message: "document does not start with an entry block" });
		return { changed: false, issues };
	}
	if (blocks.length > 1) {
		issues.push({ level: "error", message: "only one entry block is allowed" });
		return { changed: false, issues };
	}
	const result = applyExistingEntry(original, block, issues);
	return { entry: result.entry, changed: result.changed, issues };
}

function entryHeaderLine(entry: SessionEntry): string {
	const attrs: Array<[string, string]> = [
		["type", entry.type],
		["time", entry.timestamp],
	];
	if (entry.type === "message") {
		const message = entry.message as unknown as Record<string, unknown> | undefined;
		if (isRecord(message) && typeof message.role === "string") {
			attrs.push(["role", message.role]);
			if (message.role === "assistant") {
				attrs.push(
					["provider", String(message.provider ?? "")],
					["model", String(message.model ?? "")],
					["stop", String(message.stopReason ?? "stop")],
				);
			} else if (message.role === "toolResult") {
				attrs.push(
					["name", String(message.toolName ?? "")],
					["call", String(message.toolCallId ?? "")],
					["error", String(message.isError ?? false)],
				);
			} else if (message.role === "custom") {
				attrs.push(["customType", String(message.customType ?? "")], ["display", String(message.display ?? false)]);
			}
		}
	} else if (entry.type === "custom_message") {
		attrs.push(["customType", entry.customType], ["display", String(entry.display)]);
	}
	const rendered = attrs.map(([key, value]) => formatAttribute(key, value)).join(" ");
	return `${SESSION_DOCUMENT_MARKER} entry ${entry.id} ${rendered}`;
}

function renderEntrySections(entry: SessionEntry): string[] {
	if (entryShapeIssues(entry).length > 0) return renderJsonSection(payloadWithout(entry, []));
	if (entry.type === "message") {
		return renderMessageSections(entry.message);
	}
	if (entry.type === "custom_message") {
		return isContent(entry.content)
			? [
					...renderContentSections("custom", entry.content),
					...renderJsonSection(payloadWithout(entry, ["content", "customType", "display"])),
				]
			: renderJsonSection(payloadWithout(entry, []));
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		if (typeof entry.summary !== "string") return renderJsonSection(payloadWithout(entry, []));
		return [...renderTextSection("summary", entry.summary), ...renderJsonSection(payloadWithout(entry, ["summary"]))];
	}
	return renderJsonSection(payloadWithout(entry, []));
}

function renderMessageSections(message: AgentMessage): string[] {
	if (!isRecord(message) || typeof message.role !== "string") {
		return renderJsonSection(isRecord(message) ? { ...message } : { message });
	}
	switch (message.role) {
		case "user":
			return isContent(message.content)
				? renderContentSections("user", message.content)
				: renderJsonSection(payloadWithoutMessage(message, []));
		case "assistant":
			return Array.isArray(message.content)
				? renderAssistantSections(message)
				: renderJsonSection(payloadWithoutMessage(message, []));
		case "toolResult":
			return isContent(message.content)
				? renderContentSections("tool_result", message.content)
				: renderJsonSection(payloadWithoutMessage(message, []));
		case "custom":
			return isContent(message.content)
				? renderContentSections("custom", message.content)
				: renderJsonSection(payloadWithoutMessage(message, []));
		case "bashExecution":
			if (typeof message.command !== "string" || typeof message.output !== "string") {
				return renderJsonSection(payloadWithoutMessage(message, []));
			}
			return [
				...renderTextSection("command", message.command),
				...renderTextSection("output", message.output),
				...renderJsonSection(payloadWithoutMessage(message, ["command", "output"])),
			];
		case "branchSummary":
		case "compactionSummary":
			return [
				...renderTextSection("summary", message.summary),
				...renderJsonSection(payloadWithoutMessage(message, ["summary"])),
			];
		default:
			return renderJsonSection(payloadWithoutMessage(message, []));
	}
}

function renderAssistantSections(message: AssistantMessage): string[] {
	const lines: string[] = [];
	message.content.forEach((block, index) => {
		if (block.type === "text") {
			lines.push(...renderTextSection("assistant", block.text, { index }));
		} else if (block.type === "thinking") {
			if (block.redacted || block.thinking.length === 0) {
				lines.push(...renderMarkerSection("keep", { index, type: "thinking" }));
			} else {
				lines.push(...renderTextSection("reasoning", block.thinking, { index }));
			}
		} else if (block.type === "toolCall") {
			lines.push(
				...renderTextSection("tool_call", renderToolArguments(block.arguments), {
					index,
					id: block.id,
					name: block.name,
				}),
			);
		} else {
			lines.push(...renderMarkerSection("keep", { index, type: blockTypeOf(block) }));
		}
	});
	return lines;
}

function renderContentSections(name: string, content: string | readonly (TextContent | ImageContent)[]): string[] {
	if (typeof content === "string") {
		return renderTextSection(name, content);
	}
	const lines: string[] = [];
	content.forEach((block, index) => {
		if (block.type === "text") {
			lines.push(...renderTextSection(name, block.text, { index }));
		} else if (block.type === "image") {
			lines.push(...renderMarkerSection("image", { index, mimeType: block.mimeType }));
		} else {
			lines.push(...renderMarkerSection("keep", { index, type: blockTypeOf(block) }));
		}
	});
	return lines;
}

function renderTextSection(name: string, text: string, attrs: Record<string, string | number> = {}): string[] {
	return [...renderMarkerSection(name, attrs), ...renderContentLines(text)];
}

function renderMarkerSection(name: string, attrs: Record<string, string | number>): string[] {
	const rendered = Object.entries(attrs)
		.map(([key, value]) => ` ${formatAttribute(key, String(value))}`)
		.join("");
	return [`${SESSION_DOCUMENT_MARKER} ${name}${rendered}`];
}

function renderToolArguments(value: unknown): string {
	if (value === undefined) return "null";
	try {
		return JSON.stringify(value, null, 2) ?? "null";
	} catch {
		return "null";
	}
}

function renderContentLines(text: string): string[] {
	if (text.length === 0) return [];
	return text.split("\n").map(escapeDocumentLine);
}

function renderJsonSection(payload: Record<string, unknown>): string[] {
	if (Object.keys(payload).length === 0) return [];
	return renderTextSection("json", JSON.stringify(payload, null, 2));
}

export function escapeDocumentLine(line: string): string {
	return /^\\*@@@@/.test(line) ? `\\${line}` : line;
}

export function unescapeDocumentLine(line: string): string {
	return /^\\+@@@@/.test(line) ? line.slice(1) : line;
}

function formatAttribute(key: string, value: string): string {
	const safe = value.length > 0 && /^[A-Za-z0-9_./:@+-]+$/.test(value);
	return `${key}=${safe ? value : JSON.stringify(value)}`;
}

function blockTypeOf(block: unknown): string {
	return isRecord(block) && typeof block.type === "string" ? block.type : "unknown";
}

function payloadWithout(entry: SessionEntry, excluded: readonly string[]): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (BASE_ENTRY_KEYS.has(key) || excluded.includes(key) || value === undefined) continue;
		payload[key] = value;
	}
	return payload;
}

function payloadWithoutMessage(message: AgentMessage, excluded: readonly string[]): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(message)) {
		if (BASE_MESSAGE_KEYS.has(key) || excluded.includes(key) || value === undefined) continue;
		payload[key] = value;
	}
	return payload;
}

interface Marker {
	name: string;
	positional: string[];
	attrs: Record<string, string>;
}

interface RawSection {
	marker: Marker;
	lines: string[];
	lineNumber: number;
}

interface RawBlock {
	marker: Marker;
	sections: RawSection[];
	lineNumber: number;
}

function parseMarker(line: string): Marker | undefined {
	const tokens = tokenizeMarker(line.slice(SESSION_DOCUMENT_MARKER.length + 1));
	if (tokens.length === 0) return undefined;
	const positional: string[] = [];
	const attrs: Record<string, string> = {};
	for (const token of tokens.slice(1)) {
		const equals = token.indexOf("=");
		if (equals <= 0) {
			positional.push(token);
			continue;
		}
		attrs[token.slice(0, equals)] = parseAttributeValue(token.slice(equals + 1));
	}
	return { name: tokens[0]!, positional, attrs };
}

function tokenizeMarker(text: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
		if (inQuotes) {
			current += char;
			if (char === "\\" && index + 1 < text.length) {
				index++;
				current += text[index]!;
			} else if (char === '"') {
				inQuotes = false;
			}
			continue;
		}
		if (char === " " || char === "\t") {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
		if (char === '"') inQuotes = true;
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}

function parseAttributeValue(raw: string): string {
	if (!raw.startsWith('"')) return raw;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "string" ? parsed : raw;
	} catch {
		return raw.replace(/^"|"$/g, "");
	}
}

function splitDocument(document: string): { blocks: RawBlock[]; issues: SessionDocumentIssue[] } {
	const issues: SessionDocumentIssue[] = [];
	// A CRLF document (Windows editor) is normalized line by line; an LF document
	// keeps carriage returns that belong to the content itself.
	const firstBreak = document.indexOf("\n");
	const crlfDocument = firstBreak > 0 && document[firstBreak - 1] === "\r";
	const lines = document.split("\n").map((line) => (crlfDocument && line.endsWith("\r") ? line.slice(0, -1) : line));
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const blocks: RawBlock[] = [];
	let block: RawBlock | undefined;
	let section: RawSection | undefined;
	lines.forEach((line, index) => {
		const marker = line.startsWith(`${SESSION_DOCUMENT_MARKER} `) ? parseMarker(line) : undefined;
		if (marker && (marker.name === "entry" || marker.name === "new")) {
			block = { marker, sections: [], lineNumber: index + 1 };
			blocks.push(block);
			section = undefined;
			return;
		}
		if (marker) {
			if (marker.name === END_SECTION) {
				// Marks the end of the final section so the last body line does not
				// depend on the file's trailing newline.
				section = undefined;
				return;
			}
			if (!block) {
				issues.push({
					level: "warning",
					message: `line ${index + 1}: ${marker.name} section outside an entry block`,
				});
				return;
			}
			section = { marker, lines: [], lineNumber: index + 1 };
			block.sections.push(section);
			return;
		}
		if (section) {
			section.lines.push(unescapeDocumentLine(line));
			return;
		}
		if (block) {
			issues.push({ level: "warning", message: `line ${index + 1}: content outside a section is ignored` });
		}
	});
	return { blocks, issues };
}

export function parseSessionDocument(
	document: string,
	originalEntries: readonly SessionEntry[],
): ParsedSessionDocument {
	const { blocks, issues } = splitDocument(document);
	const originalById = new Map(originalEntries.map((entry) => [entry.id, entry]));
	const seenIds = new Set<string>();
	const usedIds = new Set(originalEntries.map((entry) => entry.id));
	const entries: SessionEntry[] = [];

	for (const block of blocks) {
		if (block.marker.name === "entry") {
			const id = block.marker.positional[0];
			if (!id) {
				issues.push({ level: "error", message: `line ${block.lineNumber}: entry marker has no id` });
				continue;
			}
			const original = originalById.get(id);
			if (!original) {
				issues.push({ level: "error", message: `line ${block.lineNumber}: unknown entry id ${id}`, entryId: id });
				continue;
			}
			if (seenIds.has(id)) {
				issues.push({ level: "error", message: `line ${block.lineNumber}: duplicate entry id ${id}`, entryId: id });
				continue;
			}
			seenIds.add(id);
			const result = applyExistingEntry(original, block, issues);
			if (result.entry) entries.push(result.entry);
			continue;
		}
		if (block.marker.name === "new") {
			const result = buildNewEntry(block, issues, entries, usedIds);
			if (!result.entry) continue;
			usedIds.add(result.entry.id);
			entries.push(result.entry);
			continue;
		}
		issues.push({ level: "error", message: `line ${block.lineNumber}: unexpected block ${block.marker.name}` });
	}

	const survivingOriginalIds = entries.filter((entry) => originalById.has(entry.id)).map((entry) => entry.id);
	const orderUnchanged =
		survivingOriginalIds.length === originalEntries.length &&
		survivingOriginalIds.length === entries.length &&
		survivingOriginalIds.every((id, index) => id === originalEntries[index]!.id);
	if (!orderUnchanged) {
		entries.forEach((entry, index) => {
			entry.parentId = index === 0 ? null : entries[index - 1]!.id;
		});
	}
	validateEntries(entries, issues);

	return { entries, issues, ...summarizeSessionChanges(originalEntries, entries) };
}

/** Compare final entries after relinking so reordered transcripts count as edits. */
export function summarizeSessionChanges(
	originalEntries: readonly SessionEntry[],
	entries: readonly SessionEntry[],
): { stats: SessionDocumentStats; changes: SessionDocumentChange[] } {
	const originalById = new Map(originalEntries.map((entry) => [entry.id, entry]));
	const currentIds = new Set(entries.map((entry) => entry.id));
	const changes: SessionDocumentChange[] = [];
	const stats: SessionDocumentStats = { total: entries.length, edited: 0, added: 0, removed: 0, unchanged: 0 };
	for (const entry of entries) {
		const original = originalById.get(entry.id);
		if (original !== undefined && deepEqual(original, entry)) {
			stats.unchanged++;
			continue;
		}
		const kind = original === undefined ? "added" : "edited";
		stats[kind]++;
		changes.push({ kind, id: entry.id, label: describeEntry(entry) });
	}
	for (const entry of originalEntries) {
		if (currentIds.has(entry.id)) continue;
		stats.removed++;
		changes.push({ kind: "removed", id: entry.id, label: describeEntry(entry) });
	}
	return { stats, changes };
}

interface EntryBuildResult {
	entry?: SessionEntry;
	changed: boolean;
}

function applyExistingEntry(original: SessionEntry, block: RawBlock, issues: SessionDocumentIssue[]): EntryBuildResult {
	const declaredType = block.marker.attrs.type;
	if (declaredType !== undefined && declaredType !== original.type) {
		issues.push({
			level: "error",
			message: `entry ${original.id}: type ${declaredType} does not match ${original.type}`,
			entryId: original.id,
		});
		return { changed: false };
	}
	const entry = structuredClone(original);
	applyCommonAttrs(entry, block.marker, issues);
	let dropped = false;
	if (entryShapeIssues(original).length > 0) {
		applyJsonPayload(entry, block, issues, []);
	} else if (entry.type === "message" && original.type === "message") {
		dropped = applyMessageSections(entry, original, block, issues);
	} else if (entry.type === "custom_message" && original.type === "custom_message") {
		applyCustomMessageSections(entry, block, issues);
	} else if (entry.type === "compaction" && original.type === "compaction") {
		applySummarySections(entry, block, issues, "summary");
	} else if (entry.type === "branch_summary" && original.type === "branch_summary") {
		applySummarySections(entry, block, issues, "summary");
	} else {
		applyJsonPayload(entry, block, issues, []);
	}
	if (dropped) return { changed: true };
	return { entry, changed: !entriesEqual(entry, original) };
}

function applyCommonAttrs(entry: SessionEntry, marker: Marker, issues: SessionDocumentIssue[]): void {
	const time = marker.attrs.time;
	if (time === undefined || time === entry.timestamp) return;
	if (Number.isNaN(Date.parse(time))) {
		issues.push({ level: "error", message: `entry ${entry.id}: invalid time ${time}`, entryId: entry.id });
		return;
	}
	entry.timestamp = time;
}

function applyMessageSections(
	entry: SessionMessageEntry,
	original: SessionMessageEntry,
	block: RawBlock,
	issues: SessionDocumentIssue[],
): boolean {
	const rawMessage = entry.message as unknown;
	const rawOriginal = original.message as unknown;
	if (
		!isRecord(rawMessage) ||
		typeof rawMessage.role !== "string" ||
		!isRecord(rawOriginal) ||
		typeof rawOriginal.role !== "string"
	) {
		// A damaged payload has no sections to apply; a JSON merge keeps it intact.
		applyJsonPayload(entry, block, issues, []);
		return false;
	}
	const message = entry.message;
	const originalMessage = original.message;
	const declaredRole = block.marker.attrs.role;
	if (declaredRole !== undefined && declaredRole !== originalMessage.role) {
		issues.push({
			level: "error",
			message: `entry ${entry.id}: role ${declaredRole} does not match ${originalMessage.role}`,
			entryId: entry.id,
		});
		return false;
	}
	const sections = block.sections.filter((section) => {
		if (!ALL_SECTIONS.has(section.marker.name)) {
			issues.push({
				level: "error",
				message: `line ${section.lineNumber}: unknown section ${section.marker.name}`,
				entryId: entry.id,
			});
			return false;
		}
		if (section.marker.name === "json") return false;
		return true;
	});

	if (message.role === "user" && originalMessage.role === "user") {
		const applied = buildTextContent("user", sections, originalMessage, issues);
		if (applied === undefined) {
			// Deleting every section removes the entry, but an entry that rendered no
			// section (for example content: []) must survive an unchanged document.
			return renderContentSections("user", originalMessage.content).length > 0;
		}
		message.content = applied;
		return false;
	}
	if (message.role === "assistant" && originalMessage.role === "assistant") {
		if (block.marker.attrs.provider !== undefined) message.provider = block.marker.attrs.provider;
		if (block.marker.attrs.model !== undefined) message.model = block.marker.attrs.model;
		if (block.marker.attrs.stop !== undefined) {
			const stop = block.marker.attrs.stop;
			if (STOP_REASONS.has(stop)) {
				message.stopReason = stop as StopReason;
			} else {
				issues.push({
					level: "error",
					message: `entry ${entry.id}: unknown stop reason ${stop}`,
					entryId: entry.id,
				});
			}
		}
		const originalContent = Array.isArray(originalMessage.content) ? originalMessage.content : [];
		const content = buildAssistantContent(sections, originalContent, entry.id, issues);
		if (content.length === 0 && originalContent.length > 0) return true;
		message.content = content;
		return false;
	}
	if (message.role === "toolResult" && originalMessage.role === "toolResult") {
		if (block.marker.attrs.name !== undefined) message.toolName = block.marker.attrs.name;
		if (block.marker.attrs.call !== undefined) message.toolCallId = block.marker.attrs.call;
		if (block.marker.attrs.error !== undefined) {
			const value = block.marker.attrs.error.toLowerCase();
			if (value === "true" || value === "false") {
				message.isError = value === "true";
			} else {
				issues.push({
					level: "error",
					message: `entry ${entry.id}: error must be true or false`,
					entryId: entry.id,
				});
			}
		}
		const content = buildBlockContent("tool_result", sections, originalMessage.content, entry.id, issues);
		message.content = content.length === 0 ? [] : content;
		return false;
	}
	if (message.role === "custom" && originalMessage.role === "custom") {
		if (block.marker.attrs.customType !== undefined) message.customType = block.marker.attrs.customType;
		if (block.marker.attrs.display !== undefined) message.display = block.marker.attrs.display === "true";
		const content = buildTextContent("custom", sections, originalMessage, issues);
		if (content === undefined)
			return typeof originalMessage.content === "string"
				? originalMessage.content !== ""
				: originalMessage.content.length > 0;
		message.content = content;
		return false;
	}
	if (message.role === "bashExecution" && originalMessage.role === "bashExecution") {
		applyBashSections(message, block, issues);
		return false;
	}
	if (message.role === "branchSummary" && originalMessage.role === "branchSummary") {
		applySummarySections(message, block, issues, "summary");
		return false;
	}
	if (message.role === "compactionSummary" && originalMessage.role === "compactionSummary") {
		applySummarySections(message, block, issues, "summary");
		return false;
	}
	applyJsonPayload(message, block, issues, [...BASE_MESSAGE_KEYS]);
	return false;
}

function buildTextContent(
	sectionName: string,
	sections: readonly RawSection[],
	original: UserMessage | CustomMessage,
	issues: SessionDocumentIssue[],
): string | (TextContent | ImageContent)[] | undefined {
	const originalContent = original.content;
	const originalBlocks = Array.isArray(originalContent) ? originalContent : [];
	const blocks = buildBlockContent(sectionName, sections, originalBlocks, undefined, issues);
	if (originalContent === "" && blocks.length === 0 && sections.some((section) => section.marker.name === sectionName))
		return "";
	if (blocks.length === 0) return undefined;
	if (typeof originalContent === "string" && blocks.length === 1 && blocks[0]!.type === "text") {
		return blocks[0]!.text;
	}
	return blocks;
}

function buildBlockContent(
	sectionName: string,
	sections: readonly RawSection[],
	original: readonly (TextContent | ImageContent)[],
	entryId: string | undefined,
	issues: SessionDocumentIssue[],
): (TextContent | ImageContent)[] {
	const originalBlocks = Array.isArray(original) ? original : [];
	const blocks: (TextContent | ImageContent)[] = [];
	for (const section of sections) {
		const name = section.marker.name;
		if (name !== sectionName && name !== "image" && name !== "keep") {
			issues.push({
				level: "error",
				message: `line ${section.lineNumber}: section ${name} is not valid in ${sectionName}`,
				entryId,
			});
			continue;
		}
		if (name === sectionName) {
			const text = sectionText(section);
			const index = sectionIndex(section);
			const originalBlock = index === undefined ? undefined : originalBlocks[index];
			if (text.length === 0) {
				if (originalBlock?.type === "text" && originalBlock.text.length === 0) blocks.push(originalBlock);
				continue;
			}
			blocks.push(updatedTextBlock(originalBlock, text));
			continue;
		}
		pushPreservedBlock(blocks, section, originalBlocks, issues);
	}
	return blocks;
}

function buildAssistantContent(
	sections: readonly RawSection[],
	original: AssistantMessage["content"],
	entryId: string,
	issues: SessionDocumentIssue[],
): AssistantMessage["content"] {
	const originalBlocks = Array.isArray(original) ? original : [];
	const blocks: AssistantMessage["content"] = [];
	for (const section of sections) {
		const name = section.marker.name;
		const index = sectionIndex(section);
		const originalBlock = index === undefined ? undefined : originalBlocks[index];
		const text = sectionText(section);
		if (name === "assistant") {
			if (text.length === 0) {
				if (originalBlock?.type === "text" && originalBlock.text.length === 0) blocks.push(originalBlock);
				continue;
			}
			blocks.push(updatedTextBlock(originalBlock, text));
		} else if (name === "reasoning") {
			if (text.length === 0) continue;
			blocks.push(updatedThinkingBlock(originalBlock, text));
		} else if (name === "tool_call") {
			const id = section.marker.attrs.id ?? (originalBlock?.type === "toolCall" ? originalBlock.id : undefined);
			const callName =
				section.marker.attrs.name ?? (originalBlock?.type === "toolCall" ? originalBlock.name : undefined);
			if (!id || !callName) {
				issues.push({
					level: "error",
					message: `line ${section.lineNumber}: tool_call needs id=<id> and name=<tool>`,
					entryId,
				});
				continue;
			}
			const args = applyToolArguments(
				parseToolArguments(text, section, entryId, issues),
				originalBlock,
				section,
				entryId,
				issues,
			);
			blocks.push(
				originalBlock?.type === "toolCall"
					? { ...originalBlock, id, name: callName, arguments: args ?? originalBlock.arguments }
					: { type: "toolCall", id, name: callName, arguments: args ?? {} },
			);
		} else if (name === "keep") {
			const block = index === undefined ? undefined : originalBlocks[index];
			if (!block) {
				issues.push({ level: "error", message: `line ${section.lineNumber}: no block at index ${index}`, entryId });
				continue;
			}
			blocks.push(block);
		} else if (name === "image") {
			issues.push({
				level: "error",
				message: `line ${section.lineNumber}: assistant messages cannot contain images`,
				entryId,
			});
		} else if (name === "json") {
		} else {
			issues.push({
				level: "error",
				message: `line ${section.lineNumber}: section ${name} is not valid in an assistant message`,
				entryId,
			});
		}
	}
	return blocks;
}

function pushPreservedBlock(
	target: (TextContent | ImageContent)[],
	section: RawSection,
	original: readonly (TextContent | ImageContent)[] | AssistantMessage["content"],
	issues: SessionDocumentIssue[],
): void {
	const index = sectionIndex(section);
	if (index === undefined || index < 0 || index >= original.length) {
		issues.push({ level: "error", message: `line ${section.lineNumber}: no block at index ${index}` });
		return;
	}
	const block = original[index]!;
	if (section.marker.name === "image" && block.type !== "image") {
		issues.push({ level: "error", message: `line ${section.lineNumber}: block ${index} is not an image` });
		return;
	}
	const declaredMime = section.marker.attrs.mimeType;
	if (declaredMime !== undefined && block.type === "image" && block.mimeType !== declaredMime) {
		issues.push({
			level: "warning",
			message: `line ${section.lineNumber}: mimeType cannot be changed here; the image keeps ${block.mimeType}`,
		});
	}
	const declaredType = section.marker.attrs.type;
	if (declaredType !== undefined && declaredType !== blockTypeOf(block)) {
		issues.push({
			level: "warning",
			message: `line ${section.lineNumber}: block type cannot be changed here; it keeps ${blockTypeOf(block)}`,
		});
	}
	target.push(block as TextContent | ImageContent);
}

type DocumentContentBlock = TextContent | ThinkingContent | ImageContent | ToolCall;

function updatedTextBlock(originalBlock: DocumentContentBlock | undefined, text: string): TextContent {
	if (originalBlock?.type === "text") {
		if (originalBlock.text === text) return originalBlock;
		// A rewritten block no longer matches its provider signature.
		const { textSignature: _textSignature, ...rest } = originalBlock;
		return { ...rest, text };
	}
	return { type: "text", text };
}

function updatedThinkingBlock(originalBlock: DocumentContentBlock | undefined, text: string): ThinkingContent {
	if (originalBlock?.type === "thinking") {
		if (originalBlock.thinking === text) return originalBlock;
		// A rewritten reasoning block no longer matches its provider signature.
		const { thinkingSignature: _thinkingSignature, ...rest } = originalBlock;
		return { ...rest, thinking: text };
	}
	return { type: "thinking", thinking: text };
}

interface ParsedToolArguments {
	/** False when the section body is not valid JSON; the original value is kept. */
	ok: boolean;
	value?: unknown;
}

function parseToolArguments(
	text: string,
	section: RawSection,
	entryId: string,
	issues: SessionDocumentIssue[],
): ParsedToolArguments {
	const trimmed = text.trim();
	if (trimmed.length === 0) return { ok: true };
	try {
		return { ok: true, value: JSON.parse(trimmed) as unknown };
	} catch (error) {
		issues.push({
			level: "error",
			message: `line ${section.lineNumber}: tool_call arguments are not valid JSON (${error instanceof Error ? error.message : String(error)})`,
			entryId,
		});
		return { ok: false };
	}
}

/**
 * Applies edited tool-call arguments. A non-object value is only accepted when
 * the stored arguments were already not an object, so the editor never invents
 * a shape the provider cannot replay, and never normalizes stored values.
 */
function applyToolArguments(
	parsed: ParsedToolArguments,
	originalBlock: DocumentContentBlock | undefined,
	section: RawSection,
	entryId: string,
	issues: SessionDocumentIssue[],
): Record<string, unknown> | undefined {
	const original = originalBlock?.type === "toolCall" ? (originalBlock.arguments as unknown) : undefined;
	if (!parsed.ok || parsed.value === undefined) return original as Record<string, unknown> | undefined;
	if (isRecord(parsed.value)) return parsed.value as Record<string, unknown>;
	if (!isRecord(original)) {
		issues.push({
			level: "warning",
			message: `line ${section.lineNumber}: tool_call arguments stay ${JSON.stringify(original)}; they were not a JSON object`,
			entryId,
		});
		return original as Record<string, unknown> | undefined;
	}
	issues.push({
		level: "error",
		message: `line ${section.lineNumber}: tool_call arguments must be a JSON object`,
		entryId,
	});
	return original as Record<string, unknown> | undefined;
}

function applyCustomMessageSections(entry: CustomMessageEntry, block: RawBlock, issues: SessionDocumentIssue[]): void {
	if (block.marker.attrs.customType !== undefined) entry.customType = block.marker.attrs.customType;
	if (block.marker.attrs.display !== undefined) entry.display = block.marker.attrs.display === "true";
	const sections = block.sections.filter((section) => section.marker.name !== "json");
	const content =
		typeof entry.content === "string"
			? buildStringContent("custom", sections)
			: buildBlockContent("custom", sections, entry.content, entry.id, issues);
	entry.content = content;
	applyJsonPayload(entry, block, issues, ["content", "customType", "display"]);
}

function buildStringContent(sectionName: string, sections: readonly RawSection[]): string {
	const matching = sections.filter((section) => section.marker.name === sectionName);
	if (matching.length === 0) {
		// The renderer always emits a section for string content, so a missing
		// section means the user deleted it: clear the content.
		return "";
	}
	return matching
		.map((section) => sectionText(section))
		.filter((text) => text.length > 0)
		.join("\n");
}

function applySummarySections(
	target: { summary: string },
	block: RawBlock,
	issues: SessionDocumentIssue[],
	sectionName: string,
): void {
	const sections = block.sections.filter((section) => section.marker.name === sectionName);
	if (sections.length > 0) target.summary = sectionText(sections[0]!);
	for (const section of block.sections) {
		if (section.marker.name !== sectionName && section.marker.name !== "json") {
			issues.push({
				level: "error",
				message: `line ${section.lineNumber}: section ${section.marker.name} is not valid here`,
			});
		}
	}
	applyJsonPayload(target, block, issues, [sectionName]);
}

function applyBashSections(message: BashExecutionMessage, block: RawBlock, issues: SessionDocumentIssue[]): void {
	for (const section of block.sections) {
		if (section.marker.name === "command") message.command = sectionText(section);
		else if (section.marker.name === "output") message.output = sectionText(section);
		else if (section.marker.name !== "json") {
			issues.push({
				level: "error",
				message: `line ${section.lineNumber}: section ${section.marker.name} is not valid in a bash execution message`,
			});
		}
	}
	applyJsonPayload(message, block, issues, ["command", "output"]);
}

function applyJsonPayload(
	target: object,
	block: RawBlock,
	issues: SessionDocumentIssue[],
	excluded: readonly string[],
): void {
	const section = block.sections.find((candidate) => candidate.marker.name === "json");
	if (!section) return;
	const text = sectionText(section).trim();
	if (text.length === 0) return;
	const record = target as Record<string, unknown>;
	const entryId = typeof record.id === "string" ? record.id : undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch (error) {
		issues.push({
			level: "error",
			message: `line ${section.lineNumber}: json section is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
			entryId,
		});
		return;
	}
	if (!isRecord(payload)) {
		issues.push({ level: "error", message: `line ${section.lineNumber}: json section must be an object`, entryId });
		return;
	}
	if (samePayload(record, payload, excluded)) return;
	for (const key of Object.keys(record)) {
		if (BASE_ENTRY_KEYS.has(key) || BASE_MESSAGE_KEYS.has(key) || excluded.includes(key)) continue;
		delete record[key];
	}
	for (const [key, value] of Object.entries(payload)) {
		if (BASE_ENTRY_KEYS.has(key) || key === "role") continue;
		record[key] = value;
	}
}

function buildNewEntry(
	block: RawBlock,
	issues: SessionDocumentIssue[],
	entries: readonly SessionEntry[],
	usedIds: Set<string>,
): EntryBuildResult {
	const role = block.marker.positional[0];
	if (!role || !NEW_ROLES.has(role)) {
		issues.push({
			level: "error",
			message: `line ${block.lineNumber}: new block needs one of ${[...NEW_ROLES].join(", ")}`,
		});
		return { changed: false };
	}
	const id = generateEntryId(usedIds);
	const timestamp = block.marker.attrs.time ?? new Date().toISOString();
	if (Number.isNaN(Date.parse(timestamp))) {
		issues.push({ level: "error", message: `line ${block.lineNumber}: invalid time ${timestamp}` });
		return { changed: false };
	}
	const sections = block.sections.filter((section) => section.marker.name !== "json");
	const time = Date.parse(timestamp);
	if (role === "user") {
		const content = newTextContent("user", sections, issues);
		if (content === undefined) {
			issues.push({
				level: "error",
				message: `line ${block.lineNumber}: new user entry has no content`,
				entryId: id,
			});
			return { changed: false };
		}
		return {
			entry: { type: "message", id, parentId: null, timestamp, message: createUserMessage(content, time) },
			changed: true,
		};
	}
	if (role === "assistant") {
		const identity = inferAssistantIdentity(entries);
		const provider = block.marker.attrs.provider ?? identity?.provider;
		const model = block.marker.attrs.model ?? identity?.model;
		const api = block.marker.attrs.api ?? identity?.api;
		if (!provider || !model || !api) {
			issues.push({
				level: "error",
				message: `line ${block.lineNumber}: new assistant entry needs provider=<p> model=<m> api=<a> when no earlier assistant message exists`,
				entryId: id,
			});
			return { changed: false };
		}
		const content = buildAssistantContent(sections, [], id, issues);
		if (content.length === 0) {
			issues.push({
				level: "error",
				message: `line ${block.lineNumber}: new assistant entry has no content`,
				entryId: id,
			});
			return { changed: false };
		}
		const message = createAssistantMessage({
			content,
			api,
			provider,
			model,
			stopReason: block.marker.attrs.stop as StopReason | undefined,
			timestamp: time,
		});
		return { entry: { type: "message", id, parentId: null, timestamp, message }, changed: true };
	}
	const callId = block.marker.attrs.call;
	if (!callId) {
		issues.push({
			level: "error",
			message: `line ${block.lineNumber}: new toolResult entry needs call=<toolCallId>`,
			entryId: id,
		});
		return { changed: false };
	}
	const toolName = block.marker.attrs.name ?? inferToolName(entries, callId) ?? "tool";
	const content = buildBlockContent("tool_result", sections, [], id, issues);
	const message = createToolResultMessage({
		toolCallId: callId,
		toolName,
		content,
		isError: block.marker.attrs.error === "true",
		timestamp: time,
	});
	return { entry: { type: "message", id, parentId: null, timestamp, message }, changed: true };
}

function newTextContent(
	sectionName: string,
	sections: readonly RawSection[],
	issues: SessionDocumentIssue[],
): TextContent[] | undefined {
	const texts: string[] = [];
	for (const section of sections) {
		if (section.marker.name !== sectionName) {
			issues.push({
				level: "error",
				message: `line ${section.lineNumber}: section ${section.marker.name} is not valid in a new ${sectionName} entry`,
			});
			continue;
		}
		const text = sectionText(section);
		if (text.length > 0) texts.push(text);
	}
	if (texts.length === 0) return undefined;
	return texts.map((text) => ({ type: "text", text }));
}

/** Nearest assistant identity before the insertion point, for a new assistant entry. */
export function inferAssistantIdentity(
	entries: readonly SessionEntry[],
): { provider: string; model: string; api?: string } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "message" && entry.message.role === "assistant") {
			return { provider: entry.message.provider, model: entry.message.model, api: entry.message.api };
		}
		if (entry.type === "model_change") {
			return { provider: entry.provider, model: entry.modelId };
		}
	}
	return undefined;
}

function inferToolName(entries: readonly SessionEntry[], callId: string): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type === "toolCall" && block.id === callId) return block.name;
		}
	}
	return undefined;
}

export function validateEntries(entries: readonly SessionEntry[], issues: SessionDocumentIssue[]): void {
	for (const entry of entries) {
		validateEntryShape(entry, issues);
	}
	const pending = new Map<string, string>();
	const flushPending = (): void => {
		for (const [callId, ownerId] of pending) {
			issues.push({
				level: "warning",
				message: `tool call ${callId} in entry ${ownerId} has no tool result; the model sees a synthetic error result`,
				entryId: ownerId,
			});
		}
		pending.clear();
	};
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const raw = entry.message as unknown;
		if (!isRecord(raw) || typeof raw.role !== "string") {
			// Shape errors are reported above; pairing cannot be checked.
			continue;
		}
		if (raw.role === "assistant") {
			if (pending.size > 0) flushPending();
			const content = Array.isArray(raw.content) ? raw.content : [];
			for (const block of content) {
				if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
				if (pending.has(block.id)) {
					issues.push({ level: "warning", message: `duplicate tool call id ${block.id}`, entryId: entry.id });
					continue;
				}
				pending.set(block.id, entry.id);
			}
			if (content.length === 0 && raw.stopReason !== "error" && raw.stopReason !== "aborted") {
				issues.push({ level: "warning", message: `assistant entry ${entry.id} has no content`, entryId: entry.id });
			}
		} else if (raw.role === "toolResult") {
			const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
			if (toolCallId !== undefined && pending.has(toolCallId)) {
				pending.delete(toolCallId);
			} else {
				issues.push({
					level: "warning",
					message: `tool result in entry ${entry.id} references unknown tool call ${toolCallId ?? "(missing)"}; it is dropped from model context`,
					entryId: entry.id,
				});
			}
		} else if (pending.size > 0) {
			flushPending();
		}
	}
	flushPending();

	const ids = new Set(entries.map((entry) => entry.id));
	for (const entry of entries) {
		if (entry.type === "compaction" && !ids.has(entry.firstKeptEntryId)) {
			issues.push({
				level: "warning",
				message: `compaction ${entry.id} keeps from missing entry ${entry.firstKeptEntryId}`,
				entryId: entry.id,
			});
		}
		if (entry.type === "branch_summary" && !ids.has(entry.fromId)) {
			issues.push({
				level: "warning",
				message: `branch summary ${entry.id} references missing entry ${entry.fromId}`,
				entryId: entry.id,
			});
		}
		if (entry.type === "label" && entry.targetId !== undefined && !ids.has(entry.targetId)) {
			issues.push({
				level: "warning",
				message: `label ${entry.id} references missing entry ${entry.targetId}`,
				entryId: entry.id,
			});
		}
		if (entry.type === "child_usage_attributed" && !ids.has(entry.targetId)) {
			issues.push({
				level: "warning",
				message: `usage attribution ${entry.id} references missing entry ${entry.targetId}`,
				entryId: entry.id,
			});
		}
	}
}

/**
 * Shape checks for entries parsed from a damaged or newer file. Structural
 * errors block a rewrite so an editor cannot persist a payload the runtime
 * cannot read back.
 */
function entryShapeIssues(entry: SessionEntry): SessionDocumentIssue[] {
	const issues: SessionDocumentIssue[] = [];
	validateEntryShape(entry, issues);
	return issues;
}

function validateEntryShape(entry: SessionEntry, issues: SessionDocumentIssue[]): void {
	const id = entry.id;
	const error = (message: string): void => {
		issues.push({ level: "error", message: `entry ${id} ${message}`, entryId: id });
	};
	if (entry.type === "message") {
		const message = (entry as { message?: unknown }).message;
		if (!isRecord(message) || typeof message.role !== "string") {
			error("has no message payload");
			return;
		}
		const content = (message as { content?: unknown }).content;
		if (message.role === "assistant" && !Array.isArray(content)) {
			error("assistant content is not an array");
		} else if ((message.role === "user" || message.role === "custom") && !isContent(content)) {
			error(`${message.role} content is not text or content blocks`);
		} else if (message.role === "toolResult") {
			if (!Array.isArray(content)) error("tool result content is not an array");
			if (typeof (message as { toolCallId?: unknown }).toolCallId !== "string") {
				error("tool result has no tool call id");
			}
		}
		if (Array.isArray(content)) {
			for (const block of content) {
				if (!isRecord(block) || typeof block.type !== "string") error("has an invalid content block");
				else if (block.type === "text" && typeof block.text !== "string") error("text block has no text");
				else if (block.type === "thinking" && typeof block.thinking !== "string")
					error("thinking block has no text");
			}
		}
		return;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		if (typeof entry.summary !== "string") error(`${entry.type} has no summary`);
	}
	if (entry.type === "custom_message" && !isContent(entry.content)) {
		error("custom message content is not text or content blocks");
	}
	if (entry.type === "session_state" && (!isRecord(entry.state) || typeof entry.state.status !== "string")) {
		error("session state has no status");
	}
	if (entry.type === "agent_status" && !isRecord(entry.status)) {
		error("agent status payload is missing");
	}
}

export function describeEntry(entry: SessionEntry): string {
	if (entry.type !== "message") return entry.type;
	const message = entry.message as unknown;
	if (!isRecord(message) || typeof message.role !== "string") return "message";
	if (message.role === "toolResult") return `toolResult ${String(message.toolName ?? "")}`.trimEnd();
	if (message.role === "assistant") {
		const content = Array.isArray(message.content) ? message.content : [];
		const tools = content
			.filter((block) => isRecord(block) && block.type === "toolCall")
			.map((block) => String((block as { name?: unknown }).name ?? "tool"));
		return tools.length > 0 ? `assistant ${tools.join(",")}` : "assistant";
	}
	return message.role;
}

export function hasErrors(issues: readonly SessionDocumentIssue[]): boolean {
	return issues.some((issue) => issue.level === "error");
}

export function formatIssues(issues: readonly SessionDocumentIssue[]): string[] {
	return issues.map((issue) => `${issue.level === "error" ? "error" : "warning"}: ${issue.message}`);
}

export function formatChangeSummary(stats: SessionDocumentStats): string {
	const parts = [`${stats.total} entries`];
	if (stats.edited > 0) parts.push(`${stats.edited} edited`);
	if (stats.added > 0) parts.push(`${stats.added} added`);
	if (stats.removed > 0) parts.push(`${stats.removed} removed`);
	if (stats.edited === 0 && stats.added === 0 && stats.removed === 0) parts.push("no changes");
	return parts.join(", ");
}

function sectionIndex(section: RawSection): number | undefined {
	const raw = section.marker.attrs.index;
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function sectionText(section: RawSection): string {
	return section.lines.join("\n");
}

function samePayload(
	record: Record<string, unknown>,
	payload: Record<string, unknown>,
	excluded: readonly string[],
): boolean {
	const currentKeys = Object.keys(record).filter(
		(key) => !BASE_ENTRY_KEYS.has(key) && !BASE_MESSAGE_KEYS.has(key) && !excluded.includes(key),
	);
	const payloadKeys = Object.keys(payload).filter((key) => !BASE_ENTRY_KEYS.has(key) && key !== "role");
	if (currentKeys.length !== payloadKeys.length) return false;
	return payloadKeys.every((key) => currentKeys.includes(key) && deepEqual(record[key], payload[key]));
}

function entriesEqual(left: SessionEntry, right: SessionEntry): boolean {
	return deepEqual(left, right);
}

function isContent(value: unknown): value is string | (TextContent | ImageContent)[] {
	return typeof value === "string" || Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSessionHeader(value: unknown): value is SessionHeader {
	return isRecord(value) && value.type === "session" && typeof value.id === "string";
}

export function isSessionEntry(value: unknown): value is SessionEntry {
	return isRecord(value) && typeof value.type === "string" && value.type !== "session" && typeof value.id === "string";
}
