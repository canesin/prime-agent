# Sessions

Prime Agent saves conversations as sessions so you can continue work, branch from earlier turns, and revisit previous paths.

## Session Storage

Sessions auto-save to `~/.prime/agent/sessions/`. Each session is a JSONL file with a tree structure.

```bash
prime-agent --continue          # Continue the most recent session
prime-agent --resume [path|id]  # Browse past sessions or resume one directly
prime-agent --no-session        # Ephemeral mode; do not save
prime-agent --fork <path|id>    # Fork a session file or partial session ID into a new session
```

Use `/session` in interactive mode to see the current session file, session ID, and message count. Use `/usage` for token, cost, and context usage.

For the JSONL file format and SessionManager API, see [Session Format](session-format.md).

## Session Commands

| Command | Description |
|---------|-------------|
| `/resume` | Browse and select previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set the current session display name |
| `/session` | Show session info |
| `/usage` | Show token, cost, and context usage |
| `/tree` | Navigate the current session tree |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Summarize older context; see [Compaction](compaction.md) |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |

## Resuming and Deleting Sessions

`/resume` opens an interactive session picker for the current project. `prime-agent --resume` opens the same picker at startup, and `prime-agent --resume <path|id>` resumes a specific session.

An invalid ID exits with the closest unambiguous session ID when one is available. To open the picker and send an initial prompt after selecting a session, separate the prompt with `--`: `prime-agent --resume -- "continue this work"`.

In the picker you can:

- search by typing
- toggle path display with Ctrl+P
- toggle sort mode with Ctrl+S
- filter to named sessions with Ctrl+N
- rename with Ctrl+R
- delete with Ctrl+D, then confirm

When available, Prime Agent uses the `trash` CLI for deletion instead of permanently removing files.

## Editing Session Transcripts

`prime-agent session edit [selector]` opens an interactive transcript editor for a saved session. The selector accepts a session ID or partial ID, a session name, or a `.jsonl` path; without a selector the most recent session for the current directory is used. The editor refuses a session that is active in another agent unless `--force` is passed.

```bash
prime-agent session edit                            # interactive editor for the most recent session
prime-agent session edit 01a0f899                   # by session ID prefix
prime-agent session edit my-agent                   # by session name
prime-agent session edit --print > transcript.txt   # print the lossless transcript document
prime-agent session edit --text                     # edit the transcript as one document in $EDITOR
prime-agent session edit --document transcript.txt  # apply a saved document
```

The editor lists every entry in flow order with its role, a summary, and a badge when validation flags it. Keys are configurable through `keybindings.json`; the defaults are:

| Key | Action |
|-----|--------|
| `Up`/`Down`, `k`/`j` | Select the previous or next entry |
| `g` / `End` | Select the first or last entry |
| `e` | Edit the selected entry in `$VISUAL`/`$EDITOR` |
| `d` | Delete the selected entry (dependent tool results follow) |
| `i` / `o` | Insert a user message before or after the selection |
| `alt+a` | Add an assistant message after the selection |
| `c` | Duplicate the selected entry |
| `Shift+Up` / `Shift+Down` | Move the selected entry up or down |
| `u` / `Ctrl+R` | Undo or redo the last edit |
| `v` | Toggle raw JSON details for the selected entry |
| `Ctrl+S` | Validate, back up, and write the session |
| `Ctrl+E` | Edit the whole transcript as one document |
| `?` | Show every key |
| `q` | Quit; unsaved changes ask before they are discarded |

Structure stays consistent without manual bookkeeping: new entries get fresh IDs and timestamps, the parent chain is rebuilt after deletes and moves, deleting a model reply also removes the tool results that answered it, compaction boundaries are retargeted, and labels or usage attributions for removed entries are dropped. Saving validates the full flow before writing, so a tool call without its result is reported instead of silently persisted.

Every write copies the session to `<file>.bak-<timestamp>` first and stops if the file changed on disk while the editor was open.

### Editing the transcript as a document

`--print` writes the same transcript as a lossless, line-oriented document, and `--text` opens that document in `$EDITOR`. Each block maps to one session entry and each section inside a block maps to one piece of it:

```text
@@@@ entry 8caa7d33 type=message time=2026-10-01T17:53:07.907Z role=assistant provider=deepseek model=deepseek-v4-flash stop=toolUse
@@@@ reasoning index=0
I should check the session file first.
@@@@ assistant index=1
Reading the header now.
@@@@ tool_call index=2 id=call_00_abc name=ipython
{
  "code": "print(1 + 1)"
}
```

User text, assistant text, reasoning, tool-call arguments, tool results, compaction summaries, and custom messages are editable. Deleting a block removes the entry, moving blocks reorders the message flow, and `@@@@ new user`, `@@@@ new assistant`, and `@@@@ new toolResult call=<id>` insert entries. Structural errors (unknown entry IDs, an entry type that does not match the file, invalid tool-call JSON, an invalid timestamp) block the write; flow issues (a tool call without a matching result, a result without a call, a compaction that keeps a deleted entry) are warnings. Nothing is written when the document has no changes.

`--dry-run` validates without writing, `--force` writes despite errors or an active session, `--no-backup` skips the copy, `--keep-temp` keeps the generated document, and `--json` prints machine-readable output.

## Naming Sessions

Use `/name <name>` to set a human-readable session name:

```text
/name Refactor auth module
```

Named sessions are easier to find in `/resume` and `prime-agent --resume`.

## Branching with `/tree`

Sessions are stored as trees. Every entry has an `id` and `parentId`, and the current position is the active leaf. `/tree` lets you jump to any previous point and continue from there without creating a new file.

<p align="center"><img src="images/tree-view.png" alt="Tree View" width="600"></p>

Example shape:

```text
├─ user: "Hello, can you help..."
│  └─ assistant: "Of course! I can..."
│     ├─ user: "Let's try approach A..."
│     │  └─ assistant: "For approach A..."
│     │     └─ user: "That worked..."  ← active
│     └─ user: "Actually, approach B..."
│        └─ assistant: "For approach B..."
```

### Tree Controls

| Key | Action |
|-----|--------|
| ↑/↓ | Navigate visible entries |
| ←/→ | Page up/down |
| Ctrl+←/Ctrl+→ or Alt+←/Alt+→ | Fold/unfold or jump between branch segments |
| Shift+L | Set or clear a label on the selected entry |
| Shift+T | Toggle label timestamps |
| Enter | Select entry |
| Escape/Ctrl+C | Cancel |
| Ctrl+O | Cycle filter mode |

Filter modes are: default, no-tools, user-only, labeled-only, and all. Configure the default with `treeFilterMode` in [Settings](settings.md).

### Selection Behavior

Selecting a user or custom message:

1. Moves the leaf to the selected message's parent.
2. Places the selected message text in the editor.
3. Lets you edit and resubmit, creating a new branch.

Selecting an assistant, tool, compaction, or other non-user entry:

1. Moves the leaf to that entry.
2. Leaves the editor empty.
3. Lets you continue from that point.

Selecting the root user message resets the leaf to an empty conversation and places the original prompt in the editor.

## `/tree`, `/fork`, and `/clone`

| Feature | `/tree` | `/fork` | `/clone` |
|---------|---------|---------|----------|
| Output | Same session file | New session file | New session file |
| View | Full tree | User-message selector | Current active branch |
| Typical use | Explore alternatives in place | Start a new session from an earlier prompt | Duplicate current work before continuing |
| Summary | Optional branch summary | None | None |

Use `/tree` when you want to keep alternatives together. Use `/fork` or `/clone` when you want a separate session file.

## Branch Summaries

When `/tree` switches away from one branch to another, Prime Agent can summarize the abandoned branch and attach that summary at the new position. This preserves important context from the path you left without replaying the whole branch.

When prompted, choose one of:

1. no summary
2. summarize with the default prompt
3. summarize with custom focus instructions

See [Compaction](compaction.md) for branch summarization internals and extension hooks.

## Session Format

Session files are JSONL and contain message entries, model changes, thinking-level changes, labels, compactions, branch summaries, and extension entries.

For parsers, extensions, SDK usage, and the full SessionManager API, see [Session Format](session-format.md).
