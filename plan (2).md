# Development Plan: Permission-Aware Task Execution for pi-implement

## Goal

Prevent `pi-implement` from advancing to the next task when the active Pi agent is waiting for user authorization, a permission-gated tool has been denied, or the agent ends without confirming that the current task is complete.

When a permission dialog is open, keep the current agent execution alive until the dialog resolves. If the agent ends while still blocked, persist a paused workflow that can be resumed explicitly from the same task. Never create a success checkpoint or start the next task until completion is confirmed.

## Existing implementation and root cause

Repository: https://github.com/erathaowl/pi-implement (reviewed on 2026-11-11, package version `0.2.6`, default branch `master`).

- `src/executor.ts`: `ActiveSessionExecutor` waits for `agent_settled` and accepts any last assistant response with `stopReason === "stop"` as successful execution. `execute()` returns no task-specific result.
- `src/index.ts`: `executeTaskSet()` immediately marks the task completed, increments `nextTaskIndex`, and optionally creates a Git checkpoint after `executor.execute()` resolves.
- `src/tasks.ts`: `buildTaskFilePrompt()` asks the model to implement one task but does not require an explicit completion or waiting-for-approval result.
- `src/state.ts`: persisted workflow status supports `running` and `failed`; the UI task status supports `pending`, `running`, `completed`, and `failed`.
- `tests/executor.test.ts`: current tests explicitly allow `stop` even when the assistant returns no final text.

**Root cause:** Pi's agent-turn completion is treated as proof of task completion. A normal `stop` indicates that the agent stopped responding; it does not establish that the requested work was finished.

Relevant Pi API documentation: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md . In particular, `agent_settled` marks the end of automatic activity; `ui_prompt_start`/`ui_prompt_end` describe blocking extension UI prompts; and `tool_result` provides tool error information. Verify the event signatures against the installed `@earendil-works/pi-coding-agent` version before coding.

## Required behavior

1. **Waiting for a live permission prompt:** while the agent's tool call is awaiting `ctx.ui.confirm()`, `select()`, or another supported user prompt, remain on the current task. Display a waiting indicator. On approval, let Pi continue the same agent turn naturally. Do not send a duplicate task prompt.
2. **Permission request with a settled agent:** if the agent ends requesting user action, persist `paused` state with the current `nextTaskIndex`, the reason, and useful non-sensitive context. Stop the task loop without a success checkpoint, compaction, or review.
3. **Explicitly completed task:** advance once only after a successful agent stop and a validated task-completion result, without an unresolved authorization blocker.
4. **Other incomplete outcomes:** if the agent stops normally without a valid completion result, leave the task unfinished and pause for inspection rather than treating it as successful. Continue to report model failures, aborts, and truncation as failures under the existing recovery rules.
5. **Resume:** require an explicit user action using the existing `/implement-tasks` or `/implement-plan` recovery flow. Keep the saved model, thinking level, task index, source files, and Git settings. Resume the unfinished task without blindly assuming prior file changes must be reapplied.
6. **Safety and compatibility:** authorization is always controlled by the existing permission system; `pi-implement` must not auto-approve requests, bypass checks, or retry blocked actions automatically. Preserve existing version-1 and version-2 state migration and checkpoint recovery behavior.

## Implementation tasks

### Task 1: Add a strict, small task-result contract

**Files:** `src/tasks.ts`, `src/executor.ts`, `tests/tasks.test.ts`, `tests/executor.test.ts`.

- Extend `buildTaskFilePrompt()` so the agent must end its final assistant message with exactly one machine-readable result block, using distinct markers such as `<<<PI_IMPLEMENT_TASK_RESULT>>>` and `<<<END_PI_IMPLEMENT_TASK_RESULT>>>`.
- Require a minimal JSON object with `status: "completed" | "waiting_for_user"`, the current task number, and an optional short `reason` when waiting. Instruct the model to report `completed` only after implementing and checking the task. When authorization is needed, it should report `waiting_for_user` and explain the required action.
- Add a narrowly scoped parser/validator for the **final assistant text**. Reject missing, malformed, duplicated, contradictory, or wrong-task result blocks. Ignore matching text inside tool outputs or earlier assistant messages.
- Add `executeTask(prompt, taskNumber)` to `ActiveSessionExecutor` returning a typed outcome. Preserve `executeForText()` for final review and the established `agent_settled` barrier.
- Check `stopReason` and `agent_settled.aborted` before accepting completion. A missing result must never silently count as success.
- Keep the protocol focused on task completion; do not build a general-purpose LLM message parser.

**Acceptance:** a bare `stop`, an approval request, or malformed output cannot resolve as a completed task; a validated `completed` outcome can.

### Task 2: Observe blocking user prompts and relevant tool results

**Files:** `src/executor.ts`, `src/index.ts`, `tests/executor.test.ts`.

- Subscribe to Pi's `ui_prompt_start` and `ui_prompt_end` events, scoped to the currently executing task, and expose a transient `waitingForUser` signal for the progress UI. These events are observational: the executor still waits for the agent lifecycle to settle.
- Clear the waiting indicator when the prompt closes, the task settles, or the session shuts down.
- Observe `tool_result` for blocked/denied permission outcomes where the installed Pi version or permission extension exposes an identifiable signal. Prefer structured details or documented error contracts; avoid treating every `isError` result as a permission request.
- Where no stable permission-specific result exists, rely on the explicit final task result and the conservative missing-result rule. Do not guess that an arbitrary error or an assistant's ordinary mention of permission is an active approval dialog.
- Track signals only for the active task. Avoid leaking events from setup dialogs, review, or later turns into another task's outcome. Account for tool results arriving in completion order during parallel execution.

**Acceptance:** a pending `ctx.ui.confirm()` never triggers progression, and permission signals cannot be mistaken for task success.

### Task 3: Persist a paused workflow without losing recovery compatibility

**Files:** `src/state.ts`, `src/index.ts`, `tests/state.test.ts`, `tests/recovery.test.ts`.

- Extend the existing version-2 state schema with `status: "paused"` and an optional `pause` object containing a bounded, non-sensitive reason and type (`approval_required` or `completion_unconfirmed`). Avoid a schema-version increment unless existing readers cannot handle additive fields.
- Validate that a paused workflow is in phase `tasks`, has `nextTaskIndex < tasks.length`, and has no newly created successful task checkpoint. Keep the original task index.
- On resume, clear `pause` only when execution of that same task begins. A subsequent stop may persist a new pause.
- Preserve migration of legacy state and all existing checkpoint/compaction recovery metadata. Do not write approval tokens, credentials, or complete sensitive tool inputs to the state file.

**Acceptance:** restart and reload retain the exact unfinished task and reason, and old state files still load.

### Task 4: Gate task advancement and show pause status

**Files:** `src/index.ts`, `src/executor.ts`.

- Replace the unconditional success path following `executor.execute()` in `executeTaskSet()` with a switch on the validated typed result.
- For `completed`: keep the existing sequence of progress update, `nextTaskIndex` increment, state save, optional Git checkpoint, and between-task compaction.
- For `waiting_for_user` or `completion_unconfirmed`: mark the current task paused, save state, notify the user of the required action, and return from `executeTaskSet()` before the success path.
- Add a `paused` symbol/label in `formatProgress()` and a transient `Waiting for user authorization` working message during an open UI prompt. Distinguish an actual approval request from an unconfirmed completion in the notification text.
- Preserve the existing failure path for rejected execution, provider errors, cancellation, and truncation.
- Ensure the final review cannot start while a task is paused.

**Acceptance:** a paused task leaves `nextTaskIndex` unchanged; no task commit, compaction, next prompt, or review is triggered.

### Task 5: Resume the interrupted task deliberately

**Files:** `src/index.ts`, `src/tasks.ts`, `tests/index.test.ts`, `tests/recovery.test.ts`.

- Reuse the existing Resume/Cancel confirmation and saved configuration. Display the pause reason prominently in the recovery summary.
- When resuming a paused task, submit a continuation instruction referencing the saved source task. Tell the agent to inspect already applied changes, finish outstanding work, and avoid repeating completed side effects; require the same final result contract.
- Keep `nextTaskIndex` unchanged until this continuation completes successfully.
- If the original permission prompt remains open within the same running agent turn, **do not** invoke a second prompt: wait for that turn to finish. The explicit recovery path is for an agent that has already settled or a restarted session.
- If user authorization was refused or a permission rule still blocks the operation, return to paused state; never loop retries automatically.

**Acceptance:** one explicit Resume restarts work only on the unfinished task, preserves its prior changes, and advances once after valid completion.

### Task 6: Regression tests, documentation, and live validation

**Files:** `tests/executor.test.ts`, `tests/index.test.ts`, `tests/state.test.ts`, `tests/recovery.test.ts`, `tests/tasks.test.ts`, `README.md`, and `VALIDATION.md` if applicable.

Automated cases:

1. UI approval prompt remains open: no next task, commit, compaction, or review.
2. Approval granted during the current turn: Pi finishes the tool, the task emits `completed`, and the next task starts exactly once.
3. Permission denied or approval deferred: task is paused and persisted with its original index.
4. Normal `stop` with no result, incorrect result task number, or malformed result: no advancement.
5. Normal `stop` with validated `completed`: unchanged happy-path ordering and Git checkpoint behavior.
6. Provider error, abort, truncation, or session shutdown: original failure/recovery rules remain intact.
7. Explicit Resume after pause: one continuation prompt, no duplicated task commits, no automatic permission bypass.
8. Repeated pauses, different permission-extension tool results, multiple tool calls, and recovery after process restart.
9. Legacy state migration and existing final-review tests still pass. Update fake agent messages in tests to emit the new task-result contract instead of relying on empty `stop` responses.
10. Unrelated tool failure that the model handles successfully must not be misclassified as a permission wait.

Run:

```bash
npm test
npm run typecheck
```

Perform a manual interactive smoke test with the installed Pi version and the actual permission extension in use. Include approve, deny, cancel, and deferred approval on both Linux and Windows where supported. Confirm real UI event availability and event ordering before relying on these hooks.

## Implementation order and scope

Implement Tasks 1 through 6 sequentially, keeping the existing active-session architecture and local Git-only behavior. Do not introduce a subagent, background worker, polling loop, process manager, new dependency, or automatic permission grant. Keep the final-review result protocol unchanged except where tests need to distinguish it from the new task-result protocol.

## Definition of done

- A task advances only after an explicit, validated completion result from a successfully settled agent turn.
- A pending approval dialog holds execution on the same task.
- A settled turn waiting on authorization, or with unconfirmed completion, pauses durably and reports why.
- No checkpoint, compaction, next task, or review starts while a task is paused.
- Resume retains the correct task index and settings without forcing automatic retries or permission changes.
- Existing task, review, Git, compaction, and legacy recovery tests pass; the required live permission flow is manually validated.
