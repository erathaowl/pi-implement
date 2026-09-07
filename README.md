# pi-implement

A minimal [pi](https://pi.dev) extension for sequentially implementing Markdown plans and task files in the current session.

It provides two workflows:

- `/implement-tasks` — implement an existing task file without rewriting it.
- `/implement-plan` — convert a plan to `tasks.md`, then implement it as a task file.

Both workflows execute tasks sequentially in the active pi session and share the same optional Git checkpoints, context compaction, progress display, and recovery behavior.

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

If `tasks.md` already exists, the command asks before overwriting it. The generated file is then indexed and implemented as a normal authoritative task file; implementation does not run directly from the plan-conversion response.

This is useful when the input describes the work at plan level rather than as clearly executable tasks.

## Common behavior

All preparation calls use the currently active model and thinking settings in isolation. Tools are omitted from those model calls, and their prompts and responses are not added to the active session history. For `/implement-plan`, both plan conversion and generated-task indexing finish before implementation settings are selected.

Before execution, the detected tasks are previewed for confirmation. The workflow then asks for one implementation model and thinking level, defaulting to the currently active pair. That fixed pair is used for every task; there is no per-task selection or automatic model switching.

Tasks are implemented sequentially in the current pi session. The extension waits for the complete agent lifecycle, including tool calls and retries, to settle before starting the next task.

Only a normal `stop` reason marks a task as successfully completed. Failure, truncation, cancellation, or another terminal reason stops the workflow and preserves recovery state.

Input Markdown files are read-only. `/implement-plan` is the only workflow that intentionally creates or overwrites a task file.

An interactive UI (TUI or RPC UI) is required.

### Local Git checkpoints

Inside a Git repository, `/implement-tasks` — and therefore `/implement-plan` through its delegated task workflow — offers two execution modes:

- implement without Git checkpoints;
- commit after each successful task on a new or current local branch.

The Git mode is selected in the task-preview dialog, before the compaction question. Outside a Git working tree, only **Implement** and **Cancel** are offered. If Git detection fails (for example, due to dubious ownership, permissions, or unavailable Git), the workflow reports the error and stops instead of silently hiding the Git choices. Resolve the reported Git issue manually, then rerun the command; the extension never changes Git trust settings.

Checkpoint mode requires a clean working tree before execution starts. Enter a name to create a new local branch, or leave the branch-name input empty and confirm to continue on the current branch. Continuing on the current branch requires a named branch; detached HEAD is rejected.

After each successful task, changes are staged and committed locally. Tasks that produce no staged changes do not create empty commits. A Git failure stops execution before the next task, without losing the completed task's progress.

Git operations owned by the extension are strictly local. It may inspect repository state, create a local branch, stage changes, and create commits. It never fetches, pulls, pushes, clones, or modifies remotes.

Task prompts also instruct the active agent not to create commits or perform remote Git operations itself.

### Automatic context compaction

Each workflow can optionally enable automatic compaction between tasks.

When enabled, the workflow asks for an integer threshold percentage from 1 through 100. Leaving the input empty uses the default of 70%. Context usage is checked after every successful task except the last, and usage above the selected threshold triggers pi's normal compaction before the next task starts. Disabled compaction does not ask for a threshold.

Usage at or below the selected threshold, or unavailable usage information, does not trigger compaction.

Once compaction starts, it is persisted as pending until it completes successfully. If compaction fails or execution is interrupted while it is running, recovery retries it before starting the next task.

## Recovery

Active implementations are tracked in a single repository-local state file:

```text
.pi-implement-state.json
```

Inside a Git repository, new workflows ask whether this file should be added to the repository-root `.gitignore`, with **Yes** as the default. Outside Git, the state file is still used but `.gitignore` is not created or modified.

The state contains only what is required to resume the workflow: prepared task titles and prompts, execution position, status, working directory, pending checkpoint/compaction, the selected implementation model and thinking level, and the selected Git/compaction options (including the compaction threshold).

Writes are atomic. Git checkpoints explicitly exclude the state file whether or not it is ignored.

If unfinished state exists, starting any implementation command offers:

- **Resume**
- **Discard and start new**
- **Cancel**

Resume uses the saved task sequence directly, without repeating plan conversion, task indexing, or implementation-setting prompts. It restores the saved model, thinking level, and compaction threshold. If the model or exact thinking level can no longer be used, recovery stops with an error instead of continuing under different settings.

A task interrupted while running is rerun. A task already completed before a Git checkpoint or compaction failure is not. Resume retries any pending Git checkpoint before compaction or the next task, using the saved task metadata for the commit message. If no staged changes remain (for example, the commit completed before an interruption), checkpoint recovery succeeds without creating another commit.

Resume must be started from the same resolved working directory as the original workflow. When Git checkpoints are enabled, the current local branch must also match the saved branch. The extension does not change either automatically.

The state file is deleted after complete success and preserved after failure or interruption.

## Scope

`pi-implement` intentionally focuses on a small sequential workflow:

- task preview and confirmation;
- implementation in the current session;
- one task at a time;
- progress display;
- optional local Git checkpoints;
- optional context-aware compaction;
- one model/thinking selection per workflow;
- lightweight single-file recovery.

It intentionally does not provide task editing or reordering, parallel execution, subagents, dependency graphs, automatic retries, state history or snapshots, per-task model selection, global model preferences, automatic model switching, or remote Git automation.

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
