# pi-implement-markdown

A minimal [pi](https://pi.dev) extension that interprets implementation tasks from arbitrary Markdown and executes them one at a time in the current session.

## Use

Load the extension directly while developing:

```bash
pi -e ./src/index.ts
```

Or install this directory as a local pi package:

```bash
pi install /absolute/path/to/pi-implement-markdown
```

Then run:

```text
/implement <markdown-file>
```

For example:

```text
/implement plan.md
/implement docs/tasks.md
```

The command reads the file, uses an isolated completion with the currently selected model to identify the ordered implementation tasks, and shows the detected titles for confirmation. Choosing **Implement** submits each task as a separate normal instruction to the active pi session. It waits for the complete agent turn—including tool execution, retries, and compaction—before starting the next task. It stops on the first failed, truncated, or cancelled turn.

Task extraction is separate from the active session: it sends only the extraction prompt and Markdown to `ModelRegistry.complete`, supplies no tools (`toolChoice: "none"`), and does not add its prompt or response to conversation history. The provider-neutral extension API does not expose one structured-response format across every provider, so the command requests JSON text and validates it before showing the preview.

The source Markdown file is read-only. The extension does not edit it or persist workflow status.

## Markdown examples

No dedicated task-file schema is required. Headings and prose can be mixed:

```markdown
## Backend
Add the endpoint and validation.

## Tests
Add tests for the new endpoint.
```

A list works as well:

```markdown
- Add the configuration option
- Implement the feature
- Update documentation
```

Checklists, numbered sections, and prose instructions are also interpreted semantically by the selected model rather than by a heading or checkbox parser.

## Scope

This first version intentionally provides only preview/cancel, sequential execution, in-memory progress, stop-on-failure behavior, and pi's normal interruption mechanism. It does not provide task editing or reordering, persistence or resume, retries, parallelism, subagents, dependency graphs, model selection, or Git automation.

An interactive UI (TUI or RPC UI) is required so execution can be confirmed.

## Tests

```bash
npm test
```
