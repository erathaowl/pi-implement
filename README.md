# pi-implement

A minimal [pi](https://pi.dev) extension for sequentially implementing Markdown plans and task files in the current session.

It provides two workflows:

- `/implement-tasks` — implement an existing task file without rewriting it.
- `/implement-plan` — convert a plan to `tasks.md`, then implement it as a task file.

Both workflows execute tasks sequentially in the active pi session. They share mandatory execution-summary confirmation, optional local Git checkpoints, context compaction, optional final review, and recoverable progress.

## Installation

Install from npm:

```bash
pi install npm:pi-implement
```

Install directly from GitHub:

```bash
pi install https://github.com/erathaowl/pi-implement
```

For a project-local installation:

```bash
pi install -l https://github.com/erathaowl/pi-implement
```

Update agent and installed packages with:

```bash
pi update --all
```

Alternatively you can clone this repository and load the extension directly while developing:

```bash
pi -e ./index.ts
```

Or install this directory as a local pi package:

```bash
pi install /absolute/path/to/pi-implement
```

## Use


### `/implement-tasks [markdown-file]`

Implements an existing Markdown task file while keeping the original document as the authoritative source of instructions. If the path is omitted, the command prompts for it.

```text
/implement-tasks tasks.md
```

An isolated model call identifies the actual logical tasks, their titles, and their order. It does not rewrite their instructions.

Each implementation turn is then told to read the original task file and implement exactly one numbered task. Shared constraints and acceptance criteria remain authoritative in the source document.

No fixed task-file schema is required. Headings, numbered sections, checklists, and prose can all be used. Task-like content inside examples, templates, or fenced code blocks is ignored when identifying real tasks.

Use this command when the task file is already written the way you want and should not be transformed before execution.

### `/implement-plan [plan-file]`

Converts a Markdown implementation plan into a readable task file and then runs the same workflow used by `/implement-tasks`. If the path is omitted, the command prompts for it.

```text
/implement-plan plan.md
```

The generated task document is written to:

```text
tasks.md
```

in the current working directory.

If `tasks.md` already exists, the command asks for overwrite approval. Conversion and indexing happen in memory; the file is not written until you confirm the final execution summary. Cancellation leaves an existing task file untouched. The destination is rechecked before writing, so external changes invalidate the earlier approval.

The original plan must be separate from `tasks.md` (including file aliases). Its path is retained independently for final review. The generated file becomes the authoritative task source; implementation does not run directly from the conversion response.

This is useful when the input describes the work at plan level rather than as clearly executable tasks.

## Common behavior

An interactive TUI or RPC UI is required. Preparation uses the currently active model/thinking pair in isolated, tool-free calls without adding their prompts or responses to session history. For `/implement-plan`, conversion and indexing finish before implementation settings are selected.

### Settings and confirmation order

1. If recovery state exists, choose **Resume**, **Discard and start new**, or **Cancel**. Resume goes directly to its summary with saved settings. For a new/replacement run inside Git, choose whether to add the state file to `.gitignore` (default **Yes**); this records intent only.
2. Supply the Markdown path if omitted. For `/implement-plan`, approve any future overwrite and prepare the generated tasks in memory.
3. Preview the detected tasks and choose implementation-only or local Git checkpoints.
4. Choose automatic compaction (default **Yes**) and, if enabled, its threshold (default **70%**).
5. Select the implementation model and thinking level, defaulting to the active pair. With checkpoints enabled, enter a new local branch name or confirm using the current branch.
6. Choose **Final review?** (default **No**). If enabled, select its independent model and thinking level. `/implement-tasks` also asks for an optional reference plan; blank means no source plan, not an inferred one.
7. Confirm the mandatory **Execution summary** with **Start implementation / Cancel**, or **Resume / Cancel** for recovery. **Cancel is the default**, even when review is disabled.

The summary includes the command, working directory, source paths, task count, implementation/review settings, Git branch and initial commit intent, compaction threshold, and pending `tasks.md`/`.gitignore` writes. TUI PageUp/PageDown scroll the content without moving the action selection; arrows (or `j`/`k`) select an action, Enter confirms, and Escape/Ctrl+C cancel. Actions stay visible as the terminal resizes; in extremely small viewports the selected action remains accessible. RPC uses a standard selection dialog with Cancel listed first and requires an explicit affirmative response.

Before final confirmation, preparation does not create branches, stage/commit files, change `.gitignore`, write recovery state, overwrite `tasks.md`, switch models, or save review preferences. Cancelling a replacement run also preserves the old recovery state. Changed source files, overwrite targets, or Git assumptions abort setup rather than silently overwriting external work.

After confirmation, setup intent and prepared Markdown are saved, deferred Git setup and file writes run, and tasks execute sequentially in the active session. The implementation pair stays fixed through all tasks; review settings apply only at the final review stage. The extension waits for the full agent lifecycle, including tools and retries, to settle before advancing.

Only a normal `stop` marks an implementation task complete. Failure, truncation, cancellation, or another terminal reason stops execution and preserves recovery state. Review additionally requires a valid structured result and any required remediation artifacts; `stop` alone is not review success. Preparation does not rewrite source requirements; execution and review are tool-enabled and can change project files.

### Local Git checkpoints

Inside a Git repository, `/implement-tasks` — and therefore `/implement-plan` through its delegated task workflow — offers two execution modes:

- implement without Git checkpoints;
- commit after each successful task on a new or current local branch.

The Git mode is selected in the task-preview dialog, before the compaction question. Outside a Git working tree, only **Implement** and **Cancel** are offered. If Git detection fails (for example, due to dubious ownership, permissions, or unavailable Git), the workflow reports the error and stops instead of silently hiding the Git choices. Resolve the reported Git issue manually, then rerun the command; the extension never changes Git trust settings.

Enter a name to create a new local branch, or leave the branch-name input empty and confirm to continue on the current branch. Continuing on the current branch requires a named branch; detached HEAD is rejected.

After final confirmation, a dirty checkpoint-mode worktree is captured on the selected branch in a separate `chore: capture initial implementation state` commit before tasks begin. This includes staged, unstaged, and untracked files, but not ignored files or recovery metadata. Clean repositories and implementation-only mode need no initial commit. If initial staging/committing fails before a commit completes, the original index is restored without overwriting working files.

Each successful task can produce a `Task N: Title` commit. After a validated final review, working-tree changes (including generated remediation documents) can produce one additional `Review: apply fixes and record findings` commit. No changes means no empty commit. Invalid output, invalid artifacts, and interrupted review do not trigger a successful review checkpoint. A valid `follow_up` or `blocked` result can still checkpoint its recorded findings; unresolved issues are not a clean pass.

A Git failure preserves completed task/review progress and pending checkpoint metadata. Recovery detects a finished-but-unrecorded checkpoint from its saved parent and message instead of committing again; unrelated HEAD changes stop recovery for manual inspection. All checkpoints exclude both `.pi-implement-state.json` and its atomic-write temporary file. Checkpoints disabled means no extension-owned commits, including after review.

Git operations owned by the extension are strictly local. It may inspect repository state, create a local branch, stage changes, and create commits. It never fetches, pulls, pushes, clones, or modifies remotes.

Task prompts also instruct the active agent not to create commits or perform remote Git operations itself.

### Automatic context compaction

Each workflow can enable automatic compaction between tasks and, when final review is enabled, between the last task/checkpoint and review.

The threshold is an integer from 1 through 100; blank uses **70%**. Usage strictly above the threshold triggers pi's normal compaction. Usage at/below it, or unavailable usage information, does not. Disabled compaction does not ask for a threshold or inspect context usage. With review disabled, there is no compaction check after the final task.

Compaction is persisted as pending before it starts. Failure/interruption preserves that marker; recovery retries pending compaction before the next task or review, even if the current usage has dropped.

## Optional final review

Final review is **off by default** for both commands. When enabled, one tool-enabled review runs in the current session after all tasks and task checkpoints succeed. It checks:

- plan/task compliance, constraints, acceptance criteria, and regressions;
- meaningful test coverage and feasible checks, not merely whether a suite is green;
- affected documentation, setup, examples, APIs, and usage.

`/implement-plan` supplies its original plan and generated `tasks.md`. `/implement-tasks` uses its task file and an explicitly supplied optional `.md`/`.markdown` reference plan. Without one, original-plan compliance is reported as unavailable; the result cannot be a clean pass. Missing source material stops review recoverably rather than supporting an invented compliance claim.

### Review model preferences

The review model and thinking level are independent of the implementation pair. On first use the implementation pair is proposed when compatible; later runs propose the last **confirmed** review pair across projects. Unavailable/incompatible preferences require explicit compatible choices.

Preferences are saved only after the final summary is confirmed, in `pi-implement-preferences.json` under the SDK's user agent directory (`getAgentDir()`, normally `~/.pi/agent`, respecting `PI_CODING_AGENT_DIR`). They are not repository recovery state or project configuration. Cancellation and review-disabled runs leave them unchanged. Resume uses the exact saved workflow settings, not a new preference or silent substitute.

### Fixes, findings, and output

The reviewer may apply only localized, low-risk **minor** fixes with pertinent tests or direct validation. Failed/unavailable verification is unresolved, not a verified fix. **Major**, **critical**, and **unable_to_verify** findings include evidence and follow-up or an explicit limitation. Broad/speculative development is deferred.

Results are `passed` (no unresolved issues or fixes), `fixed` (verified minor fixes only), `follow_up` (actionable work remains), or `blocked` (unresolved issues/verification limitations; critical findings require this outcome). The final report lists checked areas, checks/evidence, applied fixes, unresolved findings, unavailable checks, and exact new artifact paths.

When actionable findings remain, review creates/overwrites **both** files in the current working directory:

- `plan-fixes.md`: context, evidence, expected behavior, remedy, constraints, acceptance criteria, and verification.
- `tasks-fixes.md`: ordered tasks referencing the findings and plan, with actions and acceptance/verification criteria.

Both files must be fresh, nonempty, regular files with consistent content. Missing, stale, or inconsistent output fails review recoverably. If there is no actionable finding, existing remediation files must remain untouched and are not reported as new output. Non-actionable verification limitations do not invent tasks.

Generated tasks are **never executed automatically**. Inspect the evidence and documents, then explicitly initiate a separate run if desired:

```text
/implement-tasks tasks-fixes.md
```

For that later run, you can supply `plan-fixes.md` as the optional reference plan when enabling review.

### Limitations

Review is model-assisted, not an independent correctness/security proof or a fixed coverage guarantee. Structured validation checks the result contract and remediation consistency, not the truth of every agent assertion. Inspect the cited files, checks, and unavailable-check reasons. Review instructions restrict edits and Git usage, but do not sandbox the agent's tools. There are no automatic repeat-review/remediation loops or independent review sessions.

## Recovery

Active implementations are tracked in a single repository-local state file:

```text
.pi-implement-state.json
```

Inside a Git repository, new workflows ask whether this file should be added to the repository-root `.gitignore`, with **Yes** as the default. Outside Git, the state file is still used but `.gitignore` is not created or modified.

Version-2 state records the explicit phase (`setup`, `tasks`, `review`, `review_checkpoint`, or `completed`), deferred setup intent, prepared generated Markdown, source paths, task progress, implementation/review settings, validated review result, and pending checkpoint/compaction metadata. Writes are atomic; Git checkpoints exclude recovery metadata even if it is not ignored. Version-1 state migrates in memory with review disabled, retaining task and pending-operation progress without new review prompts.

If unfinished state exists, starting any implementation command offers:

- **Resume**
- **Discard and start new**
- **Cancel**

Resume shows its own mandatory summary, then uses saved work directly without reconversion, reindexing, or model-selection prompts. It restores the exact settings needed for the remaining phase; unavailable models or incompatible thinking levels stop recovery with a clear error. A reviewer model is not required again after its validated result has been saved.

Interrupted tasks or reviews without a validated completion marker may be retried. Completed tasks are not rerun for checkpoint/compaction failure, and a saved completed review is not rerun for checkpoint, restoration, reporting, or cleanup failure. Pending checkpoints use their saved purpose, message, and parent HEAD; already-finished commits are not duplicated. Deferred setup also recognizes completed branch creation/file writes/checkpoints instead of blindly repeating destructive operations.

After review and any review checkpoint succeed, the implementation pair is restored. Restoration failure remains recoverable with the review result intact. Discarding an old run takes effect only after a replacement run is confirmed; cancelling replacement configuration preserves the old state.

Resume must be started from the same resolved working directory as the original workflow. The current local branch must match the saved checkpoint branch or repository setup assumption, including implementation-only runs configured inside Git. The extension does not change either automatically.

The state file is deleted only after all selected phases and required artifact validation/checkpoints complete. It is preserved after failure or interruption. A valid final `follow_up`/`blocked` report can finish the workflow with outstanding work for a separately initiated run.

## Scope

`pi-implement` intentionally focuses on a small sequential workflow:

- task preview and mandatory execution-summary confirmation;
- one task at a time in the current session, with progress display;
- optional local Git checkpoints and context-aware compaction;
- a fixed implementation pair and optional independently configured final review;
- cross-project review preferences and repository-local, single-file recovery.

It does not provide task editing/reordering, parallel execution, subagents, dependency graphs, automatic failure retries, state history, per-task model selection, global implementation-model preferences, recursive remediation, or remote Git automation.

## Release on npm

From the repository root, use the following workflow with a clean working tree:

```bash
git status --short
npm ci
npm version patch
# Or: npm version X.Y.Z
npm test
npm run typecheck
npm publish
git push origin HEAD --follow-tags
```

`npm version` updates the package files and automatically creates the release commit and the `vX.X.X` Git tag. The final command pushes both to the remote.

## Validation

```bash
npm test
npm run typecheck
```

The full test suite includes isolated local Git repositories and creates temporary commits; run it only when those operations are permitted. No test needs a remote. See [VALIDATION.md](VALIDATION.md) for acceptance coverage, the Windows 11/Linux manual UI matrix, and validation status. Automated component rendering is not a substitute for real-terminal smoke checks.
