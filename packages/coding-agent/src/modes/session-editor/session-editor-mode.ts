import {
	type Component,
	clippedFullscreenDockHeight,
	type Focusable,
	type Keybinding,
	ProcessTerminal,
	setKeybindings,
	TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { KeybindingsManager } from "../../core/keybindings.js";
import {
	describeEntry,
	parseSessionDocument,
	renderEntryBlock,
	SESSION_DOCUMENT_MARKER,
} from "../../core/session-editor/document.js";
import { type SessionWriteResult, writeSessionEntries } from "../../core/session-editor/index.js";
import type { NewEntryDraft, SessionEditModel } from "../../core/session-editor/model.js";
import type { SessionEntry } from "../../core/session-manager.js";
import { type ExternalEditorResult, editTextInExternalEditor } from "../../utils/external-editor.js";
import { keyText } from "../interactive/components/keybinding-hints.js";

/**
 * Interactive transcript editor: browse a saved session, then edit, delete,
 * insert, reorder, or undo entries. Every action keeps ids, timestamps, the
 * parent chain, and dependent references consistent through SessionEditModel.
 */

export interface SessionEditorModeOptions {
	sessionPath: string;
	model: SessionEditModel;
	force?: boolean;
	backup?: boolean;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	stat?: { size: number; mtimeMs: number };
	/** Notice shown on the first frame, e.g. damaged session lines. */
	initialNotice?: string;
	/** Tests inject a TUI; production builds one on the process terminal. */
	ui?: TUI;
	keybindings?: KeybindingsManager;
	/** Tests replace the save and editor side effects. */
	writeSession?: (model: SessionEditModel) => SessionWriteResult;
	editText?: (contents: string) => ExternalEditorResult;
}

export interface SessionEditorModeResult {
	saved: boolean;
	writes: number;
	backups: string[];
}

interface QuitConfirmation {
	kind: "quit";
}

const DOCK_HEIGHT = 2;
const LIST_SHARE = 0.45;
const PAGE_STEP = 10;
const DETAIL_SCROLL_STEP = 5;

export class SessionEditorMode implements Component, Focusable {
	focused = false;
	private readonly model: SessionEditModel;
	private readonly options: SessionEditorModeOptions;
	private readonly ui: TUI;
	private readonly keybindings: KeybindingsManager;
	readonly dock: Component;
	private stat: { size: number; mtimeMs: number } | undefined;
	private cursor = 0;
	private detailScroll = 0;
	private rawJson = false;
	private helpVisible = false;
	private notice: string | undefined;
	private searchQuery: string | undefined;
	private searchInput: string | undefined;
	private confirmation: QuitConfirmation | undefined;
	private saved = false;
	private writes = 0;
	private readonly backups: string[] = [];
	private stopped = false;
	private resolveRun?: (result: SessionEditorModeResult) => void;

	constructor(options: SessionEditorModeOptions) {
		this.options = options;
		this.model = options.model;
		this.stat = options.stat;
		this.keybindings = options.keybindings ?? KeybindingsManager.create();
		// Hints and key text read the process-wide registry.
		setKeybindings(this.keybindings);
		this.ui = options.ui ?? new TUI(new ProcessTerminal());
		this.dock = { render: (width) => this.renderDock(width), invalidate: () => undefined };
		this.notice = options.initialNotice;
	}

	async run(): Promise<SessionEditorModeResult> {
		this.ui.addChild(this);
		this.ui.setFocus(this);
		this.ui.start();
		this.ui.enterFullscreen({ scroll: [this], dock: this.dock, mouse: false, viewportControls: false });
		this.ui.requestRender(true);
		return new Promise<SessionEditorModeResult>((resolve) => {
			this.resolveRun = resolve;
		});
	}

	invalidate(): void {}

	render(width: number): string[] {
		const reportedRows = this.ui.terminal.rows;
		const rows = Number.isFinite(reportedRows) && reportedRows > 0 ? reportedRows : 24;
		const contentHeight = Math.max(1, rows - clippedFullscreenDockHeight(DOCK_HEIGHT, rows));
		const lines: string[] = [];
		lines.push(this.renderHeader(width));
		const listHeight = Math.max(1, Math.min(Math.floor(contentHeight * LIST_SHARE), Math.max(1, contentHeight - 3)));
		lines.push(...this.renderList(width, listHeight));
		const remaining = Math.max(0, contentHeight - lines.length);
		if (remaining > 0) {
			lines.push(chalk.dim("─".repeat(Math.max(0, width))));
		}
		const detailHeight = Math.max(0, contentHeight - lines.length);
		if (detailHeight > 0) lines.push(...this.renderDetail(width, detailHeight));
		return padLines(lines, contentHeight).slice(0, contentHeight);
	}

	handleInput(data: string): void {
		const kb = this.keybindings;
		if (this.confirmation !== undefined) {
			this.handleConfirmation(data);
			return;
		}
		if (this.searchInput !== undefined) {
			this.handleSearchInput(data);
			return;
		}
		if (
			kb.matches(data, "tui.select.cancel") ||
			kb.matches(data, "app.clear") ||
			kb.matches(data, "app.sessionEdit.quit")
		) {
			this.requestQuit();
		} else if (kb.matches(data, "app.sessionEdit.help")) {
			this.helpVisible = !this.helpVisible;
		} else if (kb.matches(data, "tui.select.up") || kb.matches(data, "app.sessionEdit.up")) {
			this.moveCursor(-1);
		} else if (kb.matches(data, "tui.select.down") || kb.matches(data, "app.sessionEdit.down")) {
			this.moveCursor(1);
		} else if (kb.matches(data, "app.sessionEdit.top") || kb.matches(data, "tui.viewport.top")) {
			this.moveCursor(-this.model.length);
		} else if (kb.matches(data, "app.sessionEdit.bottom") || kb.matches(data, "tui.viewport.follow")) {
			this.moveCursor(this.model.length);
		} else if (kb.matches(data, "tui.viewport.pageUp")) {
			this.moveCursor(-PAGE_STEP);
		} else if (kb.matches(data, "tui.viewport.pageDown")) {
			this.moveCursor(PAGE_STEP);
		} else if (kb.matches(data, "app.sessionEdit.edit")) {
			this.editSelected();
		} else if (kb.matches(data, "app.sessionEdit.delete")) {
			this.deleteSelected();
		} else if (kb.matches(data, "app.sessionEdit.insert")) {
			this.addEntry("user", this.cursor);
		} else if (kb.matches(data, "app.sessionEdit.append")) {
			this.addEntry("user", this.cursor + 1);
		} else if (kb.matches(data, "app.sessionEdit.appendAssistant")) {
			this.addEntry("assistant", this.cursor + 1);
		} else if (kb.matches(data, "app.sessionEdit.duplicate")) {
			this.duplicateSelected();
		} else if (kb.matches(data, "app.sessionEdit.moveUp")) {
			this.moveSelected(-1);
		} else if (kb.matches(data, "app.sessionEdit.moveDown")) {
			this.moveSelected(1);
		} else if (kb.matches(data, "app.sessionEdit.undo")) {
			this.notice = this.model.undo() ? "undone" : "nothing to undo";
		} else if (kb.matches(data, "app.sessionEdit.redo")) {
			this.notice = this.model.redo() ? "redone" : "nothing to redo";
		} else if (kb.matches(data, "app.sessionEdit.save")) {
			this.save();
		} else if (kb.matches(data, "app.sessionEdit.details")) {
			this.rawJson = !this.rawJson;
		} else if (kb.matches(data, "app.sessionEdit.document")) {
			this.editWholeDocument();
		} else if (kb.matches(data, "app.sessionEdit.detailDown")) {
			this.detailScroll += DETAIL_SCROLL_STEP;
		} else if (kb.matches(data, "app.sessionEdit.detailUp")) {
			this.detailScroll = Math.max(0, this.detailScroll - DETAIL_SCROLL_STEP);
		} else if (kb.matches(data, "app.sessionEdit.search")) {
			this.searchInput = "";
		} else if (kb.matches(data, "app.sessionEdit.searchNext")) {
			this.jumpToMatch(1);
		} else if (kb.matches(data, "app.sessionEdit.searchPrevious")) {
			this.jumpToMatch(-1);
		}
		this.ui.requestRender();
	}

	private handleSearchInput(data: string): void {
		const query = this.searchInput;
		if (query === undefined) return;
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.searchInput = undefined;
			this.notice = undefined;
		} else if (kb.matches(data, "tui.input.submit")) {
			this.searchQuery = query.length > 0 ? query : undefined;
			this.searchInput = undefined;
			this.jumpToMatch(1);
		} else if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.searchInput = query.slice(0, -1);
			this.searchFromCursor();
		} else if (data.length === 1 && data >= " ") {
			this.searchInput = `${query}${data}`;
			this.searchFromCursor();
		}
		this.ui.requestRender();
	}

	/** Jumps to the next entry whose JSON contains the committed query. */
	private jumpToMatch(direction: 1 | -1): void {
		const query = this.searchQuery;
		if (query === undefined || query.length === 0) {
			this.notice = "no search query; press / to search";
			return;
		}
		const total = this.model.length;
		for (let step = 1; step <= total; step++) {
			const index = (this.cursor + direction * step + total * step) % total;
			if (matchesSearch(this.model.entryAt(index), query)) {
				this.cursor = index;
				this.detailScroll = 0;
				this.notice = `match for "${query}"`;
				return;
			}
		}
		this.notice = `no match for "${query}"`;
	}

	private searchFromCursor(): void {
		const query = this.searchInput ?? "";
		if (query.length === 0) return;
		for (let index = 0; index < this.model.length; index++) {
			if (matchesSearch(this.model.entryAt(index), query)) {
				this.cursor = index;
				this.detailScroll = 0;
				return;
			}
		}
	}

	private handleConfirmation(data: string): void {
		const kb = this.keybindings;
		if (kb.matches(data, "tui.select.cancel")) {
			this.confirmation = undefined;
			this.notice = "cancelled";
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.confirmation = undefined;
			this.save();
			if (!this.model.dirty) this.finish();
		} else if (kb.matches(data, "app.sessionEdit.delete")) {
			this.confirmation = undefined;
			this.finish();
		}
		this.ui.requestRender();
	}

	private currentEntry(): SessionEntry | undefined {
		return this.model.entryAt(this.cursor);
	}

	private moveCursor(delta: number): void {
		if (this.model.length === 0) return;
		this.cursor = Math.max(0, Math.min(this.cursor + delta, this.model.length - 1));
		this.detailScroll = 0;
	}

	private moveSelected(delta: -1 | 1): void {
		const entry = this.currentEntry();
		if (entry === undefined) return;
		if (this.model.moveEntry(entry.id, delta)) {
			this.cursor += delta;
			this.notice = `moved ${entry.id} ${delta === -1 ? "up" : "down"}`;
		} else {
			this.notice = "cannot move further";
		}
	}

	private deleteSelected(): void {
		const entry = this.currentEntry();
		if (entry === undefined) return;
		const index = this.cursor;
		const result = this.model.removeEntry(entry.id);
		this.cursor = Math.max(0, Math.min(index, this.model.length - 1));
		this.detailScroll = 0;
		const extra =
			result.removedIds.length > 1
				? ` and ${result.removedIds.length - 1} dependent entr${result.removedIds.length === 2 ? "y" : "ies"}`
				: "";
		this.notice = `deleted ${entry.id}${extra} (undo with ${keyText("app.sessionEdit.undo")})`;
	}

	private duplicateSelected(): void {
		const entry = this.currentEntry();
		if (entry === undefined) return;
		const id = this.model.duplicateEntry(entry.id);
		if (id === undefined) {
			this.notice = "cannot duplicate this entry";
			return;
		}
		this.cursor = this.model.indexOf(id);
		this.notice = `duplicated as ${id}`;
	}

	private addEntry(kind: "user" | "assistant", index: number): void {
		const draft: NewEntryDraft = kind === "user" ? { kind: "user", text: "" } : { kind: "assistant" };
		const id = this.model.insertEntry(index, draft);
		if (id === undefined) {
			this.notice = "cannot add an assistant message before the first model reply";
			return;
		}
		this.cursor = this.model.indexOf(id);
		this.detailScroll = 0;
		this.editSelected();
		if (this.model.indexOf(id) === -1 || isEmptyMessage(this.model.entry(id))) {
			if (this.model.indexOf(id) !== -1) this.model.removeEntry(id);
			this.cursor = Math.max(0, Math.min(this.cursor, this.model.length - 1));
			this.notice = "empty entry discarded";
		}
	}

	private editSelected(): void {
		const entry = this.currentEntry();
		if (entry === undefined) return;
		const text = this.model.entryText(entry.id);
		if (text === undefined) return;
		const result = this.editText(text);
		if (result.error !== undefined) {
			this.notice = `editor failed: ${result.error.message}`;
			return;
		}
		if (result.ran === false) {
			this.notice = "no editor configured; set $VISUAL or $EDITOR";
			return;
		}
		if (result.status !== 0 || result.text === undefined) {
			this.notice = "editor exited without saving";
			return;
		}
		const applied = this.model.applyEntryText(entry.id, result.text);
		const errors = applied.issues.filter((issue) => issue.level === "error");
		if (errors.length > 0) {
			this.notice = errors[0]!.message;
			return;
		}
		if (this.model.indexOf(entry.id) === -1) {
			this.cursor = Math.max(0, Math.min(this.cursor, this.model.length - 1));
			this.notice = `entry ${entry.id} removed`;
		} else {
			this.notice = `updated ${entry.id}`;
		}
	}

	private editWholeDocument(): void {
		const document = this.model.renderDocument();
		const result = this.editText(document);
		if (result.error !== undefined) {
			this.notice = `editor failed: ${result.error.message}`;
			return;
		}
		if (result.ran === false) {
			this.notice = "no editor configured; set $VISUAL or $EDITOR";
			return;
		}
		if (result.status !== 0 || result.text === undefined) {
			this.notice = "editor exited without saving";
			return;
		}
		const parsed = parseSessionDocument(result.text, this.model.allEntries);
		const errors = parsed.issues.filter((issue) => issue.level === "error");
		if (errors.length > 0) {
			this.notice = errors[0]!.message;
			return;
		}
		this.model.replaceAllEntries(parsed.entries);
		this.cursor = Math.max(0, Math.min(this.cursor, this.model.length - 1));
		this.notice = `document applied: ${parsed.stats.edited} edited, ${parsed.stats.added} added, ${parsed.stats.removed} removed`;
	}

	private editText(contents: string): ExternalEditorResult {
		const run = (): ExternalEditorResult => {
			if (this.options.editText !== undefined) return this.options.editText(contents);
			return editTextInExternalEditor({ contents, suffix: ".session.txt" });
		};
		if (this.options.editText !== undefined) return run();
		this.ui.stop();
		try {
			return run();
		} catch (error) {
			return { ran: true, status: null, error: error instanceof Error ? error : new Error(String(error)) };
		} finally {
			this.ui.start();
			this.ui.enterFullscreen({ scroll: [this], dock: this.dock, mouse: false, viewportControls: false });
			this.ui.requestRender(true);
		}
	}

	private save(): void {
		const errors = this.model.issues().filter((issue) => issue.level === "error");
		if (errors.length > 0 && this.options.force !== true) {
			this.notice = `${errors.length} validation error(s); fix them or pass --force (v shows details)`;
			return;
		}
		if (!this.model.dirty) {
			this.notice = "no changes to save";
			return;
		}
		let write: SessionWriteResult;
		try {
			write = this.writer();
		} catch (error) {
			this.notice = error instanceof Error ? error.message : String(error);
			return;
		}
		if (!write.written) {
			this.notice = write.issues.find((issue) => issue.level === "error")?.message ?? "nothing was written";
			return;
		}
		this.model.markSaved();
		this.saved = true;
		this.writes++;
		// A later save must compare against the file this session just wrote.
		if (write.stat !== undefined) this.stat = write.stat;
		if (write.backupPath !== undefined) this.backups.push(write.backupPath);
		const summary = this.model.diffSummary();
		this.notice = `saved ${summary.total} entries${write.backupPath === undefined ? "" : `; backup ${write.backupPath}`}`;
	}

	private writer(): SessionWriteResult {
		if (this.options.writeSession !== undefined) {
			return this.options.writeSession(this.model);
		}
		return writeSessionEntries({
			sessionPath: this.options.sessionPath,
			header: this.model.sessionHeader,
			entries: this.model.allEntries,
			force: this.options.force,
			backup: this.options.backup,
			expectedStat: this.stat,
			agentDir: this.options.agentDir,
			env: this.options.env,
		});
	}

	private requestQuit(): void {
		if (this.model.dirty) {
			this.confirmation = { kind: "quit" };
			this.notice = undefined;
			return;
		}
		this.finish();
	}

	private finish(): void {
		if (this.stopped) return;
		this.stopped = true;
		const terminal = this.ui.terminal;
		const resolve = () => {
			this.ui.stop();
			this.resolveRun?.({ saved: this.saved, writes: this.writes, backups: [...this.backups] });
		};
		if (typeof terminal.drainInput === "function") {
			void terminal
				.drainInput(500)
				.catch(() => undefined)
				.finally(resolve);
			return;
		}
		resolve();
	}

	private renderHeader(width: number): string {
		const state = this.model.dirty ? chalk.yellow("unsaved") : chalk.green("saved");
		const entry = this.currentEntry();
		const position = entry === undefined ? "empty" : `${this.cursor + 1}/${this.model.length}`;
		const issues = this.model.issues().length;
		const search =
			this.searchInput !== undefined
				? chalk.cyan(`/${this.searchInput}`)
				: this.searchQuery === undefined
					? undefined
					: chalk.dim(`/${this.searchQuery}`);
		const parts = [
			chalk.bold("Prime Agent session editor"),
			chalk.dim(this.model.sessionId.slice(-12)),
			`${position} entries`,
			state,
		];
		if (issues > 0) parts.push(chalk.yellow(`${issues} issue(s)`));
		if (search !== undefined) parts.push(search);
		return truncateToWidth(` ${parts.join(chalk.dim(" · "))}`, width);
	}

	private renderList(width: number, height: number): string[] {
		const entries = this.model.allEntries;
		const lines: string[] = [];
		if (entries.length === 0) {
			return [chalk.dim(" (no entries)"), ...Array.from({ length: Math.max(0, height - 1) }, () => "")];
		}
		const start = Math.max(0, Math.min(this.cursor - height + 1, entries.length - height));
		const issueCounts = this.issueCounts();
		for (let index = start; index < Math.min(entries.length, start + height); index++) {
			const entry = entries[index]!;
			const selected = index === this.cursor;
			const marker = selected ? chalk.cyan("▶") : " ";
			const number = String(index + 1).padStart(3);
			const label = describeEntry(entry).padEnd(18);
			const badges = issueCounts.get(entry.id);
			const summary = truncateToWidth(entrySummary(entry), Math.max(8, width - 30));
			const badge = badges === undefined ? "" : chalk.yellow(` ⚠${badges}`);
			const text = ` ${marker} ${chalk.dim(number)} ${selected ? chalk.bold(label) : label} ${summary}${badge}`;
			lines.push(truncateToWidth(text, width));
		}
		while (lines.length < height) lines.push("");
		return lines;
	}

	private issueCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		for (const issue of this.model.issues()) {
			if (issue.entryId === undefined) continue;
			counts.set(issue.entryId, (counts.get(issue.entryId) ?? 0) + 1);
		}
		return counts;
	}

	private renderDetail(width: number, height: number): string[] {
		if (this.helpVisible) return padLines(renderHelpLines(width), height);
		const entry = this.currentEntry();
		if (entry === undefined) return padLines([chalk.dim(" no entry selected")], height);
		const contentWidth = Math.max(10, width - 2);
		const lines: string[] = [];
		lines.push(
			truncateToWidth(
				` ${chalk.bold(describeEntry(entry))} ${chalk.dim(`id=${entry.id} parent=${entry.parentId ?? "-"} time=${entry.timestamp}`)}`,
				width,
			),
		);
		for (const issue of this.model.issues(entry.id)) {
			const color = issue.level === "error" ? chalk.red : chalk.yellow;
			lines.push(truncateToWidth(color(` ⚠ ${issue.message}`), width));
		}
		const body = this.rawJson ? JSON.stringify(entry, null, 2).split("\n") : entryDisplayLines(entry);
		const wrapped = body.flatMap((line) => wrapTextWithAnsi(line, contentWidth));
		const headerRows = lines.length;
		const overflowing = wrapped.length > Math.max(0, height - headerRows - 1);
		// Reserve one row for the scroll indicator whenever the body overflows.
		const bodyRows = Math.max(0, height - headerRows - (overflowing ? 1 : 0));
		const maximum = Math.max(0, wrapped.length - bodyRows);
		this.detailScroll = Math.max(0, Math.min(this.detailScroll, maximum));
		const visible = wrapped.slice(this.detailScroll, this.detailScroll + bodyRows);
		for (const line of visible) lines.push(`  ${line}`);
		if (overflowing && lines.length < height) {
			const hiddenBelow = maximum - this.detailScroll;
			const parts = [
				this.detailScroll > 0 ? `↑ ${this.detailScroll}` : "",
				hiddenBelow > 0 ? `↓ ${hiddenBelow}` : "",
			]
				.filter((part) => part.length > 0)
				.join(" · ");
			lines.push(
				chalk.dim(
					`  [${parts} line(s); ${keyText("app.sessionEdit.detailDown")}/${keyText("app.sessionEdit.detailUp")} to scroll]`,
				),
			);
		}
		return padLines(lines, height).slice(0, height);
	}

	private renderDock(width: number): string[] {
		const confirmation = this.confirmation;
		if (confirmation !== undefined) {
			return [
				truncateToWidth(
					` ${chalk.yellow("Unsaved changes.")} ${keyText("tui.select.confirm")} saves and quits · ${keyText("app.sessionEdit.delete")} discards · ${keyText("tui.select.cancel")} cancels`,
					width,
				),
				truncateToWidth(chalk.dim(` ${this.model.length} entries`), width),
			];
		}
		const status =
			this.notice ??
			`${this.model.dirty ? chalk.yellow("unsaved changes") : chalk.green("saved")} · ${this.model.length} entries`;
		const hints = [
			`${keyText("app.sessionEdit.edit")} edit`,
			`${keyText("app.sessionEdit.delete")} delete`,
			`${keyText("app.sessionEdit.append")} insert`,
			`${keyText("app.sessionEdit.moveDown")}/${keyText("app.sessionEdit.moveUp")} move`,
			`${keyText("app.sessionEdit.undo")} undo`,
			`${keyText("app.sessionEdit.save")} save`,
			`${keyText("app.sessionEdit.help")} keys`,
			`${keyText("app.sessionEdit.quit")} quit`,
		].join(chalk.dim(" · "));
		return [truncateToWidth(` ${status}`, width), truncateToWidth(chalk.dim(` ${hints}`), width)];
	}
}

function isEmptyMessage(entry: SessionEntry | undefined): boolean {
	if (entry?.type !== "message") return false;
	const message = entry.message;
	if (message.role === "assistant") return message.content.length === 0;
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content.trim().length === 0;
		return message.content.every((block) => block.type === "text" && block.text.trim().length === 0);
	}
	return false;
}

function entrySummary(entry: SessionEntry): string {
	if (entry.type === "model_change") return `${entry.provider}/${entry.modelId}`;
	if (entry.type === "thinking_level_change") return String(entry.thinkingLevel ?? "");
	if (entry.type === "service_tier_change") return String(entry.serviceTier ?? "default");
	if (entry.type === "session_state") return String((entry.state as { status?: unknown } | undefined)?.status ?? "");
	if (entry.type === "session_info") return entry.name ?? "";
	if (entry.type === "label") return `${entry.targetId}${entry.label === undefined ? "" : ` → ${entry.label}`}`;
	if (entry.type === "compaction") return `${firstLine(entry.summary)} (${entry.tokensBefore} tokens before)`;
	if (entry.type === "branch_summary") return `${firstLine(entry.summary)} (from ${entry.fromId})`;
	if (entry.type === "custom_message") return `${entry.customType}: ${firstLine(contentText(entry.content))}`;
	if (entry.type === "custom") return String(entry.customType ?? "");
	if (entry.type === "agent_status") {
		return firstLine((entry.status as { summary?: unknown } | undefined)?.summary);
	}
	if (entry.type === "child_usage_attributed") return `→ ${entry.targetId}`;
	if (entry.type !== "message") return "";
	const message = entry.message as { role?: unknown; content?: unknown } | undefined;
	if (message === undefined || typeof message.role !== "string") return "(malformed entry)";
	if (message.role === "user") {
		return firstLine(contentText(message.content)) || "(empty)";
	}
	if (message.role === "assistant") {
		const blocks = Array.isArray(message.content) ? message.content : [];
		const text = firstLine(
			blocks
				.filter((block) => block?.type === "text")
				.map((block) => (block as { text?: unknown }).text)
				.join(" "),
		);
		const tools = blocks
			.filter((block) => block?.type === "toolCall")
			.map((block) => String((block as { name?: unknown }).name ?? "tool"));
		const reasoning = blocks.some((block) => block?.type === "thinking") ? "reasoning" : "";
		const parts = [text || "(no text)", tools.length > 0 ? `tools: ${tools.join(",")}` : "", reasoning].filter(
			Boolean,
		);
		return parts.join(" · ");
	}
	if (message.role === "toolResult") {
		const text = contentText(message.content);
		return firstLine(text) || "(empty)";
	}
	if (message.role === "custom") {
		const customType = String((message as { customType?: unknown }).customType ?? "custom");
		return `${customType}: ${firstLine(contentText(message.content))}`;
	}
	if (message.role === "bashExecution") {
		return firstLine((message as { command?: unknown }).command);
	}
	return String(message.role);
}

function matchesSearch(entry: SessionEntry | undefined, query: string): boolean {
	if (entry === undefined) return false;
	return JSON.stringify(entry).toLowerCase().includes(query.toLowerCase());
}

function firstLine(value: unknown): string {
	const text = typeof value === "string" ? value : "";
	const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
	return line.trim().slice(0, 160);
}

/** Flattens string or block content without assuming either shape. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text"
				? String((block as { text?: unknown }).text ?? "")
				: "[image]",
		)
		.join(" ");
}

/** Human-readable view of one entry block: section headings plus indented bodies. */
function entryDisplayLines(entry: SessionEntry): string[] {
	const lines: string[] = [];
	let inSection = false;
	for (const line of renderEntryBlock(entry).split("\n")) {
		if (!line.startsWith(`${SESSION_DOCUMENT_MARKER} `)) {
			lines.push(inSection ? `    ${line}` : line);
			continue;
		}
		inSection = true;
		const [head, ...rest] = line.slice(SESSION_DOCUMENT_MARKER.length + 1).split(" ");
		if (head === "entry") continue;
		const attrs = rest.join(" ").trim();
		lines.push(`── ${head}${attrs.length > 0 ? ` ${attrs}` : ""} `.padEnd(24, "─"));
	}
	return lines;
}

function renderHelpLines(width: number): string[] {
	const rows: Array<[Keybinding, string]> = [
		["app.sessionEdit.up", "select previous entry"],
		["app.sessionEdit.down", "select next entry"],
		["app.sessionEdit.top", "first entry"],
		["app.sessionEdit.bottom", "last entry"],
		["app.sessionEdit.edit", "edit the selected entry in $EDITOR"],
		["app.sessionEdit.delete", "delete the entry (dependent entries follow)"],
		["app.sessionEdit.insert", "insert a user message before the selection"],
		["app.sessionEdit.append", "add a user message after the selection"],
		["app.sessionEdit.appendAssistant", "add an assistant message after the selection"],
		["app.sessionEdit.duplicate", "duplicate the selected entry"],
		["app.sessionEdit.moveUp", "move the selected entry up"],
		["app.sessionEdit.moveDown", "move the selected entry down"],
		["app.sessionEdit.undo", "undo the last edit"],
		["app.sessionEdit.redo", "redo the last undone edit"],
		["app.sessionEdit.save", "validate, back up, and write the session"],
		["app.sessionEdit.details", "toggle raw JSON details"],
		["app.sessionEdit.document", "edit the whole transcript document"],
		["app.sessionEdit.search", "search the transcript"],
		["app.sessionEdit.searchNext", "jump to the next search match"],
		["app.sessionEdit.searchPrevious", "jump to the previous search match"],
		["app.sessionEdit.help", "show these keys"],
		["app.sessionEdit.quit", "quit the editor"],
	];
	return [
		chalk.bold(" Keys"),
		...rows.map(([binding, description]) =>
			truncateToWidth(`   ${keyText(binding).padEnd(10)} ${description}`, width),
		),
	];
}

function padLines(lines: readonly string[], height: number): string[] {
	const padded = [...lines];
	while (padded.length < height) padded.push("");
	return padded;
}
