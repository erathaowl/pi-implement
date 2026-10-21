import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_DISABLED_CHOICE,
	COMPACTION_ENABLED_CHOICE,
	DEFAULT_COMPACTION_THRESHOLD_PERCENT,
	compactIfNeeded,
	parseCompactionThresholdPercent,
} from "./compaction.ts";
import { ActiveSessionExecutor, type TaskStatus } from "./executor.ts";
import { completeCheckpoint } from "./checkpoint.ts";
import { startExecutionSetup } from "./setup.ts";
export { startExecutionSetup } from "./setup.ts";
import { createLocalGit, type LocalGit } from "./git.ts";
import { assertFileUnchanged, snapshotFile } from "./files.ts";
import {
	applyImplementationSettings,
	applyReviewSettings,
	assertImplementationSettings,
	assertReviewSettingsAvailable,
	type ImplementationModelController,
	type ImplementationSettings,
} from "./model.ts";
import {
	GENERATED_TASKS_FILE,
	convertPlanToTaskDocument,
	generatedTasksPath,
	snapshotGeneratedTasks,
	validatePreparedTaskDocument,
	type PreparedTaskDocument,
} from "./plan.ts";
import {
	STATE_FILE_NAME,
	stateFileGitignoreContent,
	gitignorePath,
	deleteState,
	loadState,
	saveState,
	type ImplementationState,
	type ReviewSettings,
} from "./state.ts";
import { saveImplementationPreference, saveReviewPreference, selectPreferredImplementationSettings, selectPreferredReviewSettings } from "./preferences.ts";
import { executeReview, formatReviewResult } from "./review.ts";
import { buildTaskFilePrompt, indexTaskFile } from "./tasks.ts";
import { confirmExecutionSummary, selectTaskAction } from "./preview.ts";
export { formatPreview } from "./preview.ts";

const PROGRESS_WIDGET = "implement-progress";
const PROGRESS_TASK_LIMIT = 5;
const GIT_CHECKPOINT_CHOICE = "Git checkpoints: new or current local branch";

export type ExecutionOptions = ImplementationSettings & {
	review: ReviewSettings;
	createBranch: boolean;
	initiallyDirty: boolean;
	checkpoint: boolean;
	automaticCompaction: boolean;
	compactionThresholdPercent: number;
	branchName?: string;
};

type TitledTaskList = {
	tasks: readonly { title: string }[];
};

export interface MarkdownInput {
	sourcePath: string;
	resolvedPath: string;
	markdown: string;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as { code?: unknown }).code)
		: undefined;
}

export async function readMarkdownInput(
	argument: string,
	cwd: string,
	commandName: string,
): Promise<MarkdownInput> {
	const sourcePath = argument.trim();
	if (!sourcePath) {
		throw new Error(`Usage: ${commandName} <markdown-file>`);
	}

	const resolvedPath = resolve(cwd, sourcePath);
	let fileStats;
	try {
		fileStats = await stat(resolvedPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			throw new Error(`File not found: ${sourcePath}`);
		}
		throw new Error(`Unable to access file: ${sourcePath}`);
	}

	if (!fileStats.isFile()) {
		throw new Error(`Path is not a file: ${sourcePath}`);
	}

	let markdown: string;
	try {
		markdown = await readFile(resolvedPath, "utf8");
	} catch {
		throw new Error(`Unable to read file: ${sourcePath}`);
	}

	if (!markdown.trim()) {
		throw new Error(`Markdown file is empty: ${sourcePath}`);
	}

	return { sourcePath, resolvedPath, markdown };
}

async function readSourcePlanInput(argument: string, cwd: string, commandName: string): Promise<MarkdownInput> {
	if (!/\.(?:md|markdown)$/i.test(argument.trim())) {
		throw new Error("Source plan must be a Markdown file (.md or .markdown).");
	}
	const input = await readMarkdownInput(argument, cwd, commandName);
	if (input.markdown.includes("\0")) {
		throw new Error(`Source plan must contain Markdown text: ${input.sourcePath}`);
	}
	return input;
}

export async function selectSourcePlan(
	reviewEnabled: boolean,
	ctx: ExtensionCommandContext,
	sourcePlan?: MarkdownInput,
): Promise<MarkdownInput | null | undefined> {
	if (sourcePlan) return sourcePlan;
	if (!reviewEnabled) return null;
	const path = await ctx.ui.input("Optional reference plan for final review (blank for task-file-only review)", "path/to/plan.md");
	if (path === undefined) return undefined;
	if (!path.trim()) return null;
	return readSourcePlanInput(path, ctx.cwd, "/implement-tasks");
}

async function requestMarkdownInput(
	argument: string,
	ctx: ExtensionCommandContext,
	commandName: string,
): Promise<MarkdownInput | undefined> {
	const sourcePath = argument.trim()
		? argument
		: await ctx.ui.input(`Markdown file for ${commandName}`, "path/to/file.md");
	if (!sourcePath?.trim()) {
		return undefined;
	}
	return commandName === "/implement-plan"
		? readSourcePlanInput(sourcePath, ctx.cwd, commandName)
		: readMarkdownInput(sourcePath, ctx.cwd, commandName);
}

function report(
	ctx: ExtensionCommandContext,
	commandName: string,
	message: string,
	type: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		console.error(`[${commandName.slice(1)}] ${message}`);
	}
}

export function formatProgress(
	title: string,
	tasks: TitledTaskList,
	statuses: readonly TaskStatus[],
): string[] {
	const symbols: Record<TaskStatus, string> = {
		pending: "○",
		running: "●",
		completed: "✓",
		failed: "✗",
	};

	let currentIndex = tasks.tasks.findIndex((_, index) => statuses[index] === "running");
	if (currentIndex < 0) {
		currentIndex = tasks.tasks.findIndex((_, index) => statuses[index] === "failed");
	}
	if (currentIndex < 0) {
		currentIndex = tasks.tasks.findIndex((_, index) => (statuses[index] ?? "pending") === "pending");
	}
	if (currentIndex < 0) {
		currentIndex = Math.max(0, tasks.tasks.length - 1);
	}

	return [
		title,
		...tasks.tasks.slice(currentIndex, currentIndex + PROGRESS_TASK_LIMIT).map((task, visibleIndex) => {
			const index = currentIndex + visibleIndex;
			return `${symbols[statuses[index] ?? "pending"]} ${index + 1}/${tasks.tasks.length} ${task.title}`;
		}),
	];
}

function updateProgressUi(
	ctx: ExtensionCommandContext,
	title: string,
	tasks: TitledTaskList,
	statuses: readonly TaskStatus[],
): void {
	ctx.ui.setWidget(PROGRESS_WIDGET, formatProgress(title, tasks, statuses));
	const running = statuses.findIndex((status) => status === "running");
	if (running >= 0) {
		ctx.ui.setWorkingMessage(`Implementing ${running + 1}/${tasks.tasks.length}: ${tasks.tasks[running].title}`);
	} else {
		ctx.ui.setWorkingMessage();
	}
}

async function saveFailure(
	ctx: ExtensionCommandContext,
	commandName: string,
	state: ImplementationState,
	nextTaskIndex: number,
	error: unknown,
): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	state.nextTaskIndex = nextTaskIndex;
	state.status = "failed";
	state.error = message;
	try {
		await saveState(ctx.cwd, state);
		report(ctx, commandName, `Implementation stopped: ${message}`, "error");
	} catch (saveError) {
		report(
			ctx,
			commandName,
			`Implementation stopped: ${message}. ${saveError instanceof Error ? saveError.message : String(saveError)}`,
			"error",
		);
	}
}

async function finishWorkflow(
	commandName: string,
	ctx: ExtensionCommandContext,
	git: LocalGit,
	state: ImplementationState,
	modelController: ImplementationModelController,
): Promise<void> {
	if (state.pendingCompaction || (state.pendingCheckpoint && state.phase !== "review_checkpoint")) {
		throw new Error("Cannot finish while a checkpoint or compaction is pending.");
	}
	if (state.review.enabled) {
		if (!state.reviewResult) throw new Error("Cannot finish before a validated review result is saved.");
		if (state.phase === "review" && state.checkpoint) {
			state.phase = "review_checkpoint";
			state.pendingCheckpoint = { purpose: "review", message: "Review: apply fixes and record findings" };
			await saveState(ctx.cwd, state);
		}
		if (state.phase === "review_checkpoint" && state.pendingCheckpoint) {
			const branch = await git.currentBranch(ctx.cwd);
			if (branch !== state.branchName) {
				throw new Error(`Cannot checkpoint review: expected local branch ${JSON.stringify(state.branchName)}, but current branch is ${JSON.stringify(branch || "detached HEAD")}. Switch branches manually and try again.`);
			}
			await completeCheckpoint(ctx.cwd, git, state);
		}
		await applyImplementationSettings(state, ctx, modelController);
	}
	state.phase = "completed";
	state.status = "running";
	delete state.error;
	await saveState(ctx.cwd, state);
	if (state.reviewResult) {
		report(ctx, commandName, formatReviewResult(state.reviewResult, ctx.cwd),
			state.reviewResult.outcome === "passed" || state.reviewResult.outcome === "fixed" ? "info" : "warning");
	} else report(ctx, commandName, "Implementation complete.", "info");
	await deleteState(ctx.cwd);
}

async function executeReviewPhase(
	commandName: string,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
	state: ImplementationState,
	modelController: ImplementationModelController,
): Promise<void> {
	try {
		if (state.phase !== "review" || !state.review.enabled || state.nextTaskIndex !== state.tasks.length || state.pendingCheckpoint) {
			throw new Error("Cannot start final review before all tasks and task checkpoints complete.");
		}
		if (!state.reviewResult) {
			if (!state.reviewStarted) {
				await compactIfNeeded(ctx, state.automaticCompaction, state.compactionThresholdPercent, "final review",
					state.pendingCompaction === true, async () => {
						state.pendingCompaction = true;
						await saveState(ctx.cwd, state);
					});
				delete state.pendingCompaction;
			}
			// Persist the start before model switching or submitting an interruptible agent turn.
			state.reviewStarted = true;
			state.status = "running";
			delete state.error;
			await saveState(ctx.cwd, state);
			await readMarkdownInput(state.sourcePath, ctx.cwd, commandName);
			if (state.originalPlanPath) await readSourcePlanInput(state.originalPlanPath, ctx.cwd, commandName);
			await applyReviewSettings(state.review, ctx, modelController);
			ctx.ui.setWorkingMessage("Final implementation review");
			state.reviewResult = await executeReview(executor, state, ctx.cwd);
			// A completed, validated review must survive restoration, reporting, or cleanup failure.
			await saveState(ctx.cwd, state);
		}
		await finishWorkflow(commandName, ctx, git, state, modelController);
	} catch (error) {
		await saveFailure(ctx, commandName, state, state.nextTaskIndex, error);
	} finally {
		ctx.ui.setWorkingMessage();
	}
}

async function executeTaskSet(
	commandName: string,
	progressTitle: string,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
	state: ImplementationState,
	modelController: ImplementationModelController,
): Promise<void> {
	if (state.phase !== "tasks") throw new Error(`Cannot execute tasks during phase ${state.phase}.`);
	const tasks = { tasks: state.tasks };
	const statuses: TaskStatus[] = state.tasks.map((_, index) =>
		index < state.nextTaskIndex ? "completed" : "pending",
	);
	const update = () => updateProgressUi(ctx, progressTitle, tasks, statuses);
	update();

	const recoveringCheckpoint = state.pendingCheckpoint;
	if (recoveringCheckpoint) {
		try {
			await completeCheckpoint(ctx.cwd, git, state);
		} catch (error) {
			await saveFailure(ctx, commandName, state, state.nextTaskIndex, error);
			return;
		}
	}

	if (state.nextTaskIndex < state.tasks.length && (state.pendingCompaction || recoveringCheckpoint)) {
		try {
			await compactIfNeeded(
				ctx,
				state.automaticCompaction,
				state.compactionThresholdPercent,
				state.nextTaskIndex + 1,
				state.pendingCompaction === true,
				async () => {
					state.pendingCompaction = true;
					await saveState(ctx.cwd, state);
				},
			);
			delete state.pendingCompaction;
			state.status = "running";
			delete state.error;
			await saveState(ctx.cwd, state);
		} catch (error) {
			await saveFailure(ctx, commandName, state, state.nextTaskIndex, error);
			return;
		}
	}

	for (let index = state.nextTaskIndex; index < state.tasks.length; index++) {
		statuses[index] = "running";
		update();
		state.nextTaskIndex = index;
		state.status = "running";
		delete state.error;
		try {
			await saveState(ctx.cwd, state);
		} catch (error) {
			report(ctx, commandName, error instanceof Error ? error.message : String(error), "error");
			return;
		}

		try {
			assertImplementationSettings(state, ctx, modelController);
			await executor.execute(state.tasks[index].prompt);
		} catch (error) {
			statuses[index] = "failed";
			update();
			await saveFailure(ctx, commandName, state, index, error);
			return;
		}

		statuses[index] = "completed";
		update();

		state.nextTaskIndex = index + 1;
		if (state.checkpoint) {
			const title = state.tasks[index].title.replace(/\s+/g, " ").trim();
			state.pendingCheckpoint = { purpose: "task", message: `Task ${index + 1}: ${title}` };
		}
		state.status = "running";
		delete state.error;
		try {
			await saveState(ctx.cwd, state);
			if (state.pendingCheckpoint) {
				await completeCheckpoint(ctx.cwd, git, state);
			}
		} catch (error) {
			await saveFailure(ctx, commandName, state, state.nextTaskIndex, error);
			return;
		}

		if (index + 1 < state.tasks.length) {
			try {
				await compactIfNeeded(
					ctx,
					state.automaticCompaction,
					state.compactionThresholdPercent,
					index + 2,
					false,
					async () => {
						state.pendingCompaction = true;
						await saveState(ctx.cwd, state);
					},
				);
				delete state.pendingCompaction;
				await saveState(ctx.cwd, state);
			} catch (error) {
				await saveFailure(ctx, commandName, state, index + 1, error);
				return;
			}
		}
	}

	try {
		state.phase = state.review.enabled ? "review" : "completed";
		await saveState(ctx.cwd, state);
		if (state.phase === "review") await executeReviewPhase(commandName, ctx, executor, git, state, modelController);
		else await finishWorkflow(commandName, ctx, git, state, modelController);
	} catch (error) {
		await saveFailure(ctx, commandName, state, state.nextTaskIndex, error);
	}
}

export async function selectExecutionOptions(
	previewTitle: string,
	tasks: TitledTaskList,
	isRepository: boolean,
	ctx: ExtensionCommandContext,
	git: LocalGit,
	modelController: ImplementationModelController,
): Promise<ExecutionOptions | undefined> {
	const choices = isRepository
		? ["Implement only", GIT_CHECKPOINT_CHOICE, "Cancel"]
		: ["Implement", "Cancel"];
	const choice = await selectTaskAction(previewTitle, tasks, choices, isRepository ? 1 : 0, ctx);
	if (choice !== "Implement" && choice !== "Implement only" && choice !== GIT_CHECKPOINT_CHOICE) {
		return undefined;
	}

	const checkpoint = choice === GIT_CHECKPOINT_CHOICE;
	const initiallyDirty = checkpoint && !(await git.isWorkingTreeClean(ctx.cwd));

	const compactionChoice = await ctx.ui.select("Automatic compaction between tasks?", [
		COMPACTION_ENABLED_CHOICE,
		COMPACTION_DISABLED_CHOICE,
	]);
	if (compactionChoice !== COMPACTION_DISABLED_CHOICE && compactionChoice !== COMPACTION_ENABLED_CHOICE) {
		return undefined;
	}

	let compactionThresholdPercent = DEFAULT_COMPACTION_THRESHOLD_PERCENT;
	if (compactionChoice === COMPACTION_ENABLED_CHOICE) {
		const thresholdInput = await ctx.ui.input(
			`Compaction threshold percentage (default: ${DEFAULT_COMPACTION_THRESHOLD_PERCENT}%)`,
			String(DEFAULT_COMPACTION_THRESHOLD_PERCENT),
		);
		if (thresholdInput === undefined) {
			return undefined;
		}
		if (thresholdInput.trim()) {
			compactionThresholdPercent = parseCompactionThresholdPercent(thresholdInput);
		}
	}

	const implementationSettings = await selectPreferredImplementationSettings(ctx, modelController);
	if (!implementationSettings) {
		return undefined;
	}

	let branchName: string | undefined;
	let createBranch = false;
	if (checkpoint) {
		branchName = (await ctx.ui.input("New local branch name (empty to use current branch)", "feature/task-checkpoints"))?.trim();
		if (branchName === undefined) {
			return undefined;
		}
		createBranch = Boolean(branchName);
		if (!branchName) {
			const confirmed = await ctx.ui.confirm(
				"Continue on the current branch?",
				"Git checkpoints will commit changes directly to the current local branch.",
			);
			if (!confirmed) {
				return undefined;
			}
			branchName = await git.currentBranch(ctx.cwd);
			if (!branchName) {
				throw new Error("Cannot start Git checkpoint mode on a detached HEAD. Switch to a local branch and try again.");
			}
		}
	}

	const reviewChoice = await ctx.ui.select("Final review?", ["No", "Yes"]);
	if (reviewChoice !== "No" && reviewChoice !== "Yes") return undefined;
	const review = await selectPreferredReviewSettings(reviewChoice === "Yes", implementationSettings, ctx);
	if (!review) return undefined;

	return {
		...implementationSettings,
		review,
		createBranch,
		initiallyDirty,
		checkpoint,
		automaticCompaction: compactionChoice === COMPACTION_ENABLED_CHOICE,
		compactionThresholdPercent,
		branchName,
	};
}

function createImplementationState(
	cwd: string,
	sourcePath: string,
	tasks: TitledTaskList,
	prompts: readonly string[],
	options: ExecutionOptions,
): ImplementationState {
	return {
		version: 2,
		phase: "setup",
		review: options.review,
		cwd: resolve(cwd),
		sourcePath,
		originalPlanPath: null,
		tasks: tasks.tasks.map((task, index) => ({ title: task.title, prompt: prompts[index] })),
		nextTaskIndex: 0,
		status: "running",
		checkpoint: options.checkpoint,
		automaticCompaction: options.automaticCompaction,
		compactionThresholdPercent: options.compactionThresholdPercent,
		implementationModel: options.implementationModel,
		implementationThinkingLevel: options.implementationThinkingLevel,
		branchName: options.branchName,
	};
}

export async function runTasksWorkflow(
	input: MarkdownInput,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
	modelController: ImplementationModelController,
	ignoreStateFile: boolean,
	isRepository: boolean,
	preparedTasks?: PreparedTaskDocument,
	sourcePlan?: MarkdownInput,
): Promise<void> {
	const commandName = sourcePlan ? "/implement-plan" : "/implement-tasks";
	const previousState = JSON.stringify(await loadState(ctx.cwd));
	const gitSnapshot = isRepository ? await git.preflightSnapshot(ctx.cwd) : undefined;
	const ignorePath = await gitignorePath(ctx.cwd);
	const ignoreSnapshot = ignoreStateFile ? await snapshotFile(ignorePath) : undefined;
	report(ctx, commandName, `Indexing tasks in ${input.sourcePath}...`, "info");
	const taskIndex = await indexTaskFile(input.markdown, ctx);
	const options = await selectExecutionOptions(
		`Implement tasks from ${input.sourcePath}`,
		taskIndex,
		isRepository,
		ctx,
		git,
		modelController,
	);
	if (!options) {
		report(ctx, commandName, "Task-file implementation cancelled.", "info");
		return;
	}

	const prompts = taskIndex.tasks.map((task, index) => buildTaskFilePrompt(input.sourcePath, index + 1, task));
	const state = createImplementationState(ctx.cwd, input.sourcePath, taskIndex, prompts, options);
	const referencePlan = await selectSourcePlan(state.review.enabled, ctx, sourcePlan);
	if (referencePlan === undefined) {
		report(ctx, commandName, "Implementation cancelled.", "info");
		return;
	}
	state.originalPlanPath = referencePlan?.sourcePath ?? null;
	const baseBranch = gitSnapshot?.match(/^# branch.head (.*)$/m)?.[1];
	const baseHead = gitSnapshot?.match(/^# branch.oid (.*)$/m)?.[1];
	if (isRepository && (baseBranch === undefined || baseHead === undefined)) {
		throw new Error("Unable to read the Git setup snapshot.");
	}
	state.setup = {
		step: "branch",
		createBranch: options.createBranch,
		initialCheckpoint: options.initiallyDirty,
		baseBranch: baseBranch === "(detached)" ? "" : baseBranch ?? null,
		expectedHead: baseHead === "(initial)" ? null : baseHead ?? null,
		gitignore: ignoreSnapshot === undefined ? undefined : {
			before: ignoreSnapshot,
			content: stateFileGitignoreContent(ignoreSnapshot === null ? "" : await readFile(ignorePath, "utf8")),
		},
	};
	state.preparedTasks = preparedTasks;
	const confirmed = await confirmExecutionSummary({
		...options,
		command: commandName,
		cwd: state.cwd,
		sourcePlanPath: state.originalPlanPath,
		sourcePath: input.sourcePath,
		taskCount: taskIndex.tasks.length,
		review: state.review,
		preparedTasks: preparedTasks ? { overwrite: preparedTasks.destination !== null } : undefined,
		ignoreStateFile,
	}, ctx);
	if (!confirmed) {
		report(ctx, commandName, "Implementation cancelled.", "info");
		return;
	}

	// Recheck all preview assumptions before the first write. The saved run is replaced, never deleted first.
	if (JSON.stringify(await loadState(ctx.cwd)) !== previousState) {
		throw new Error("Recovery state changed during preparation. Prepare the workflow again.");
	}
	if (isRepository && await git.preflightSnapshot(ctx.cwd) !== gitSnapshot) {
		throw new Error("Git branch, HEAD, or working-tree status changed during preparation. Prepare the workflow again.");
	}
	for (const source of [preparedTasks ? undefined : input, referencePlan]) {
		if (source && await readFile(source.resolvedPath, "utf8") !== source.markdown) {
			throw new Error(`${source.sourcePath} changed during preparation. Prepare the workflow again.`);
		}
	}
	if (ignoreSnapshot !== undefined) await assertFileUnchanged(ignorePath, ignoreSnapshot);
	if (preparedTasks) await validatePreparedTaskDocument(ctx.cwd, preparedTasks);
	assertReviewSettingsAvailable(state.review, ctx);
	await saveImplementationPreference({ model: state.implementationModel, thinkingLevel: state.implementationThinkingLevel });
	if (state.review.enabled) await saveReviewPreference(state.review);
	// Persist all setup intent and generated Markdown before the first interruptible mutation.
	await saveState(ctx.cwd, state);
	try {
		await startExecutionSetup(ctx.cwd, git, state);
		await applyImplementationSettings(state, ctx, modelController);
	} catch (error) {
		await saveFailure(ctx, commandName, state, 0, error);
		return;
	}
	await executeTaskSet(
		commandName,
		"Task-file implementation",
		ctx,
		executor,
		git,
		state,
		modelController,
	);
}

function formatRestorePrompt(state: ImplementationState): string {
	const taskNumber = Math.min(state.nextTaskIndex + 1, state.tasks.length);
	const lines = [
		"Unfinished implementation found",
		`Workflow: ${state.preparedTasks ? "/implement-plan" : "/implement-tasks"}`,
		`Source plan: ${state.originalPlanPath ?? "None"}`,
		`Task file: ${state.sourcePath}`,
		`Task: ${taskNumber}/${state.tasks.length}`,
		`Status: ${state.status}`,
		`Phase: ${state.phase}`,
		`Model: ${state.implementationModel.provider}/${state.implementationModel.id}`,
		`Thinking: ${state.implementationThinkingLevel}`,
	];
	if (state.automaticCompaction) {
		lines.push(`Compaction threshold: ${state.compactionThresholdPercent}%`);
	}
	if (state.pendingCheckpoint) {
		lines.push("Pending Git checkpoint: yes");
	}
	if (state.pendingCompaction) {
		lines.push("Pending compaction: yes");
	}
	if (state.error) {
		lines.push(`Error: ${state.error}`);
	}
	return lines.join("\n");
}

async function handleExistingState(
	requestedCommand: string,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
	modelController: ImplementationModelController,
): Promise<boolean> {
	const state = await loadState(ctx.cwd);
	if (!state) {
		return false;
	}

	const choice = await ctx.ui.select(formatRestorePrompt(state), ["Resume", "Discard and start new", "Cancel"]);
	if (choice === "Discard and start new") {
		return false;
	}
	if (choice !== "Resume") {
		report(ctx, requestedCommand, "Implementation resume cancelled.", "info");
		return true;
	}

	if (!await confirmExecutionSummary({
		...state,
		command: state.preparedTasks ? "/implement-plan" : "/implement-tasks",
		sourcePlanPath: state.originalPlanPath ?? null,
		taskCount: state.tasks.length,
		createBranch: state.phase === "setup" && state.setup?.step === "branch" && state.setup.createBranch === true,
		initiallyDirty: state.phase === "setup" && state.setup?.initialCheckpoint === true &&
			(state.setup.step === "branch" || state.setup.step === "initial_checkpoint"),
		review: state.review,
		preparedTasks: state.phase === "setup" && state.preparedTasks ? { overwrite: state.preparedTasks.destination !== null } : undefined,
		ignoreStateFile: state.phase === "setup" && state.setup?.gitignore !== undefined &&
			state.setup.step !== "tasks_file",
	}, ctx, true)) {
		report(ctx, requestedCommand, "Implementation resume cancelled.", "info");
		return true;
	}
	if (JSON.stringify(await loadState(ctx.cwd)) !== JSON.stringify(state)) {
		throw new Error("Recovery state changed during confirmation. Run the command again.");
	}

	const currentCwd = resolve(ctx.cwd);
	if (currentCwd !== state.cwd) {
		throw new Error(
			`Cannot resume this implementation from a different working directory.\nExpected: ${state.cwd}\nCurrent: ${currentCwd}`,
		);
	}

	if (!state.reviewResult && state.phase !== "completed") assertReviewSettingsAvailable(state.review, ctx);
	if (state.phase === "setup") {
		try {
			await startExecutionSetup(ctx.cwd, git, state);
		} catch (error) {
			await saveFailure(ctx, requestedCommand, state, state.nextTaskIndex, error);
			return true;
		}
	}
	const expectedBranch = state.checkpoint ? state.branchName : state.setup?.baseBranch;
	if (expectedBranch !== undefined && expectedBranch !== null) {
		const currentBranch = await git.currentBranch(ctx.cwd);
		if (currentBranch !== expectedBranch) {
			throw new Error(
				`Cannot resume: expected local branch ${JSON.stringify(expectedBranch)}, but current branch is ${JSON.stringify(currentBranch || "detached HEAD")}. Switch branches manually and try again.`,
			);
		}
	}

	try {
		if (state.phase === "tasks" || (state.phase === "review" && !state.reviewStarted && !state.reviewResult)) {
			await applyImplementationSettings(state, ctx, modelController);
		}
		if (state.phase === "tasks") await executeTaskSet("/implement-tasks", "Task-file implementation", ctx, executor, git, state, modelController);
		else if (state.phase === "review") await executeReviewPhase(requestedCommand, ctx, executor, git, state, modelController);
		else await finishWorkflow(requestedCommand, ctx, git, state, modelController);
	} catch (error) {
		await saveFailure(ctx, requestedCommand, state, state.nextTaskIndex, error);
	}
	return true;
}

export default function implementExtension(pi: ExtensionAPI): void {
	let workflowRunning = false;
	const executor = new ActiveSessionExecutor((message) => pi.sendUserMessage(message));
	const git = createLocalGit((command, args, options) => pi.exec(command, args, options));

	pi.on("agent_start", () => executor.onAgentStart());
	pi.on("agent_end", (event) => executor.onAgentEnd(event.messages));
	pi.on("agent_settled", () => executor.onAgentSettled());
	pi.on("session_shutdown", () => executor.cancel("Task execution stopped because the session changed."));

	const runCommand = async (
		commandName: string,
		ctx: ExtensionCommandContext,
		workflow: (ignoreStateFile: boolean, isRepository: boolean) => Promise<void>,
	): Promise<void> => {
		if (!ctx.hasUI) {
			report(ctx, commandName, `${commandName} requires an interactive UI for confirmation.`, "error");
			return;
		}
		if (workflowRunning) {
			report(ctx, commandName, "An implementation workflow is already running.", "warning");
			return;
		}
		if (!ctx.isIdle()) {
			report(ctx, commandName, `Wait for the current agent turn to finish before using ${commandName}.`, "warning");
			return;
		}

		workflowRunning = true;
		ctx.ui.setWidget(PROGRESS_WIDGET, undefined);
		try {
			if (await handleExistingState(commandName, ctx, executor, git, pi)) {
				return;
			}
			const isRepository = await git.isRepository(ctx.cwd);
			const ignoreStateFile = isRepository
				? await ctx.ui.select(`Add ${STATE_FILE_NAME} to .gitignore?`, ["Yes", "No"])
				: "No";
			if (ignoreStateFile !== "Yes" && ignoreStateFile !== "No") return;
			await workflow(ignoreStateFile === "Yes", isRepository);
		} catch (error) {
			report(ctx, commandName, error instanceof Error ? error.message : String(error), "error");
		} finally {
			ctx.ui.setWorkingMessage();
			workflowRunning = false;
		}
	};

	pi.registerCommand("implement-tasks", {
		description: "Implement tasks sequentially from an authoritative Markdown task file",
		handler: async (args, ctx) =>
			runCommand("/implement-tasks", ctx, async (ignoreStateFile, isRepository) => {
				const input = await requestMarkdownInput(args, ctx, "/implement-tasks");
				if (!input) {
					report(ctx, "/implement-tasks", "Task-file implementation cancelled.", "info");
					return;
				}
				await runTasksWorkflow(input, ctx, executor, git, pi, ignoreStateFile, isRepository);
			}),
	});

	pi.registerCommand("implement-plan", {
		description: "Convert a plan to tasks.md and implement it through the task-file workflow",
		handler: async (args, ctx) =>
			runCommand("/implement-plan", ctx, async (ignoreStateFile, isRepository) => {
				const input = await requestMarkdownInput(args, ctx, "/implement-plan");
				if (!input) {
					report(ctx, "/implement-plan", "Plan conversion cancelled.", "info");
					return;
				}
				if (!ctx.model) {
					throw new Error("No model is selected.");
				}

				const destination = await snapshotGeneratedTasks(ctx.cwd);
				let overwriteApproved = false;
				if (destination !== null) {
					const [planFile, taskFile] = await Promise.all([stat(input.resolvedPath), stat(generatedTasksPath(ctx.cwd))]);
					if (planFile.dev === taskFile.dev && planFile.ino === taskFile.ino) {
						throw new Error("The source plan must be separate from tasks.md so the original plan remains available for review.");
					}
					const overwrite = await ctx.ui.select(`${GENERATED_TASKS_FILE} already exists. Overwrite it?`, [
						"Overwrite",
						"Cancel",
					]);
					overwriteApproved = overwrite === "Overwrite";
					if (!overwriteApproved) {
						report(ctx, "/implement-plan", "Plan conversion cancelled.", "info");
						return;
					}
				}

				report(ctx, "/implement-plan", `Converting ${input.sourcePath} to ${GENERATED_TASKS_FILE}...`, "info");
				const markdown = await convertPlanToTaskDocument(input.markdown, ctx);
				const resolvedPath = generatedTasksPath(ctx.cwd);
				await runTasksWorkflow(
					{ sourcePath: GENERATED_TASKS_FILE, resolvedPath, markdown },
					ctx,
					executor,
					git,
					pi,
					ignoreStateFile,
					isRepository,
					{ markdown, destination, overwriteApproved },
					input,
				);
			}),
	});
}
