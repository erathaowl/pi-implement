# Final review and confirmation validation

This checklist maps `plan.md` acceptance criteria to automated tests and live checks. It is not a claim that all acceptance gates have passed. Tests use simulated agent responses; a real-model review and physical-terminal rendering still require operator verification.

## Execution status

- Selected automated regression tests: **393 passed** (378 tests across the non-Git-fixture files, 10 read-only Git tests, and 5 state migration/schema tests). This includes 10 added end-to-end cases and 2 added viewport/selection cases.
- `npm run typecheck`: **passed**.
- `git diff --check`: **passed**.
- Full `npm test`: **not run in task 12**. `tests/git.test.ts`, `tests/initial-checkpoint.test.ts`, and `tests/recovery.test.ts` include fixtures that initialize local Git repositories and create commits. Running those fixtures requires authorization for Git mutations; the current task explicitly prohibits creating commits. Do not weaken, replace, or silently skip them to claim a full-suite pass.
- Windows 11 and Linux interactive TUI smoke checks: **pending**. The API environment has no physical interactive terminal or Windows host. Automated component rendering does not verify terminal emulators, fonts, key translation, or repaint behavior.
- Interactive RPC client and live-model semantic checks: **pending**.

The selected checks were run on Linux without an interactive TTY using:

```bash
node --test tests/compaction.test.ts tests/executor.test.ts tests/index.test.ts \
  tests/model.test.ts tests/package.test.ts tests/plan.test.ts tests/preferences.test.ts \
  tests/preparation.test.ts tests/preview.test.ts tests/review-artifacts.test.ts \
  tests/review.test.ts tests/state.test.ts tests/tasks.test.ts
node --test --test-name-pattern='repository detection|Git preparation' tests/git.test.ts
node --test --test-name-pattern='version-|review start|review result metadata|invalid phases' tests/recovery.test.ts
npm run typecheck
git diff --check
```

When Git mutations in disposable test fixtures are permitted, run the unfiltered gates from the project root:

```bash
npm test
npm run typecheck
```

The real-Git fixtures use isolated temporary repositories, never remotes, and remove them afterward. They still create actual local commits. No validation step requires fetching, pulling, pushing, cloning, or modifying remotes.

## Acceptance coverage

The numbers below refer to the final acceptance list in `plan.md`. Functional-requirement references identify the associated detailed contract. The test files contain automated coverage; execution status above distinguishes the tests actually run from the full suite awaiting authorization.

| Criterion | Automated coverage | Remaining live check |
| --- | --- | --- |
| 1: mandatory confirmation and mutation-free cancellation (FR-4.1–7) | `tests/index.test.ts`: both commands, summary Cancel/Escape, discard-then-cancel, dirty user files, unchanged tasks/ignore/state/preferences, changed source/target/branch/HEAD guards, RPC confirmation. `tests/preparation.test.ts`: deferred generated files and overwrite consent. | M1–M4: physical UI and actual pre-existing index/worktree snapshots. |
| 2: default-disabled review and old execution behavior (FR-1.1, FR-3.7) | `tests/index.test.ts`: both commands default to No, skip review/reference prompts, preserve preferences, finish without an extra turn or final compaction check. | M1: visibly selected defaults. |
| 3: independent model/thinking and confirmed preferences (FR-3.1–7) | `tests/model.test.ts`, `tests/preferences.test.ts`: first use, cross-project preference, stale/incompatible pairs, cancelled configuration, exact recovery. `tests/index.test.ts`: prompt order, confirmed serialization, settings at each submitted turn, restoration and restoration failure. | M2/M5: installed model availability and live switching. |
| 4: evidence-based compliance, meaningful tests, documentation, unknowns (FR-1.3–5) | `tests/review.test.ts`: prompt requirements, all-area evidence, failed/unavailable checks, bounded result parsing, contradictions and non-stop failures. `tests/executor.test.ts`: active tool-enabled lifecycle settling and final-text capture. | M5: actual tools/checks and relevance of evidence; schema validation cannot prove the model's claims. |
| 5: verified fixes and consistent remediation (FR-2.1–6, FR-1.6) | `tests/review-artifacts.test.ts`: directly executed syntax checks, verified/unverified fixes, all severities, both fresh artifacts, missing/stale/mismatched files, ordered tasks, no-action artifacts untouched. `tests/index.test.ts`: both commands end-to-end for passed/fixed/follow_up/blocked, exact new paths, no automatic remediation execution. | M5: realistic fix scope and inspection of the separately initiated next step. |
| 6: review ordering, once-per-completed-run, recovery (FR-1.2, FR-5.3–5,7) | `tests/index.test.ts`: tasks and checkpoints precede review, task/checkpoint/model failure, pre-review compaction and forced recovery, interruption, invalid output/artifacts, persisted completion before restoration/reporting/cleanup. End-to-end tests combine confirmation, both compaction boundaries, review checkpoint failure and cross-command resume. | M2/M5: live interruption and source limitations. |
| 7: distinct local task/review commits, no duplicates (FR-6.1–6, FR-5.6) | `tests/index.test.ts`: simulated distinct messages, changed/unchanged review, disabled checkpoints, failed review, branch/HEAD guards, pending metadata before Git writes, metadata unstaging, already-committed recovery and later work untouched. `tests/git.test.ts`, `tests/initial-checkpoint.test.ts`, `tests/recovery.test.ts`: real-Git exclusion, index preservation and idempotency fixtures. | Full suite with authorized disposable Git fixtures; M6 for a live extension run, if authorized. |
| 8: version-1 compatibility and exact-phase recovery (FR-5.1–4) | `tests/state.test.ts`, `tests/recovery.test.ts`: migration, atomic writes, phases, setup/result validation. `tests/index.test.ts`: old pending operations, retained prepared Markdown/provenance, setup resume without conversion, working-directory/branch guards, exact pairs and no re-review after completion. | M2: real resume summary and cancellation. |
| 9: long/small/resized UI and non-TUI confirmation (FR-4.3) | `tests/preview.test.ts`: long Unicode/wrapped content, review on/off, start/resume, PageUp/PageDown, arrow/Enter/Escape/Ctrl+C, fixed actions, selected action at tiny sizes, grow/shrink, explicit defaults and RPC selection. `tests/index.test.ts`: both RPC command gates plus review-enabled RPC checkpoint recovery. | M1–M3: Windows 11/Linux terminal and real RPC client matrix below. |
| 10: full tests, typecheck and documentation | `README.md` documents command/settings order, confirmation, provenance, review preferences/results/artifacts, limitations, local Git and recovery. All focused checks are listed above. | Unfiltered `npm test` requires authorized Git fixture mutations; physical checks remain pending. |

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
