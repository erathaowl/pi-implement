    enn: Minimal /implement Extension for pi-agent

Goal

Implement a minimal pi-agent extension that adds:

/implement <markdown-file>

The command reads a Markdown file containing implementation tasks, understands its structure without requiring a strict format, extracts the logical tasks, shows a minimal preview/progress UI, and executes the tasks sequentially in the current pi-agent session.

Keep the implementation deliberately small and aligned with the existing pi-agent extension APIs and UI primitives.

Do not introduce subagents, task persistence, session orchestration, dependency graphs, Git automation, or a custom task-file format.

⸻

Requirements

Command

Add:

/implement <path>

Examples:

/implement plan.md
/implement docs/tasks.md

The command must:

1. Validate the argument.
2. Read the Markdown file.
3. Use the currently selected model to identify the implementation tasks through an isolated model invocation.
4. Present the detected tasks in a minimal UI.
5. Let the user start or cancel execution.
6. Execute tasks sequentially through the active pi-agent session.
7. Show progress while tasks are being executed.
8. Stop if a task fails.

The Markdown file is read-only. Do not modify it or persist execution state into it.

⸻

Model Invocation Boundary

There are two deliberately different model interaction paths.

Task extraction

Task extraction must use a standalone, side-effect-free model invocation.

It should:

* use the model currently selected in pi-agent;
* reuse the relevant current model/provider configuration where supported;
* send only the extraction instructions and Markdown content needed for parsing;
* return structured task data to the extension;
* avoid invoking tools;
* avoid modifying files or project state;
* avoid adding the extraction prompt or response to the active conversation/session history;
* avoid triggering a normal agent turn.

Conceptually:

Markdown file
    ↓
isolated model call
    ↓
ImplementationPlan

The current interactive session is therefore not used as a temporary parser.

If pi-agent exposes a lower-level model/completion API intended for extension-side inference, use that API.

Do not implement extraction by submitting a hidden or synthetic user message to the active agent session unless the pi-agent API provides no side-effect-free model invocation at all.

If no suitable isolated model API exists, inspect the available extension/model APIs and use the narrowest supported mechanism that avoids altering the active session. Document any unavoidable limitation rather than introducing custom session machinery.

Task execution

Task implementation uses the active pi-agent session.

Each extracted task is submitted as a normal agent instruction and allowed to use the regular:

* conversation context;
* system instructions;
* project instructions;
* tools;
* permissions;
* current working directory;
* model;
* thinking configuration.

Conceptually:

ImplementationTask
    ↓
active pi-agent session
    ↓
normal agent turn with tools
    ↓
task completed

The next task starts only after the previous agent turn has completely finished.

This boundary is intentional:

TASK DISCOVERY
Markdown → isolated model inference → structured tasks
TASK IMPLEMENTATION
structured task → active agent session → repository changes

Do not create a second agent or a second persistent session for task extraction.

⸻

Markdown Task Extraction

Do not require a strict Markdown schema.

The input may contain tasks expressed as:

* headings;
* numbered sections;
* checklists;
* bullet lists;
* prose;
* combinations of the above.

Examples of valid inputs include:

## Add configuration
Add the new authentication settings.
## Add middleware
Implement authentication middleware.

and:

- Add the new API endpoint
- Update validation
- Add tests

and:

We need to add authentication.
First update the configuration with the new settings.
Then add middleware for protected routes.
Finally update the documentation.

Do not build a custom heuristic parser based primarily on heading names, regular expressions, or checkbox syntax.

Use the model to interpret the document semantically.

⸻

Task Model

Use a minimal internal representation:

interface ImplementationTask {
    title: string;
    instructions: string;
}
interface ImplementationPlan {
    tasks: ImplementationTask[];
}

Do not add fields unless they are required by the existing pi-agent API.

Specifically avoid introducing:

* dependencies;
* priority;
* persisted status;
* model configuration;
* thinking level;
* agent configuration;
* estimated effort;
* metadata.

Execution state can remain in memory.

⸻

Task Extraction Prompt

Create a small, explicit prompt used by the isolated model invocation to convert the Markdown document into structured tasks.

Use wording equivalent to:

Analyze the Markdown document and identify the implementation tasks it describes.
The document may use any Markdown structure and does not follow a strict schema.
Extract the logical implementation tasks in their intended execution order.
For each task provide:
- a short title
- the complete instructions necessary to execute it
Preserve important technical details from the source document.
Do not invent tasks or requirements.
Do not omit implementation-relevant details.
Do not split closely related steps unnecessarily.
Do not include explanatory sections that do not require implementation.

Prefer structured output supported by the current pi-agent/model APIs.

Expected logical result:

{
  "tasks": [
    {
      "title": "Add configuration",
      "instructions": "Add the required configuration fields and validation."
    },
    {
      "title": "Implement middleware",
      "instructions": "Create authentication middleware and apply it to protected routes."
    }
  ]
}

Validate the returned structure.

At minimum:

* tasks must contain at least one item;
* every task must have a non-empty title;
* every task must have non-empty instructions.

If no tasks can be identified, report a clear error and stop.

⸻

Minimal UI

Use existing pi-agent UI components and conventions.

Do not introduce a new UI framework.

Before execution

Show the source file and detected tasks.

Example:

Implement plan.md
1. Add configuration
2. Implement middleware
3. Update documentation
3 tasks detected.
> Implement
  Cancel

The user does not need to edit, reorder, enable, or disable individual tasks in this version.

⸻

Progress UI

During execution, display the current state of the tasks.

Example:

Implementation
✓ 1/3 Add configuration
● 2/3 Implement middleware
○ 3/3 Update documentation

Suggested states:

○ pending
● running
✓ completed
✗ failed

Reuse existing pi-agent rendering primitives where possible.

Avoid building an unnecessarily complex stateful UI.

⸻

Task Execution

Execute tasks strictly in their extracted order.

Conceptually:

for (const task of plan.tasks) {
    await executeTask(task);
}

executeTask() represents a normal turn in the active pi-agent session, not a direct low-level model call.

Each task must be submitted to the active session as a separate implementation instruction.

Use a prompt equivalent to:

Implement the following task from the implementation plan.
Title:
{{title}}
Instructions:
{{instructions}}
Work directly on the current project.
Complete only this task.
Do not start subsequent tasks.
When the task is complete, return control to the implementation workflow.

Keep the execution prompt short.

Normal pi-agent system instructions, project instructions, tool policies, model settings, thinking settings, and extension configuration must continue to apply.

The workflow must wait for the full agent turn to finish, including tool execution, before marking the task as completed and submitting the next one.

Do not infer task completion from an individual model response chunk or tool result.

⸻

Session Behavior

Use the current pi-agent session for all implementation tasks.

Expected flow:

task 1
  ↓
current session
  ↓
wait for complete turn
  ↓
task 2
  ↓
current session
  ↓
wait for complete turn
  ↓
task 3

This intentionally allows subsequent tasks to see:

* changes made by previous tasks;
* previous implementation decisions;
* the current repository state;
* existing conversation context.

The extraction call must remain outside this session history.

Do not implement fresh sessions or subagents in this version.

⸻

Failure Handling

If a task fails, stop sequential execution.

Example:

✓ 1/4 Add configuration
✗ 2/4 Implement middleware
○ 3/4 Add tests
○ 4/4 Update documentation
Implementation stopped.

Do not automatically continue to later tasks because they may depend on the failed task.

Use the existing pi-agent lifecycle/error signals to determine whether the agent turn completed successfully where possible.

Do not attempt to infer failure by parsing natural-language phrases from the assistant response.

If the existing pi-agent UI makes it straightforward, offer:

> Retry task
  Stop

Retry is optional for the first implementation if supporting it introduces disproportionate complexity.

A simple stop-on-failure implementation is acceptable.

⸻

Cancellation

Before execution, provide:

Implement
Cancel

During execution, reuse pi-agent’s existing interruption/cancellation mechanism.

Do not create a parallel custom cancellation system unless required by the extension API.

⸻

File Handling

Handle these cases cleanly:

* missing command argument;
* file not found;
* path is not a file;
* unreadable file;
* empty file;
* no implementation tasks detected;
* model task-extraction failure.

Return concise errors through the normal pi-agent UI.

Do not modify the input file.

⸻

Suggested Project Structure

Keep the extension small.

A reasonable structure is:

src/
  index.ts
  tasks.ts
  implement.ts
tests/
  tasks.test.ts
  implement.test.ts

Responsibilities:

src/index.ts

* register /implement;
* validate command arguments;
* start the implementation workflow.

src/tasks.ts

* read/accept Markdown content;
* perform the isolated model invocation;
* validate structured task output.

src/implement.ts

* preview detected tasks;
* manage execution state;
* submit implementation turns to the active session;
* execute tasks sequentially;
* update progress UI;
* stop on errors.

Only create a separate ui.ts if the actual implementation clearly benefits from it.

Avoid abstractions that are not needed by the current requirements.

⸻

Implementation Steps

1. Inspect Existing pi-agent APIs

Before writing code, inspect the current repository and identify the supported APIs for:

* extension registration;
* slash-command registration;
* standalone model invocation from an extension;
* accessing the currently selected model/provider configuration;
* structured model output, if available;
* disabling or omitting tools for an isolated inference call;
* submitting a normal instruction to the active agent session;
* detecting the end of a complete agent turn;
* detecting execution failures;
* terminal UI components;
* user confirmation/select UI;
* session interruption.

Pay particular attention to the distinction between:

1. low-level or standalone model inference;
2. active-session agent turns.

Use existing pi-agent patterns instead of inventing parallel mechanisms.

⸻

2. Add /implement

Register:

/implement <markdown-file>

Implement:

* argument parsing;
* file validation;
* file loading;
* useful errors.

Keep path handling consistent with existing pi-agent behavior.

⸻

3. Implement Task Extraction

Add:

Markdown
   ↓
isolated model invocation
   ↓
structured ImplementationPlan

Use the model currently selected by pi-agent.

The extraction call must not:

* enter the active conversation history;
* execute tools;
* mutate project state;
* create another persistent agent session.

Validate the returned data before continuing.

⸻

4. Implement Preview UI

Display:

* source filename/path;
* ordered task titles;
* task count;
* Implement;
* Cancel.

Do not execute anything until the user chooses Implement.

⸻

5. Implement Sequential Execution

For each task:

1. mark it as running;
2. refresh progress UI;
3. submit the task as a normal instruction to the active pi-agent session;
4. wait for the entire agent turn to finish;
5. mark it completed on success;
6. stop execution on failure;
7. continue with the next task only after successful completion.

There must never be more than one implementation task running at once.

Do not use the isolated extraction model API for implementation.

⸻

6. Implement Progress Display

Keep an in-memory execution state such as:

type TaskStatus = "pending" | "running" | "completed" | "failed";

Render the ordered tasks with their current statuses.

Do not persist status outside the running command.

⸻

7. Add Error Handling

Cover:

* input errors;
* file-reading errors;
* malformed extraction output;
* no detected tasks;
* isolated model invocation errors;
* task execution errors;
* user cancellation.

Errors should return control to pi-agent cleanly without leaving the extension in an inconsistent state.

⸻

Tests

Add focused automated tests.

Avoid brittle tests that depend heavily on exact terminal formatting.

File Handling

Test:

* missing argument;
* nonexistent file;
* empty file;
* valid Markdown file.

Model Invocation Boundary

Mock the relevant pi-agent APIs and verify that task extraction:

* invokes the standalone model boundary;
* uses the currently selected model/configuration where applicable;
* does not submit an agent turn to the active session;
* does not expose tools to the extraction invocation where the API supports controlling tools;
* does not mutate session history.

Verify separately that implementation:

* does submit each task through the active agent-session boundary;
* does not use the standalone extraction call to implement tasks.

This distinction should be covered explicitly because it is part of the extension’s intended architecture.

⸻

Task Extraction

Mock the model response and verify:

* structured output is converted correctly;
* task order is preserved;
* empty task lists are rejected;
* empty titles are rejected;
* empty instructions are rejected;
* malformed responses fail cleanly.

Where practical, include tests representing different source Markdown styles:

Heading-based

## Add API
Implement the endpoint.
## Add tests
Cover the endpoint.

Checklist

- [ ] Add endpoint
- [ ] Add validation
- [ ] Update tests

Prose

First add the configuration settings. Then implement the middleware.
Finally update the documentation.

The tests do not need to test model intelligence itself. Mock the isolated model boundary and test the extension’s handling of extracted tasks.

⸻

Sequential Execution

Mock active-session task execution.

Given:

task 1 → success
task 2 → success
task 3 → success

verify execution order is exactly:

task 1
task 2
task 3

Verify that task 2 starts only after the complete agent turn for task 1 has finished.

⸻

Failure Handling

Given:

task 1 → success
task 2 → failure
task 3 → success

verify:

task 1 executed
task 2 executed
task 3 not executed

Verify task 2 becomes failed and execution stops.

⸻

Cancellation

Verify that choosing Cancel from the preview causes no implementation tasks to execute.

⸻

UI State

Test the logical states rather than exact decorative formatting:

* tasks detected;
* pending;
* running;
* completed;
* failed;
* implementation complete.

⸻

Documentation

Update the project README with a concise but complete /implement section.

Document:

/implement <markdown-file>

Explain that it:

* accepts arbitrary Markdown task structures;
* uses an isolated call to the currently selected model to interpret tasks;
* does not add task-extraction messages to the active session;
* executes tasks sequentially through the active pi-agent session;
* waits for each complete agent turn before starting the next task;
* stops when a task fails;
* does not modify the source Markdown file.

Include at least two input examples using different Markdown structures.

Example:

## Backend
Add the endpoint and validation.
## Tests
Add tests for the new endpoint.

and:

- Add the configuration option
- Implement the feature
- Update documentation

Also document the intentionally limited scope of the first version where appropriate.

⸻

Out of Scope

Do not implement any of the following as part of this plan:

* subagents;
* multi-agent orchestration;
* fresh session per task;
* session handoff;
* parallel execution;
* dependency graphs;
* task prioritization;
* task selection;
* task reordering;
* task editing;
* persistent task status;
* resume after restarting pi-agent;
* modification of the Markdown source;
* automatic Markdown checkboxes;
* dedicated task-file schemas;
* conversion from a high-level plan into another task file;
* model selection;
* thinking-level selection;
* per-task model settings;
* context-window thresholds;
* automatic commits;
* Git branching;
* Git push/pull operations;
* automatic retries;
* background execution.

Do not add infrastructure intended mainly to support these possible future features.

⸻

Design Principles

Keep the implementation small and consistent with pi-agent.

Prefer:

* existing pi-agent APIs;
* existing UI primitives;
* direct control flow;
* small functions;
* explicit state;
* minimal dependencies;
* simple error handling.

Avoid:

* unnecessary abstractions;
* framework-like orchestration layers;
* speculative extensibility;
* custom parsers for arbitrary Markdown;
* custom session-management machinery.

The core implementation should remain easy to understand as:

read Markdown
    ↓
isolated model inference
    ↓
extract structured tasks
    ↓
preview tasks
    ↓
user confirms
    ↓
submit task 1 to active session
    ↓
wait for full agent turn
    ↓
submit task 2 to active session
    ↓
...
    ↓
finish or stop on failure

⸻

Definition of Done

The work is complete when:

* /implement <markdown-file> is registered and usable;
* arbitrary Markdown task documents can be semantically converted into ordered tasks;
* extraction uses a side-effect-free model invocation separate from the active agent session;
* extraction does not execute tools or pollute active conversation history;
* invalid input produces clear errors;
* users can preview the detected tasks and cancel;
* tasks execute one at a time through the active pi-agent session;
* each subsequent task starts only after the previous agent turn has fully completed;
* progress is visible through a minimal pi-agent UI;
* execution stops when a task fails;
* the source Markdown remains unchanged;
* automated tests explicitly cover the model-invocation boundary, parsing boundary, command behavior, sequential execution, failure handling, and cancellation;
* README documentation describes the command, behavior, limitations, and examples;
* the implementation introduces no unnecessary dependencies or orchestration infrastructure.vironment:

