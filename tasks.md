# Implementation Tasks

Implement these tasks sequentially. Keep the extension minimal, reuse existing pi APIs, avoid new runtime dependencies, and preserve the current behavior unless a task explicitly changes it.

## Task 1 - Split the implementation workflows

Refactor the current extension so the existing `/implement` behavior is preserved as `/implement-rewrite`, then add `/implement-tasks` and `/implement-plan`.

### `/implement-rewrite`

- Rename the current `/implement` command to `/implement-rewrite`.
- Preserve its current semantics:
  - read arbitrary Markdown;
  - use an isolated model call to rewrite it into self-contained `{ title, instructions }` tasks;
  - preview the extracted tasks;
  - execute them sequentially in the active pi session.
- Update command-specific messages, tests, and documentation.

### Shared executor

Refactor the active-session executor so it is workflow-agnostic.

It should execute a prompt/string and wait for the complete pi agent lifecycle to settle, rather than accepting a rewrite-specific `ImplementationTask`.

Keep the existing lifecycle behavior:
- submit one user message;
- wait for `agent_start`;
- capture the final assistant result;
- settle only after `agent_settled`;
- treat only `stopReason === "stop"` as success;
- reject cancellation, truncation, provider errors, and other non-success stop reasons;
- never run more than one task at a time.

Do not introduce a generic workflow framework or class hierarchy.

### `/implement-tasks <markdown-file>`

Implement the user's existing manual workflow with minimal automation.

The Markdown file remains the authoritative source of task instructions.

Use one isolated, side-effect-free model call only to identify the logical tasks and their execution order. The indexing result should contain only the information needed for preview/progress, preferably:

```typescript
interface TaskReference {
    title: string;
}
```

Do not rewrite task instructions and do not make each task self-contained during indexing.

After confirmation, execute tasks sequentially in the current session. For task N, send a minimal prompt equivalent to:

```text
Read "<tasks-file>" and implement task #N ("<title>").

Use the task file itself as the authoritative source for the task requirements,
shared constraints and acceptance criteria.

Complete only this task.
Do not start subsequent tasks.
```

Each agent turn must therefore read and interpret the original task file itself.

The task-indexing model call must:
- use the currently selected model;
- remain outside active session history;
- receive no tools;
- preserve source task order;
- identify logical task boundaries without inventing tasks.

Provide the same minimal preview/progress UI and stop-on-failure behavior already used by the current implementation.

### `/implement-plan <plan-file>`

Implement a thin preprocessing workflow:

```text
plan file
  -> isolated model conversion
  -> tasks.md
  -> same internal /implement-tasks workflow
```

Requirements:
- read the supplied plan file;
- use an isolated model call to convert it into a clear Markdown task document;
- write the generated result to `tasks.md` in the current working directory;
- if `tasks.md` already exists, ask the user before overwriting it;
- after writing it, invoke the same internal function used by `/implement-tasks`;
- do not invoke the slash command programmatically;
- do not implement tasks directly from the generated model response.

Generate a readable task document with explicit ordered sections, for example:

```markdown
# Tasks

## Task 1 - Add configuration

...

## Task 2 - Implement middleware

...
```

The generated `tasks.md` should preserve relevant requirements, constraints, acceptance criteria, and intended execution order from the plan.

### Structure

Keep workflow-specific code isolated. A reasonable direction is:

```text
src/
  index.ts
  executor.ts
  rewrite.ts
  tasks.ts
  plan.ts
```

Exact file names may differ if the existing code suggests a simpler arrangement.

The important boundaries are:
- executor/lifecycle code is shared;
- rewrite extraction remains specific to `/implement-rewrite`;
- task indexing and task-file execution remain specific to `/implement-tasks`;
- plan conversion remains specific to `/implement-plan`.

### Tests and documentation

Add/update tests for:
- renamed `/implement-rewrite`;
- preservation of the current rewrite behavior;
- task indexing without instruction rewriting;
- `/implement-tasks` prompts referencing the original file and task number;
- strict sequential execution;
- `/implement-plan` generation of `tasks.md`;
- overwrite confirmation;
- delegation from `/implement-plan` to the internal tasks workflow;
- failure/cancellation behavior.

Update the README to explain the semantic difference between the three commands.

---

## Task 2 - Add optional local Git checkpoints to the tasks workflow

At the start of the `/implement-tasks` phase, detect whether the current working directory is inside a Git repository.

This also applies when `/implement-tasks` is reached through `/implement-plan`.

Do not add this behavior to `/implement-rewrite`.

### User choice

If the directory is a Git repository, offer:

```text
Implement only
New local branch + commit after each task
Cancel
```

If Git is unavailable or the directory is not a repository, continue with normal implementation without Git options.

### Local-only Git rule

All Git operations performed by the extension must be strictly local.

Use a small dedicated helper module with explicit operations. Do not expose arbitrary Git command execution to the workflow layer.

Only use commands required for local repository inspection and checkpointing, such as:

```text
git rev-parse
git status
git switch -c
git add -A
git commit
```

Do not execute or add code paths for any remote operation, including:

```text
git fetch
git pull
git push
git clone
git ls-remote
git remote add
git remote set-url
```

Use pi's existing `pi.exec()` API rather than adding a process-execution dependency.

### Branch + commit mode

When the user selects `New local branch + commit after each task`:

1. Require a clean working tree before starting.
2. Ask for the new branch name through the existing pi UI.
3. Create it locally with `git switch -c`.
4. Execute tasks sequentially.
5. After each successfully completed task:
   - check whether the working tree contains changes;
   - if changes exist, stage them with `git add -A`;
   - create one local commit for that task;
   - use a concise message such as `Task N: <title>`;
   - if no changes exist, continue without creating an empty commit.
6. If a Git operation required by this mode fails, stop the workflow before starting the next task.

Do not automatically stash, restore, merge, rebase, push, or modify remotes.

### Agent guardrail

For `/implement-tasks` prompts, explicitly tell the agent:

```text
Do not perform remote Git operations.
Do not push, pull, fetch, clone, or modify remotes.
Do not create commits; the implementation workflow manages commits when enabled.
```

This is a prompt guardrail only. Keep technical enforcement for extension-owned Git actions in the local-only Git helper.

### Isolation

Keep Git support peripheral to the main task executor.

A reasonable module boundary is:

```text
src/git.ts
```

with narrowly scoped functions such as:
- detect repository;
- check clean working tree;
- create local branch;
- detect changes;
- commit local changes.

Do not turn Git support into a general command runner.

### Tests and documentation

Mock `pi.exec()` and verify:
- non-repository behavior;
- repository choice UI;
- dirty-tree rejection for checkpoint mode;
- branch creation;
- one commit attempt after each successful task with changes;
- no empty commit when there are no changes;
- stop on Git failure;
- no remote Git command is ever issued.

Document that the Git feature is optional and strictly local.

---

## Task 3 - Add optional context-aware compaction between tasks

Add an optional compaction policy to the `/implement-tasks` phase.

This also applies when `/implement-tasks` is reached through `/implement-plan`.

Do not add it to `/implement-rewrite`.

Use a default threshold of **70% context usage**.

### Startup choice

Before task execution starts, ask the user whether automatic between-task compaction should be enabled.

Keep the UI minimal, for example:

```text
Automatic compaction between tasks?

No
Yes, when context usage exceeds 70%
```

Do not add persistent configuration or a settings file in this iteration.

Use a named constant for the default threshold:

```typescript
const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 70;
```

### Behavior

After a task completes successfully, and before starting the next task:

1. If there is no next task, do nothing.
2. If automatic compaction is disabled, continue immediately.
3. Call `ctx.getContextUsage()`.
4. If usage is unavailable or `usage.percent` is `null`, continue without compaction.
5. If `usage.percent <= 70`, continue with the next task.
6. If `usage.percent > 70`, trigger compaction before starting the next task.
7. Wait for compaction to complete successfully before submitting the next task.
8. If compaction fails, stop the workflow and report the error.

Use the current pi extension APIs:
- `ctx.getContextUsage()` for current usage;
- `ctx.compact({ onComplete, onError })` for compaction.

`ctx.compact()` is fire-and-forget, so bridge its `onComplete` / `onError` callbacks into a Promise instead of polling.

Do not implement custom summarization instructions. Use pi's normal compaction behavior.

### Progress/UI

When compaction is triggered, show a concise working message such as:

```text
Compact context before task 3 (74%)
```

Clear/restore the normal working message when compaction finishes.

The existing task status should remain completed/pending while compaction is running; do not add a new persisted task state just for compaction.

### Isolation

Keep the compaction policy separate from the low-level active-session executor.

The executor should continue to be responsible only for:
- sending a prompt;
- observing agent lifecycle;
- resolving/rejecting the turn.

The tasks workflow should decide what happens between completed tasks.

A small helper such as this is sufficient if useful:

```typescript
async function compactIfNeeded(
    ctx: ExtensionCommandContext,
    enabled: boolean,
    thresholdPercent: number,
): Promise<void>
```

Avoid a generic middleware/hook framework.

### Tests and documentation

Add tests for:
- feature disabled;
- context below threshold;
- exactly 70% does not compact;
- context above 70% compacts;
- unavailable/null context usage skips compaction;
- next task does not start until compaction completes;
- compaction failure stops execution;
- no compaction after the final task;
- `/implement-plan` receives the same behavior because it delegates to the tasks workflow;
- `/implement-rewrite` remains unaffected.

Update the README with the optional 70% between-task compaction behavior.

---

## Final validation

After all three tasks:

- run the full test suite;
- run the TypeScript typecheck;
- keep `@earendil-works/pi-coding-agent` as a `peerDependency` with `"*"` per pi package conventions;
- do not add runtime dependencies unless strictly unavoidable;
- keep Git operations owned by the extension strictly local;
- keep `/implement-tasks` faithful to the manual workflow of repeatedly asking the active agent to read the original task file and implement one task at a time;
- keep `/implement-plan` a thin plan-to-tasks preprocessing layer;
- preserve `/implement-rewrite` as the existing rewrite-based workflow.
