# Workflow validation

This checklist maps `plan (2).md` permission-aware execution and the earlier `plan.md` review/confirmation requirements to automated tests and live checks. It is not a claim that all acceptance gates have passed. Tests use simulated agent responses; a real-model review and physical-terminal rendering still require operator verification.

## Execution status

Current validation for `plan (2).md`, Task 6, on 2026-11-11 (Linux, Node.js 24.22.1, Pi 0.85.1):

- Full unfiltered suite: **500 passed, 0 failed, 0 cancelled, 0 skipped**. Includes real local Git fixtures, legacy-state migration, final-review regressions, paused recovery after a fresh process, and installed-SDK permission-gate integration.
- `npm run typecheck`: **passed**.
- `git diff --check`: **passed**.
- Pi CLI startup and cancellation of an implementation setup dialog: **passed in a Linux PTY**, with no workflow writes.
- Actual `@gotgenes/pi-permission-system` **36.2.1** gate and TUI dialog: **approve, deny, Escape/cancel, and deferred approval exercised in a Linux PTY** with a test-only adapter; see the scope and evidence below.
- Live-model end-to-end permission workflow: **not run**. The adapter supplied synthetic agent lifecycle events and task-result text; it did not execute a model or a shell tool.
- Windows and the earlier physical-terminal/manual review matrix: **not run** in this Linux cloud environment. Linux PTY checks do not establish Windows key handling or physical-terminal rendering.

From the repository root:

```bash
npm test
npm run typecheck
git diff --check
```

This cloud machine has protected `.git` markers in `/tmp` and `/workspace`. Use `TMPDIR=/var/tmp npm test` here so temporary non-repository fixtures are not mistaken for children of those markers. The suite was run with permission to write temporary fixtures under `/var/tmp`. The real-Git fixtures create isolated repositories and local commits and remove them afterward; they never use remotes. Do not weaken assertions or skip those fixtures to claim a full-suite pass.

## Permission-aware execution coverage

The numbers correspond to Task 6 in `plan (2).md`. Automated agent responses remain simulated; these tests do not establish semantic correctness of a model's completion claim.

| Case | Executed coverage |
| --- | --- |
| 1–2: open prompt / approval | `tests/executor.test.ts` verifies lifecycle settlement, nested/overlapping prompts, and the installed Pi `permission-gate.ts` example through the real `ExtensionRunner`; `tests/index.test.ts` holds commits, compaction, next task and review until closure plus validated completion. |
| 3–4: denied/deferred/unconfirmed | Both commands pause at the first or last task on waiting, missing, malformed, duplicate and wrong-task reports. No success checkpoint, compaction or review occurs. |
| 5: completed | Existing ordering tests exercise saved progress, distinct task checkpoints, between-task compaction, independent review and review checkpoint recovery with explicit completion results. |
| 6: provider/cancellation/shutdown | Non-stop reasons reject even with completion text. Session shutdown during a live prompt retains the exact unfinished index, clears the waiting UI, and ignores late prompt/settlement events. |
| 7–8: deliberate resume / repeated waits | Both commands restore the saved settings and issue one continuation for the unfinished task; denial pauses again without retries. Recovery tests use a fresh Node process, preserve partial files, and create one real success checkpoint. |
| 8, 10: tool result variability | Tool results in both completion orders, arbitrary denial-shaped details, handled errors, and result markers inside tools cannot supply task completion or invent an active dialog. No undocumented error-string classifier is used. |
| 9: compatibility | Version-1 migration, existing version-2 states, atomic paused-state validation, pending checkpoint/compaction recovery and all final-review tests pass in the full suite. Review's result protocol is unchanged. |

### Installed API and actual permission extension

Pi 0.85.1 declares `ui_prompt_start` and `ui_prompt_end` with `reason: "ui_prompt"`, a kind (`select`, `confirm`, `input`, `editor`, `custom`) and optional title. They have no prompt ID. Its runner emits the outermost start/end as queued microtasks. `agent_settled` in this SDK has no declared `aborted` field; stop reasons, shutdown, and the executor's optional aborted signal are tested separately. No Windows event ordering is inferred from the Linux checks.

The permission extension identified by the user was installed only in a separate validation directory; repository dependencies and lockfiles were unchanged. Registry metadata showed release 42.0.0 requires Pi/TUI >=1.0.0. Release 36.2.1 declares >=0.79.0 and was selected for this repository's pinned 0.85.1. This is evidence for 36.2.1, not a compatibility claim for 42.0.0.

In 36.2.1, the fail-closed tool-call boundary returns `{ block: true, reason }`; it does not add a permission-specific `tool_result` field. Its documented `permissions:ui_prompt` and `permissions:decision` broadcasts use a permission `requestId`, not Pi's `toolCallId`. `pi-implement` observes the SDK's blocking UI events and relies on the final explicit task result when a permission-specific tool result is unavailable. It does not infer approval from arbitrary `isError`, prose, or unrelated tool completion order.

### Linux PTY dialog smoke evidence

The test adapter loaded the real 36.2.1 extension, retained its registered `tool_call` handler, and invoked it for a **non-executed** `printf smoke` call from a diagnostic slash command in Pi's TUI. Pi's wrapped UI emitted events to `ActiveSessionExecutor`. After the gate returned, the adapter supplied a successful stop and a synthetic task result matching the gate's decision. No authorization rule was disabled, no session-wide grant was selected, and no model or shell command ran.

| Interaction | Observed evidence |
| --- | --- |
| Deferred approval | Real `Permission Required` dialog stayed open; evidence contained `ui_prompt_start(kind=custom)` and `waiting=true`, with no decision or completed outcome before input. |
| Approve (`yy`, double-press default) | `ui_prompt_end(kind=custom)`, `waiting=false`, gate allowed, synthetic task outcome `completed`. |
| Deny (`nn`) | Paired end event, waiting cleared, gate blocked, synthetic task outcome `waiting_for_user`. |
| Cancel (Escape) | Paired end event, waiting cleared, gate blocked, synthetic task outcome `waiting_for_user`. |

The temporary adapter and JSONL evidence are retained under `/workspace/pi-permission-validation` in this instance, outside the repository. This smoke verifies the actual extension's Linux dialog and SDK-event interaction. The automated workflow tests separately verify persistence and advancement gating. **It is not a live-model end-to-end workflow pass.**

### Remaining live acceptance checks

Use a disposable project, an isolated `PI_CODING_AGENT_DIR`, a configured model, the supported Pi version, and the actual permission extension/version used in deployment. On Linux and Windows where supported, record OS, terminal, Pi/permission versions, dimensions, source task and observed event order.

1. Start a two-task workflow with checkpoints, compaction and final review enabled. Make task 1 require an `ask` permission, leave it open, and confirm no task 2 prompt, success commit, compaction or review starts.
2. Approve; confirm the same turn continues and only an explicit task-1 completion advances once.
3. Repeat with deny, Escape/cancel and deferred approval. If the turn settles blocked, confirm persisted `paused`, unchanged task index and the appropriate pause reason.
4. Restart Pi and explicitly Resume. Inspect partial files and the continuation, refuse again, then authorize and finish. Confirm no automatic retry, duplicate side effect or duplicate task commit. Keep completed task/review checkpoint recovery distinct from unfinished-task recovery.
5. Exercise handled tool errors, concurrent tools finishing in either order, provider errors, abort, truncation and shutdown. Verify permission rules remain authoritative and collect only non-sensitive evidence.

## Acceptance coverage

The numbers below refer to the final acceptance list in `plan.md`. Functional-requirement references identify the associated detailed contract. The test files contain automated coverage; execution status above records the completed full suite and the remaining live checks.

| Criterion | Automated coverage | Remaining live check |
| --- | --- | --- |
| 1: mandatory confirmation and mutation-free cancellation (FR-4.1–7) | `tests/index.test.ts`: both commands, summary Cancel/Escape, discard-then-cancel, dirty user files, unchanged tasks/ignore/state/preferences, changed source/target/branch/HEAD guards, RPC confirmation. `tests/preparation.test.ts`: deferred generated files and overwrite consent. | M1–M4: physical UI and actual pre-existing index/worktree snapshots. |
| 2: default-disabled review and old execution behavior (FR-1.1, FR-3.7) | `tests/index.test.ts`: both commands default to No, skip review/reference prompts, preserve preferences, finish without an extra turn or final compaction check. | M1: visibly selected defaults. |
| 3: independent model/thinking and confirmed preferences (FR-3.1–7) | `tests/model.test.ts`, `tests/preferences.test.ts`: first use, cross-project preference, stale/incompatible pairs, cancelled configuration, exact recovery. `tests/index.test.ts`: prompt order, confirmed serialization, settings at each submitted turn, restoration and restoration failure. | M2/M5: installed model availability and live switching. |
| 4: evidence-based compliance, meaningful tests, documentation, unknowns (FR-1.3–5) | `tests/review.test.ts`: prompt requirements, all-area evidence, failed/unavailable checks, bounded result parsing, contradictions and non-stop failures. `tests/executor.test.ts`: active tool-enabled lifecycle settling and final-text capture. | M5: actual tools/checks and relevance of evidence; schema validation cannot prove the model's claims. |
| 5: verified fixes and consistent remediation (FR-2.1–6, FR-1.6) | `tests/review-artifacts.test.ts`: directly executed syntax checks, verified/unverified fixes, all severities, both fresh artifacts, missing/stale/mismatched files, ordered tasks, no-action artifacts untouched. `tests/index.test.ts`: both commands end-to-end for passed/fixed/follow_up/blocked, exact new paths, no automatic remediation execution. | M5: realistic fix scope and inspection of the separately initiated next step. |
| 6: review ordering, once-per-completed-run, recovery (FR-1.2, FR-5.3–5,7) | `tests/index.test.ts`: tasks and checkpoints precede review, task/checkpoint/model failure, pre-review compaction and forced recovery, interruption, invalid output/artifacts, persisted completion before restoration/reporting/cleanup. End-to-end tests combine confirmation, both compaction boundaries, review checkpoint failure and cross-command resume. | M2/M5: live interruption and source limitations. |
| 7: distinct local task/review commits, no duplicates (FR-6.1–6, FR-5.6) | `tests/index.test.ts`: simulated distinct messages, changed/unchanged review, disabled checkpoints, failed review, branch/HEAD guards, pending metadata before Git writes, metadata unstaging, already-committed recovery and later work untouched. `tests/git.test.ts`, `tests/initial-checkpoint.test.ts`, `tests/recovery.test.ts`: real-Git exclusion, index preservation and idempotency fixtures. | Full suite passed; M6 remains for a live extension run. |
| 8: version-1 compatibility and exact-phase recovery (FR-5.1–4) | `tests/state.test.ts`, `tests/recovery.test.ts`: migration, atomic writes, phases, setup/result validation. `tests/index.test.ts`: old pending operations, retained prepared Markdown/provenance, setup resume without conversion, working-directory/branch guards, exact pairs and no re-review after completion. | M2: real resume summary and cancellation. |
| 9: long/small/resized UI and non-TUI confirmation (FR-4.3) | `tests/preview.test.ts`: long Unicode/wrapped content, review on/off, start/resume, PageUp/PageDown, arrow/Enter/Escape/Ctrl+C, fixed actions, selected action at tiny sizes, grow/shrink, explicit defaults and RPC selection. `tests/index.test.ts`: both RPC command gates plus review-enabled RPC checkpoint recovery. | M1–M3: Windows 11/Linux terminal and real RPC client matrix below. |
| 10: full tests, typecheck and documentation | `README.md` documents command/settings order, confirmation, provenance, review preferences/results/artifacts, limitations, local Git and recovery. Full-suite and typecheck results are recorded above. | Full suite passed; physical checks remain pending. |

## Manual UI matrix

Record the operator, date, OS, terminal/client version, Pi version, model pair, dimensions, result, and any failure for each row. **All rows are currently pending; none were manually passed in this API session.**

Use a disposable project directory and load the extension from an absolute local path, for example `pi -e /absolute/path/to/pi-implement/index.ts`. Use implementation-only mode for M1–M5 unless a row explicitly calls for authorized Git testing. Do not use a production worktree or a real user's preference file: set `PI_CODING_AGENT_DIR` to an isolated disposable agent directory with the model configuration needed for the check.

Prepare a Markdown task file with at least 100 numbered tasks, long titles, spaces, Unicode/wide characters and emoji; prepare a separate source plan. Use long local paths to make the execution summary wrap. For `/implement-plan`, pre-create `tasks.md` with recognizable content to exercise overwrite approval without an early write.

| ID | Environment | Dimensions / scenario | Status |
| --- | --- | --- | --- |
| M1-WT | Windows 11, Windows Terminal, PowerShell | Both commands; review off/on; 80×24 → 40×12 → 30×6 → 120×40 while task preview and summary are open. | Pending |
| M1-WC | Windows 11, classic console host | Repeat the long preview/summary and resize/navigation checks; note font and Unicode rendering. | Pending |
| M1-L | Linux, an actual xterm-compatible interactive terminal | Repeat both commands and the same shrink/grow sizes, including long Unicode paths/titles. | Pending |
| M2-W/L | Windows 11 and Linux terminals | Resume summary with saved review pair, pending work, long paths, then Cancel; repeat with Resume and a deliberately unavailable saved model. | Pending |
| M3 | Interactive RPC client implementing Pi extension UI requests | Both commands, review off/on; new Start/Cancel and recovery Resume/Cancel; long summary and dialog dismissal. | Pending |
| M4-W/L | Windows 11 and Linux, authorized disposable dirty Git fixture | Both commands; choose discard, configure replacement including overwrite/branch/review, then Cancel/Escape at the final summary. | Pending |
| M5-W/L | Windows 11 and Linux, live tool-enabled model session | Inspect real review checks, source limitations, verified small fix, unresolved findings and optional manual remediation start. | Pending |
| M6 | Authorized disposable local repository only | Complete task/review checkpoints, interrupt checkpoint completion, resume, and inspect history/metadata exclusion. | Pending; requires permission for local Git writes |

### M1: preview and summary controls

1. Open each command with the long input; approve a future overwrite for plan conversion. Confirm `tasks.md` still has its original bytes before **Start implementation**.
2. Scroll with PageDown to the end and PageUp to the beginning. The menu must stay visible, and scrolling must not move the selected action. Verify the task-preview Git mode separately from the final summary's **Cancel** default.
3. Inspect command, directory, source paths, task count, implementation pair, branch/checkpoint/initial-commit intent, compaction/threshold, review pair/scope, and pending file writes. Review off must omit the review model questions; review on must show the independent pair and any missing-plan limitation.
4. Shrink/grow the terminal through the matrix while scrolled and while each action is selected. At usable sizes both actions remain visible. At extremely narrow/short sizes labels may truncate and only the selected action may fit; it must remain navigable and accessible, with no overflow or stale repaint. Grow again and verify the labels/content recover.
5. Enter on the final summary's initial selection must cancel. Arrow up then Enter must explicitly select Start/Resume. Arrow down returns to Cancel; Escape and Ctrl+C cancel. Repeat after resizing. Inspect wide glyphs and check for flicker, clipped menu rows, or ghost text. Record screenshots if possible.

### M2: recovery UI and exact settings

1. In the disposable project, start an implementation-only run with review enabled and interrupt a task. Record the saved state bytes, current files and chosen pairs.
2. Start either implementation command; choose Resume, inspect its summary, then Cancel. State and project files must remain unchanged.
3. Resume again and verify saved paths/settings, no conversion/indexing/selection prompts, and retry only of unfinished work. Interrupt review before completion and verify that recovery retries review rather than completed tasks.
4. Make a required saved model unavailable in the disposable configuration. Resume must report an explicit error rather than silently selecting another pair. A completed review whose only remaining work is checkpoint/restoration/cleanup must not need the reviewer again.

### M3: RPC

Verify that the full summary reaches the client, **Cancel** is listed first, and only an explicit Start/Resume starts work. Dismissal or an unknown response must not start anything. Confirm both commands and saved-state cancellation, with and without review. Verify a noninteractive invocation fails before mutation.

### M4: dirty-state and discard cancellation

Only use a disposable repository whose local Git mutations have been separately authorized. Prepare distinct staged, unstaged and untracked content, an existing task target, `.gitignore`, and old recovery state. Before opening the command, record:

- `git --no-optional-locks status --porcelain=v2 --branch --untracked-files=all`;
- `git diff`, `git diff --cached`, and `git rev-parse HEAD`;
- exact bytes of task/plan/ignore/state files and the isolated review preferences.

Choose **Discard and start new**, approve a future task overwrite, choose checkpoint mode/new branch/review settings, then cancel at the final summary. Repeat with Escape and both commands. All snapshots, branch/HEAD, staged tree and dirty contents must match; the planned branch must not exist. Also alter a target externally while the summary is open: accepting the stale summary must fail without overwriting that external change.

### M5: live evidence and remediation

Use a small project with known requirements and intentionally include an omitted acceptance criterion, a relevant failing test and stale usage documentation. Inspect tool events: the reviewer must read the original plan/task source and actual code/tests/docs, run feasible checks, and cite results rather than treating a green unrelated suite as proof of coverage.

Allow a localized directly verifiable fix; confirm the pertinent validation really runs. An unavailable integration service must produce an explicit limitation, not a clean pass or a claimed verified fix. Omit the reference plan for `/implement-tasks`, and separately remove/change source material during review: the limitation or recoverable failure must be explicit, never invented compliance.

Actionable unresolved findings must overwrite both consistent remediation documents with ordered tasks, acceptance criteria and verification. Without actionable findings, pre-existing documents must keep their exact bytes and must not be advertised as new. Verify the final report and that no generated task starts automatically. Only after inspection, explicitly initiate `/implement-tasks tasks-fixes.md` if desired; that is a new confirmed workflow, not a continuation launched by review.

### M6: live Git/recovery

Only after authorization for local Git writes in the disposable fixture, enable checkpoints. Verify task commits precede the review, review changes can add one descriptive review commit, and no-change reviews do not create empty commits. Verify state and its temporary file are absent from every new committed tree. Checkpoints disabled and invalid/interrupted reviews must not add a review commit. Interrupt after a successful checkpoint but before progress recording, resume, and verify the history has no duplicate commit and later external work was not staged. An unrelated HEAD/branch change must stop recovery instead of guessing.
