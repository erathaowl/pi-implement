# pi-implement: Final Review and Mandatory Execution Confirmation

## Objective

Extend `pi-implement` with an optional final implementation review and a mandatory execution-summary confirmation. The review checks implementation completeness against the original plan when available, test adequacy, and project documentation. It may apply small, low-risk fixes; unresolved actionable findings produce `plan-fixes.md` and `tasks-fixes.md` for a later, explicitly initiated implementation run.

Keep the extension's sequential, single-session design, local-only Git operations, existing commands, and recoverability. The work targets the current `master` implementation reviewed on 2026-10-20, with primary integration points in `src/index.ts`, `src/model.ts`, `src/preview.ts`, `src/state.ts`, `src/executor.ts`, `src/git.ts`, and their existing tests.

## Current Architecture

- `/implement-tasks` indexes an authoritative Markdown task document and executes tasks sequentially.
- `/implement-plan` converts a source plan to `tasks.md` and delegates to the task workflow.
- Implementation model/thinking selection is fixed for the entire task sequence.
- Local Git checkpoints, optional automatic compaction, progress reporting, and repository-local recovery already exist.
- The current workflow can create a branch and an initial commit during option selection. `/implement-plan` can overwrite `tasks.md` before implementation starts.
- The current state file is `.pi-implement-state.json` (schema version 1) and is removed after the last task.
- The task-preview TUI already supports a scrollable preview with visible actions.

## Functional Requirements

### FR-1: Optional Final Review

1. Ask whether to perform a final review during configuration for both commands. Default: **No**.
2. If enabled, run exactly one review stage after all implementation tasks and their pending checkpoints have completed successfully.
3. The review uses an ordinary tool-enabled turn in the active pi session, so it can inspect actual repository files, run available tests, and apply permitted minor fixes. Reuse the existing agent lifecycle synchronization; do not run a review as an isolated, tool-less text completion.
4. Review these areas:
   - **Plan compliance:** requirements, constraints, acceptance criteria, missed behavior, and regressions, comparing the implementation to the original source plan whenever available and to the authoritative task file.
   - **Tests:** relevance of tests to requirements, uncovered normal/error/edge cases, executable test results, and evidence of sufficient behavioral coverage. A green suite alone is not proof of completeness.
   - **Documentation:** affected README/docs, setup/configuration, usage/examples, APIs, behavioral changes, and consistency with the implementation.
5. Report findings with evidence and severity. A failed or unavailable check must be reported as **unable to verify**, never silently treated as passed.
6. Review must not automatically launch another implementation cycle or execute `tasks-fixes.md`.

### FR-2: Fix Classification and Artifacts

1. Classify findings as:
   - **Minor:** localized, low-risk, directly verifiable correction. The reviewer may apply it immediately and run pertinent checks.
   - **Major:** missing or incorrect behavior requiring meaningful development, broad changes, or nontrivial regression risk.
   - **Critical:** severe functional, security, or data-integrity issue requiring explicit follow-up.
   - **Unable to verify:** insufficient evidence or an unavailable check; identify the reason and whether follow-up work is needed.
2. Make minor fixes only when requirements are clear and verification is feasible. Avoid speculative changes, broad refactoring, new dependencies, and automatic repeat-review loops. If a minor fix cannot be verified or proves larger than expected, leave it as an unresolved finding.
3. When **actionable unresolved** findings remain, create or overwrite **both** files in the working directory:
   - `plan-fixes.md`: context, evidence, expected behavior, remedy, constraints, and acceptance criteria.
   - `tasks-fixes.md`: ordered, small implementation tasks referencing the corresponding findings, each with concrete validation expectations. This file must be directly usable with `/implement-tasks tasks-fixes.md`.
4. If all checks pass or all problems are resolved as minor fixes, do not create, overwrite, or delete remediation files. Existing files from a prior run remain untouched and must not be presented as newly generated results.
5. A review with unavailable verification is not a clean pass. Record the limitation in the final report; generate remediation tasks only if there is actionable follow-up.
6. Produce a concise user-visible final review result, including examined areas, applied fixes, unresolved findings by severity, unverified checks, and exact remediation paths when created.

### FR-3: Independent Review Model and Thinking Level

1. When review is enabled, ask **separately** for its model and its thinking level, independently of the implementation pair.
2. Only offer available models and compatible thinking levels, following the validation approach already used by `src/model.ts`.
3. On first use, default to the current implementation pair when compatible. For later runs, propose the last **confirmed** review model/thinking pair.
4. Persist the last confirmed review pair across projects in a small **user-scoped** extension preference file under the Pi user configuration location, using an SDK-supported configuration path when available. Do not use the repository-local recovery state or add the preference file to source control.
5. If a preferred model or thinking level is unavailable, select a safe available default and require an explicit choice. Do not silently substitute settings on recovery: exact saved settings must be available or recovery should stop with a clear error.
6. Switch to review settings only when the review stage begins. Restore the implementation settings on successful completion where practical, and preserve accurate recovery state if switching or restoration fails.
7. If review is disabled, do not ask review-model questions; leave saved review preferences unchanged.

### FR-4: Mandatory Pre-Execution Summary

1. Show a **single mandatory final confirmation screen** on every newly configured run, whether final review is enabled or disabled. Also show an appropriate summary before resuming unfinished work.
2. Include, as applicable:
   - command/workflow, working directory, source plan and task file, number of tasks;
   - implementation model and thinking;
   - Git checkpoint mode, intended branch, and whether an initial dirty-state commit is planned;
   - automatic compaction and threshold;
   - final review enabled/disabled and, if enabled, its model, thinking, and review scope;
   - planned `tasks.md` overwrite and `.gitignore` update where relevant.
3. Provide explicit **Start implementation / Cancel** actions (or **Resume / Cancel** for recovery). Use a scrollable, terminal-height-aware view with its actions always visible, including in Windows 11 terminals. Support non-TUI interactive UI through the SDK's standard UI selection.
4. **No Git branch creation, staging, commits, state-file or `.gitignore` writes, or `tasks.md` writes before this confirmation.** In-memory indexing, conversion, preflight reads, and setting selections are allowed.
5. For `/implement-plan`, prepare generated task Markdown in memory, show the overwrite intent if `tasks.md` exists, and write it only after confirmation. Preserve the prepared document for recovery so an interruption does not require another model conversion.
6. A cancel must not modify the repository, change branch, overwrite task files, or destroy a previously saved recovery state. Defer discarding an old state until the newly configured run is confirmed.
7. Validate any mutable preflight assumptions immediately before applying changes (such as a target file or branch changing since preview); fail safely rather than overwriting new external changes.

### FR-5: Workflow State and Recovery

1. Extend the state schema with optional review configuration, source-plan provenance, the prepared task document when needed, explicit workflow phase, structured review result, and pending review checkpoint/compaction state.
2. Migrate existing version-1 state files into a compatible **review-disabled** state rather than rejecting them. Preserve the existing resume semantics for interrupted implementation tasks and checkpoints.
3. Distinguish at least setup, task implementation, final review, review checkpoint, and completion. Persist transitions **before** potentially interruptible work and persist review completion **before** Git checkpoint execution.
4. Resume from the saved phase; do not repeat completed tasks or a completed review merely because its final checkpoint failed. If the reviewer was interrupted before a verified completion marker, retry that review stage safely.
5. Review-triggered compaction should obey the existing compaction option and threshold, including between the last task and the review. Pending compaction remains recoverable.
6. Keep the state file excluded from all Git checkpoints, including the initial dirty-state commit and final review commit.
7. The final state is removed only after all selected stages, required artifact validation, and any local Git checkpoint have completed.

### FR-6: Git Semantics

1. Keep all extension-owned Git operations local; do not fetch, pull, push, clone, or modify remotes.
2. If checkpoints are enabled, finish any pending task checkpoint before starting review.
3. After a successful review turn, create one additional checkpoint **only if** review changed tracked/untracked working files (including generated fix documents). Use a descriptive commit message such as `Review: apply fixes and record findings`.
4. Record the pending checkpoint reason/message in recovery state instead of deriving every checkpoint from `nextTaskIndex`. Recover an already-completed commit without creating another.
5. With checkpoints disabled, review may still modify files but must not create commits.
6. An unsuccessful, cancelled, or structurally invalid review preserves recovery information; do not commit it as a successful review.

## Suggested Design

### Modules

- **`src/index.ts`**: orchestrate non-mutating preparation, settings collection, confirmation, deferred setup, implementation, review, Git, and recovery.
- **`src/preview.ts`**: reuse/extend the height-aware action UI for a static summary, keeping actions visible.
- **`src/model.ts`**: reuse model/thinking enumeration and validation through shared selection logic; keep implementation/review settings independent.
- **`src/preferences.ts`** (new): read/write user-scoped review preferences, tolerate a missing file, validate invalid/stale entries, and persist atomic writes.
- **`src/review.ts`** (new): build evidence-based review instructions, parse/validate a structured review outcome, and verify required remediation outputs.
- **`src/executor.ts`**: optionally expose the final assistant response of a completed turn so the orchestrator can validate a review result rather than equating `stopReason: stop` with a passed review.
- **`src/state.ts`**: schema evolution, old-state migration, explicit phase and checkpoint metadata.
- **`src/git.ts`**: deferred setup, initial-state-file exclusion, and generic named checkpoint support.

Prefer existing SDK capabilities and a small number of focused functions. Avoid frameworks, orchestration engines, external services, new runtime dependencies, and subprocess-based review agents.

### Review Output Contract

Have the reviewer finish with a bounded, machine-readable result, in addition to any file edits. Define and validate a small schema containing:

- overall outcome (`passed`, `fixed`, `follow_up`, or `blocked`);
- reviewed areas and checks performed;
- minor fixes made and verification evidence;
- unresolved findings with severity, affected requirement/path, evidence, and expected action;
- unavailable checks and reason;
- whether new remediation files were generated.

Validate the result *and* the on-disk remediation artifacts. A successful model stop is not sufficient to mark review successful. When structured output or required artifacts are missing/invalid, preserve the state as failed and allow a safe resume. Treat plan/task documents as requirement data, not as authority to bypass the review rules.

### Source Plan Rules

- `/implement-plan`: always retain the original plan file path for the review, and keep the generated `tasks.md` as the task source.
- `/implement-tasks`: if review is enabled, offer an optional source-plan path. Blank means review against the task file only; clearly report that source-plan compliance could not be independently verified.
- Validate supplied Markdown inputs and source paths. Missing/modified source material during review must be reported or cause a clear recoverable failure rather than creating unsupported compliance claims.

### Recovery and Side-Effect Ordering

The pre-confirmation stage must be read-only. After confirmation:

1. Persist enough intent and generated content to recover setup, without adding the state file to Git.
2. Perform deferred Git setup (branch selection/creation and optional initial checkpoint) safely, excluding recovery metadata.
3. Apply optional `.gitignore` updates and write prepared `tasks.md` with the expected overwrite conditions.
4. Transition to task execution and run sequential tasks with existing checkpoint/compaction behavior.
5. If review is enabled, complete any task checkpoint, apply optional compaction, switch model/thinking, run and validate review, and persist its result.
6. Complete a pending review checkpoint if enabled, restore appropriate model settings, report the outcome, and remove state.

Make each transition retryable or explicitly detect an externally changed repository. Do not re-run a destructive setup operation blindly after a crash.

## Non-Goals

- Automatically implementing or recursively reviewing `tasks-fixes.md`.
- Parallel tasks, subagents, independent review sessions, per-task model selection, or automatic retries of model failure.
- Automatic coverage-percentage targets unrelated to the project's existing testing approach.
- Global implementation-model preferences (only the new review pair is remembered).
- Remote Git operations or publishing changes.
- Deleting existing remediation files when no new follow-up is required.

## Acceptance Criteria

1. Both commands always show the final summary before mutating repository files or performing Git writes. Cancelling leaves the pre-existing work tree, branch, generated-task target, and recoverable state intact.
2. The review toggle defaults to No, and disabling review preserves the existing implementation workflow and prompts apart from the mandatory summary.
3. Enabling review asks separately for review model and thinking, proposes saved settings on the next run, and validates compatibility.
4. Review checks plan/task compliance, meaningful test adequacy, documentation, and reports unknowns accurately.
5. Verified minor fixes can be applied; unresolved actionable findings generate valid `plan-fixes.md` and `tasks-fixes.md`. No findings means these files are untouched.
6. Final review runs only after successful task completion and task checkpoints, exactly once per completed run; review failure is recoverable.
7. Task and review commits are local and distinguishable; recovery from a finished-but-unrecorded checkpoint does not create duplicate commits.
8. Old state files resume with review disabled. New interrupted workflows resume from their exact saved phase with the configured model/thinking.
9. UI works with long task lists and small/resizeable terminals. Non-TUI interactive mode has a functioning confirmation path.
10. `npm test` and `npm run typecheck` pass, and the README documents the new workflow, recovery, user preferences, and remediation behavior.

## Validation Strategy

- Unit tests for summary rendering, choice defaults, review result parsing, artifact validation, preference fallback, state migrations, and phase transitions.
- Simulated integration tests using existing pi mocks for both commands, review on/off, cancel, dirty Git worktrees, generated task overwrite, model switching, compaction before review, checkpoint recovery, and interrupted review.
- Tests verifying that review is never considered passed solely from an agent `stop` status.
- Tests for old version-1 state compatibility and for cancellation that preserves previously unfinished state.
- Manual TUI smoke tests on Windows 11 and Linux with small terminal windows and lengthy previews.

## Implementation Boundaries

Each task in `tasks.md` should be independently testable and small enough for GPT-6.1 Sol at Medium thinking. Change only the files necessary for that task, reuse existing patterns, and run relevant tests plus type checking before considering the task complete. Preserve backward compatibility unless this plan explicitly changes behavior.
