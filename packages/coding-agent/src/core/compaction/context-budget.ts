import type { Model } from "@earendil-works/pi-ai";

/** Leave space for provider framing and tokenization differences. Text is budgeted in UTF-8 bytes. */
export function summaryBudget(
	model: Model<string>,
	requestedOutput: number,
): { maxTokens: number; maxInputBytes: number } {
	const window = Math.floor(model.contextWindow * 0.9);
	const maxTokens = Math.max(1, Math.min(Math.floor(requestedOutput), model.maxTokens, Math.floor(window / 4)));
	// A token is at least one byte, so a byte budget equal to the token budget can never overflow.
	const maxInputBytes = window - maxTokens - 512;
	if (maxInputBytes < 1024) throw new Error("Model context window is too small for compaction");
	return { maxTokens, maxInputBytes };
}

export function truncateUtf8(text: string, maxBytes: number, keepEnd = false): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	if (maxBytes <= 0) return "";
	// Decode complete code points only; a replacement character would consume extra bytes.
	if (keepEnd) {
		let start = bytes.length - maxBytes;
		while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
		return bytes.subarray(start).toString("utf8");
	}
	let end = maxBytes;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

/** Keep both ends of an over-long summary: its goal leads and its next steps close it. */
function truncateMiddleUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const marker = "\n[... earlier summary details omitted ...]\n";
	const available = maxBytes - Buffer.byteLength(marker);
	if (available <= 0) return truncateUtf8(text, maxBytes, true);
	const head = truncateUtf8(text, Math.floor(available / 2));
	return `${head}${marker}${truncateUtf8(text, available - Buffer.byteLength(head), true)}`;
}

/**
 * Retain whole recent messages where possible, and disclose any omitted prefix. `render` builds the
 * complete prompt from the retained conversation text and previous summary, so the request shape is
 * owned by the caller's prompt builder.
 */
export function boundedSummaryPrompt(
	conversations: string[],
	render: (conversation: string, previousSummary: string | undefined) => string,
	previousSummary: string | undefined,
	maxBytes: number,
): string {
	const omission = "[Older history omitted from this request; consult rlm.history in the session to recover it.]\n";
	const overhead = Buffer.byteLength(render(omission, previousSummary ? " " : undefined));
	if (overhead >= maxBytes) throw new Error("Compaction instructions exceed the model context budget; shorten them");
	let remaining = maxBytes - overhead;
	const previous = previousSummary ? truncateMiddleUtf8(previousSummary, Math.floor(remaining / 3)) : undefined;
	remaining -= Buffer.byteLength(previous ?? "");
	const selected: string[] = [];
	let omitted = false;
	for (let i = conversations.length - 1; i >= 0; i--) {
		const text = conversations[i];
		const bytes = Buffer.byteLength(text) + 2;
		if (bytes > remaining) {
			// Include a suffix even when a single message is larger than the window.
			if (selected.length === 0) selected.unshift(truncateUtf8(text, Math.max(0, remaining - 2), true));
			omitted = true;
			break;
		}
		selected.unshift(text);
		remaining -= bytes;
	}
	return render(`${omitted ? omission : ""}${selected.join("\n\n")}`, previous);
}
