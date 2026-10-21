# pi-implement: Final Review and Mandatory Confirmation Tasks

## Shared Instructions

Implement these tasks **in order** in the existing `pi-implement` repository. Read `plan.md` for the complete requirements, constraints, and acceptance criteria. This file defines the implementation sequence; do not reinterpret the plan to add unrelated features.

- Keep TypeScript changes small, readable, and consistent with the existing extension and pi SDK.
- Reuse the current model controller, agent lifecycle executor, preview UI, Git helper, and state persistence where practical.
- Keep all source code, comments, messages, and tests in English.
- Do not add runtime dependencies unless absolutely necessary.
- Do not perform remote Git operations or create Git commits from implementation task prompts. The workflow owns checkpoints.
- Preserve existing `/implement-tasks` and `/implement-plan` behavior except where explicitly changed.
- **Every task:** add or update focused automated tests, run the relevant tests and `npm run typecheck`, and address failures before moving on.
- Avoid adding a second review engine or a new orchestration framework.
- Treat a review finding as verified only if backed by inspected files or executed checks.

## Task 1 - Separate Read-Only Preparation from Mutating Setup

Refactor workflow configuration so collecting options does not create branches, commit changes, change `.gitignore`, write state, or overwrite task documents. For `/implement-plan`, generate and index the future `tasks.md` in memory and defer its write. Capture whether the destination exists and whether it was approved for overwrite; revalidate the destination before writing. Keep the existing dirty-state checkpoint behavior available for the execution phase.

**Acceptance criteria**

- Task indexing and plan conversion can complete without changing repository files.
- Selecting Git checkpoint mode and entering a new branch name does not create the branch immediately.
- No initial dirty-state commit occurs during option selection.
- If the user cancels preparation, the branch, worktree, `tasks.md`, and `.gitignore` remain unchanged.
- Existing implementation paths still work after setup is explicitly started.

**Tests:** isolated preparation and cancellation; existing `tasks.md` overwrite deferred; clean/dirty Git preflight without commits.

## Task 2 - Implement a Height-Aware Execution Summary UI

Extend/reuse `src/preview.ts` to show a formatted read-only summary with a fixed visible action area. Include command, working directory, source plan/tasks, task count, implementation model/thinking, branch/checkpoint choice, initial commit intent, compaction/threshold, review enabled state, and review model/thinking when relevant. Show pending `tasks.md` overwrite and `.gitignore` changes.

Use `Start implementation / Cancel` for new runs and `Resume / Cancel` when restarting. Support TUI scrolling and non-TUI interactive UI. Follow the existing PageUp/PageDown, arrow, Enter, and cancel behavior. Ensure the selected/default action is explicit, rather than relying on assumptions about a generic UI default.

**Acceptance criteria**

- The summary is always shown, including with final review disabled.
- The action choices remain visible when the summary exceeds terminal height.
- Both TUI and non-TUI interactive modes can confirm or cancel.
- Cancellation performs no execution or Git/filesystem mutation.

**Tests:** formatting with review on/off, long text wrapping, small terminal height, navigation, action selection, and cancellation.

## Task 3 - Make Confirmation the Actual Start Boundary

Integrate the Task 2 summary into both new workflows and the existing-state decision path. Defer the effects of `Discard and start new` until a replacement run has been confirmed. After confirmation, perform the deferred setup operations in a predictable order. Detect changed target files/branch assumptions since preview and abort with a useful error instead of overwriting external changes.

Avoid introducing an unrecoverable gap between confirming and setting up an implementation. Prepare to persist setup intent and in-memory generated task content as part of the expanded state model in Task 4.

**Acceptance criteria**

- Neither command mutates the project before the confirmation action.
- Cancelling after choosing `Discard and start new` preserves the old recovery state.
- A changed task target is not overwritten without the recorded consent matching the current target.
- Only a confirmed workflow can create a branch, make an initial commit, update `.gitignore`, or write `tasks.md`.

**Tests:** both commands, pending old state, branch creation, dirty worktree, changed overwrite target, and aborted confirmation.

## Task 4 - Extend State for Setup, Review, and Backward Compatibility

Introduce a versioned state schema with an explicit phase, deferred setup metadata, optional original-plan path, optional prepared task content, review settings/result, and pending checkpoint metadata. Add loading/migration from existing version-1 state files, treating them as review-disabled workflows. Preserve their task progress and pending Git/compaction behavior.

Persist transitions before interruptible operations and recover setup idempotently. Record checkpoint purpose/message instead of always deriving it from the previous task index. Keep state writes atomic and the state file out of all Git checkpoints, including the initial dirty-worktree commit.

**Acceptance criteria**

- Existing version-1 state can still resume without new review prompts.
- New state encodes setup, tasks, review, review checkpoint, and completion without ambiguous inference from task count.
- A crash during setup or checkpoint can be resumed without repeating a completed destructive operation.
- Invalid state fails with a clear error; changing the working directory or Git branch unexpectedly remains a guarded condition.

**Tests:** migration, schema validation, pending operations, setup interruption, initial checkpoint exclusion, and resume after branch creation.

## Task 5 - Preserve Source Plan Provenance

Store the original plan path for `/implement-plan` and the task-file path separately. For `/implement-tasks`, when review is enabled, allow the user to provide an optional reference plan Markdown path; leaving it blank is valid. Validate supplied files and retain paths for a later review. Record the absence of a source plan explicitly rather than guessing one.

**Acceptance criteria**

- `/implement-plan` review uses the original plan and generated task file.
- `/implement-tasks` review can use an explicitly supplied plan or only its task source.
- A missing plan is represented as a limitation in compliance reporting.
- Review-disabled workflows do not add a plan-path prompt.

**Tests:** both commands, omitted path, malformed/missing Markdown input, saved and restored provenance.

## Task 6 - Add Persistent Review Model and Thinking Preferences

Extract reusable model/thinking selection logic from `src/model.ts` without changing current implementation defaults. Add independent review model/thinking selection, querying only when review is enabled. Introduce a user-scoped preference store (`src/preferences.ts`) using a supported Pi user configuration location. Prefer the last confirmed review pair; otherwise propose the selected implementation pair. Validate supported thinking levels and fall back to an explicit selection if a saved preference is unavailable.

Persist the preference **only after the user confirms the summary**. For recovery, enforce the exact model/thinking pair in the saved workflow state, with a clear error when it cannot be restored.

**Acceptance criteria**

- Implementation and review model/thinking values can differ.
- A later run proposes the previous confirmed review pair across repositories.
- Cancelled configuration does not update preferences.
- Unavailable or incompatible saved preferences never cause silent recovery substitutions.
- Review-disabled runs do not show review-model prompts.

**Tests:** first use, persisted values, stale model, incompatible thinking, cancellation, and resumed exact-model validation.

## Task 7 - Wire Final Review Configuration into Both Workflows

Add `Final review?` with default **No** to the common option flow. When enabled, call the independent review model and thinking selectors and, where applicable, ask for the optional source-plan path. Include all review settings in the mandatory summary and persist them to workflow state only after confirmation. Leave the existing implementation pair unchanged until review starts.

**Acceptance criteria**

- Both commands expose the same review option and default to disabled.
- The review pair and source-plan provenance are shown accurately in the final summary.
- Disabled review uses the old task execution flow followed by normal completion.
- Cancel at any step avoids side effects and preference changes.

**Tests:** new workflows for review on/off, prompt order, selected defaults, and state serialization.

## Task 8 - Implement Review Prompts and Structured Result Validation

Create `src/review.ts` with a focused prompt builder covering plan compliance, test adequacy, and documentation. Require the review agent to read relevant files, inspect actual code and tests, run feasible validation, apply only verifiable minor fixes, and report evidence and unresolved issues. Specify severity `minor`, `major`, `critical`, and `unable_to_verify` (with a reason), and overall result `passed`, `fixed`, `follow_up`, or `blocked`.

Extend `src/executor.ts` only as much as needed to obtain the completed turn's final assistant text without changing existing task behavior. Define a compact machine-readable result contract, parse/validate it, and reject missing, malformed, contradictory, or incomplete results. Never infer review success from an ordinary `stop` reason alone.

**Acceptance criteria**

- Review is a tool-enabled active-session turn, not an isolated text-only model call.
- It receives the authoritative tasks and available source plan, with explicit instructions not to invent unverifiable coverage.
- The orchestrator receives a validated result or a recoverable error.
- The review reports missing evidence and unavailable checks explicitly.

**Tests:** result parsing, invalid schema/severity/outcome, missing plan, error stop, missing response, and a valid result after successful agent lifecycle.

## Task 9 - Support Minor Fixes and Remediation Documents

Implement the review result's handling of verified minor fixes and unresolved actionable findings. Require any minor edits to be checked with pertinent tests or other direct validation, with unsuccessful validation surfaced as unresolved. When actionable findings remain, have the review agent create/overwrite **both** `plan-fixes.md` and `tasks-fixes.md` in the current working directory.

Validate after review that required files exist, are nonempty, and include actionable findings, ordered tasks, and acceptance/verification criteria. Reject an inconsistent claimed result while preserving recovery state. Do not touch existing remediation files when no new actionable finding remains. Do not automatically execute generated tasks.

**Acceptance criteria**

- No findings: no remediation files are written or deleted.
- Minor verified edits: changes remain, outcomes include checks performed, and no unnecessary remediation files are created.
- Major/critical or actionable unverified issues: both remediation documents are generated and consistent with reported issues.
- Missing or invalid files cause a recoverable review failure.
- The final result distinguishes new remediation output from stale existing files.

**Tests:** pass, fixed, follow-up, blocked, old documents untouched, missing-one-file, inconsistent result, and unverified non-actionable case.

## Task 10 - Integrate Review Execution, Compaction, and Recovery

Execute the review after the last successful task and all task checkpoints, using the saved review pair and the existing `ActiveSessionExecutor`. If automatic compaction is enabled, allow a threshold check between the final implementation task and review, with the same pending-compaction recovery mechanism used between tasks. Persist review start/completion and structured result so an interrupted review may be retried, whereas a completed review is not rerun merely because later bookkeeping fails.

Restore implementation settings after successful review when possible. Show an explicit final result with checked areas, applied minor fixes, unresolved findings, unverified checks, and generated file paths. Remove state only after all selected phases are complete.

**Acceptance criteria**

- Review never begins if any task or pending task checkpoint fails.
- Review runs once after a successful task sequence, with the configured model/thinking.
- Pending compaction and interrupted review resume from their correct phases.
- A completed review is not repeated on recovery from a later failure.
- Disabled review finishes without an extra review turn.

**Tests:** success/stop, task failure, model switch failure, compaction before review, interruption, resume, and final reporting.

## Task 11 - Add the Review Git Checkpoint

Generalize checkpoint handling to support a review-specific commit after a successful validated review. Only commit when checkpoints are enabled and the review produced working-tree changes. Use a descriptive review commit message and exclude state metadata. Persist pending review checkpoint information before Git operations and reuse the current idempotent recovery logic for already-finished commits.

Do not commit a review marked failed because of missing output, invalid remediation files, or interrupted execution. Do not introduce remote Git operations.

**Acceptance criteria**

- Task commits occur before the review starts.
- A review with file changes can produce one additional local commit.
- A review with no changes creates no empty commit.
- Checkpoints disabled means no review commit.
- Review checkpoint failure is recoverable without rerunning the review or creating duplicate commits.

**Tests:** changed/unchanged review, no-Git mode, failed checkpoint, already committed recovery, state-file exclusion, and separate review commit message.

## Task 12 - Complete Integration Tests, Documentation, and Manual UI Checks

Expand existing integration tests to cover the end-to-end paths for `/implement-tasks` and `/implement-plan`, confirmation/cancel, source provenance, review selection and persistence, result classification, remediation files, Git checkpoints, compaction, and recovery. Verify that cancellation does not alter pre-existing dirty state or overwrite targets. Check that a user choosing discard can still cancel without losing old recovery state.

Update `README.md` with command behavior, settings order, final summary, default-disabled review, independent review model/thinking preferences, plan-source handling, minor fixes, remediation documents, limitations, Git/recovery behavior, and concise usage examples. Document the optional next step `/implement-tasks tasks-fixes.md`, explicitly noting it requires user initiation.

**Acceptance criteria**

- Full `npm test` succeeds.
- `npm run typecheck` succeeds.
- All acceptance criteria in `plan.md` are covered by either automated tests or an explicitly documented manual check.
- Manual TUI smoke checks cover lengthy summaries, small/resized Windows 11 terminals and Linux terminals; action options remain visible.
- No unrelated behavior changes, unexpected dependencies, or remote Git operations are introduced.

**Tests:** full regression suite, static type check, and the documented manual UI matrix.
