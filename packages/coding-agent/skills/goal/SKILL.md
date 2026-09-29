---
name: goal
description: Manage the persistent thread goal from the Python REPL. Use to read goal status and budget usage, to start a goal when the user explicitly asks for one, to pause a blocked goal with a reason, or to mark the active goal complete once its objective is fully achieved.
---

# Goal

The thread goal is a persistent objective the harness keeps re-prompting you to
pursue across turns until it is complete or paused. Goal state (status, token budget,
usage accounting) lives in the host; this skill is the kernel-side interface to
it. Call it directly from the Python REPL:

```python
await goal.get()
await goal.create("ship the release notes")
# Only pass token_budget when the user explicitly asks for one:
# await goal.create("ship the release notes", token_budget=200000)
await goal.pause("Waiting for independent approval of the pull request.")
# Only after the objective is achieved:
await goal.complete()
```

## API

- `await goal.get()` — current goal as a dict: `goal` (or `None` when no goal
  is set), `remaining_tokens`, and `completion_budget_report`. The `goal` dict
  carries `objective`, `status`, `token_budget`, `tokens_used`,
  `time_used_seconds`, and timestamps.
- `await goal.create(objective, token_budget=None)` — start a new active goal.
  Fails while a goal is still pending (active, paused, or budget-limited); a
  completed or errored goal is replaced by the new one. Only create a goal when
  the user or system/developer instructions explicitly ask for a persistent
  long-running goal; do not infer goals from ordinary tasks. Set `token_budget`
  only when an explicit token budget is requested.
- `await goal.pause(reason)` — pause an incomplete active goal that cannot make
  progress without external input. Supply a concrete reason of 1–1000 characters.
  The objective and usage are preserved. The user resumes with `/goal resume`.
  Repeating a pause on an already-paused goal is safe. Other inactive states
  cannot be paused.
- `await goal.complete()` — mark the existing goal achieved. Use only when the
  objective has actually been achieved and no required work remains; do not
  call it merely because the budget is nearly exhausted or because you are
  stopping work. When the result includes a `completion_budget_report`, report
  that final usage to the user.

## Rules

- Pause when approval, permission, credentials, or another external dependency
  prevents further useful work. Explain the blocker and next action once. Do not
  repeatedly report the same blocker or mark incomplete work complete.
- Do not pause merely because tracked background commands or child agents are
  still working. End the turn and wait for their completion event.
- Resume, clear, and budget-limit transitions remain user/host-controlled; there
  is no model API for them. Ordinary user messages do not resume a paused goal.
- The host pauses after three consecutive completed cycles without tool
  execution. This safety bound can also pause productive text-only work; use
  `/goal resume` to continue. It does not detect arbitrary tool-polling loops.
- When an active goal is actually complete, call `await goal.complete()`; do
  not merely say it is done — the harness keeps continuing the goal until the
  completion call arrives.
