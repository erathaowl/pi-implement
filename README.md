# pi-implement

A minimal [pi](https://pi.dev) extension with three sequential implementation workflows for Markdown plans and task files.

## Use

Load the extension directly while developing:

```bash
pi -e ./src/index.ts
```

Or install this directory as a local pi package:

```bash
pi install /absolute/path/to/pi-implement
```

### `/implement-tasks <markdown-file>`

This preserves the Markdown task file as the authoritative source of instructions.

```text
/implement-tasks tasks.md
```

An isolated model call indexes only the logical task titles and order; it does not rewrite instructions. After confirmation, each active-session turn is told to read the original task file and implement one numbered task. Task-like headings or checklists inside examples and fenced code blocks should not be indexed as real tasks.

For both `/implement-rewrite` and `/implement-tasks`, a Git repository adds a choice between normal implementation and optional local checkpoint mode. Checkpoint mode requires a clean working tree, creates a new local branch supplied by the user, and commits changes after each successful task. Tasks that produce no changes do not create empty commits. Any Git failure stops the workflow before the next task. If Git is unavailable or the directory is not a repository, implementation continues without Git options.

Git operations owned by this extension are strictly local: repository detection, status checks, local branch creation, staging, and commits. The extension never fetches, pulls, pushes, clones, or modifies remotes. Both rewrite and task-file prompts tell the active agent not to perform remote Git operations or create commits itself.

Both workflows also ask whether automatic between-task compaction should be enabled. When enabled, they check context usage after each successful task except the last. Usage above 70% triggers pi's normal compaction, which must finish before the next task starts. Unavailable usage or usage at or below 70% is skipped; compaction failure stops the workflow. This choice is in-memory for the current run only.

### `/implement-plan <plan-file>`

This converts a plan into a readable task document and then uses the same internal task-file workflow as `/implement-tasks`:

```text
/implement-plan plan.md
```

The generated document is written to `tasks.md` in the current working directory. If that file already exists, the command asks before overwriting it. The generated file is indexed after it is written; implementation does not run directly from the conversion response. Because this delegates to the task-file workflow, the same optional local Git checkpoint and between-task compaction choices apply.

### `/implement-rewrite <markdown-file>`

This is the original rewrite-based workflow. It reads arbitrary Markdown, uses the selected model to rewrite it into ordered, self-contained `{ title, instructions }` tasks, previews the task titles, and implements each rewritten task in the active session.

```text
/implement-rewrite plan.md
```

Applicable document-wide constraints, acceptance criteria, and shared requirements are repeated in each affected task so it can be executed independently. Rewrite execution offers the same optional local Git checkpoints and between-task context compaction as the task-file workflow.

## Common behavior

All isolated model calls use the currently selected model, omit tools from the model context, and do not add their prompts or responses to active session history.

Before implementation, each workflow shows the detected task titles and offers **Implement** or **Cancel**. Tasks run sequentially as normal user instructions in the current pi session. The extension waits for the complete agent lifecycle—including tools, retries, and compaction—to settle before submitting the next task. Only a normal `stop` reason marks a task complete; failure, truncation, cancellation, or any other terminal reason stops the workflow.

Input Markdown files are read-only. `/implement-plan` is the sole exception in that it intentionally creates or overwrites `tasks.md` after confirmation.

No dedicated task-file schema is required. Headings, checklists, numbered sections, and prose instructions are interpreted semantically by the selected model.

## Scope

The extension provides preview/cancel, sequential execution, in-memory progress, stop-on-failure behavior, optional local Git checkpoints, and optional 70% context-aware compaction for task-file workflows. It does not provide task editing or reordering, persistence or resume, retries, parallelism, subagents, dependency graphs, model selection, or remote Git automation.

An interactive UI (TUI or RPC UI) is required so execution can be confirmed.

## Validation

```bash
npm test
npm run typecheck
```
