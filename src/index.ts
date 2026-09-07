import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_DISABLED_CHOICE,
	COMPACTION_ENABLED_CHOICE,
	DEFAULT_COMPACTION_THRESHOLD_PERCENT,
	compactIfNeeded,
} from "./compaction.ts";
import { ActiveSessionExecutor, type TaskStatus } from "./executor.ts";
import { createLocalGit, type LocalGit } from "./git.ts";
import {
	GENERATED_TASKS_FILE,
	convertPlanToTaskDocument,
	generatedTasksFileExists,
	writeGeneratedTaskDocument,
} from "./plan.ts";
import {
	STATE_FILE_NAME,
	addStateFileToGitignore,
	deleteState,
	loadState,
	saveState,
	type ImplementationState,
} from "./state.ts";
import { buildTaskFilePrompt, indexTaskFile } from "./tasks.ts";

const PROGRESS_WIDGET = "implement-progress";
const PROGRESS_TASK_LIMIT = 5;
const GIT_CHECKPOINT_CHOICE = "Git checkpoints: new or current local branch";

type ExecutionOptions = {
	checkpoint: boolean;
	automaticCompaction: boolean;
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
	return readMarkdownInput(sourcePath, ctx.cwd, commandName);
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

export function formatPreview(title: string, tasks: TitledTaskList): string {
	const taskLines = tasks.tasks.map((task, index) => `${index + 1}. ${task.title}`);
	return [title, ...taskLines, `${tasks.tasks.length} ${tasks.tasks.length === 1 ? "task" : "tasks"} detected.`].join(
		"\n",
	);
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

async function completeCheckpoint(
	ctx: ExtensionCommandContext,
	git: LocalGit,
	state: ImplementationState,
): Promise<void> {
	const title = state.tasks[state.nextTaskIndex - 1].title.replace(/\s+/g, " ").trim();
	await git.commitChanges(ctx.cwd, `Task ${state.nextTaskIndex}: ${title}`);
	delete state.pendingCheckpoint;
	state.status = "running";
	delete state.error;
	await saveState(ctx.cwd, state);
}

async function executeTaskSet(
	commandName: string,
	progressTitle: string,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
	state: ImplementationState,
): Promise<void> {
	const tasks = { tasks: state.tasks };
	const statuses: TaskStatus[] = state.tasks.map((_, index) =>
		index < state.nextTaskIndex ? "completed" : "pending",
	);
	const update = () => updateProgressUi(ctx, progressTitle, tasks, statuses);
	update();

	const recoveringCheckpoint = state.pendingCheckpoint;
	if (recoveringCheckpoint) {
		try {
			await completeCheckpoint(ctx, git, state);
		} catch (error) {
			await saveFailure(ctx, commandName, state, state.nextTaskIndex, error);
			return;
		}
	}

	if (state.pendingCompaction || (recoveringCheckpoint && state.nextTaskIndex < state.tasks.length)) {
		try {
			await compactIfNeeded(
				ctx,
				state.automaticCompaction,
				DEFAULT_COMPACTION_THRESHOLD_PERCENT,
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
			state.pendingCheckpoint = true;
		}
		state.status = "running";
		delete state.error;
		try {
			await saveState(ctx.cwd, state);
			if (state.pendingCheckpoint) {
				await completeCheckpoint(ctx, git, state);
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
					DEFAULT_COMPACTION_THRESHOLD_PERCENT,
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
		await deleteState(ctx.cwd);
		report(ctx, commandName, "Implementation complete.", "info");
	} catch (error) {
		report(ctx, commandName, error instanceof Error ? error.message : String(error), "error");
	}
}

async function selectExecutionOptions(
	previewTitle: string,
	tasks: TitledTaskList,
	isRepository: boolean,
	ctx: ExtensionCommandContext,
	git: LocalGit,
): Promise<ExecutionOptions | undefined> {
	const choices = isRepository
		? ["Implement only", GIT_CHECKPOINT_CHOICE, "Cancel"]
		: ["Implement", "Cancel"];
	const choice = await ctx.ui.select(formatPreview(previewTitle, tasks), choices);
	if (choice !== "Implement" && choice !== "Implement only" && choice !== GIT_CHECKPOINT_CHOICE) {
		return undefined;
	}

	const checkpoint = choice === GIT_CHECKPOINT_CHOICE;
	if (checkpoint && !(await git.isWorkingTreeClean(ctx.cwd))) {
		throw new Error("A clean working tree is required for Git checkpoint mode.");
	}

	const compactionChoice = await ctx.ui.select("Automatic compaction between tasks?", [
		COMPACTION_DISABLED_CHOICE,
		COMPACTION_ENABLED_CHOICE,
	]);
	if (compactionChoice !== COMPACTION_DISABLED_CHOICE && compactionChoice !== COMPACTION_ENABLED_CHOICE) {
		return undefined;
	}

	let branchName: string | undefined;
	if (checkpoint) {
		branchName = (await ctx.ui.input("New local branch name (empty to use current branch)", "feature/task-checkpoints"))?.trim();
		if (branchName === undefined) {
			return undefined;
		}
		if (branchName) {
			await git.createBranch(ctx.cwd, branchName);
		} else {
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

	return {
		checkpoint,
		automaticCompaction: compactionChoice === COMPACTION_ENABLED_CHOICE,
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
		version: 1,
		cwd: resolve(cwd),
		sourcePath,
		tasks: tasks.tasks.map((task, index) => ({ title: task.title, prompt: prompts[index] })),
		nextTaskIndex: 0,
		status: "running",
		checkpoint: options.checkpoint,
		automaticCompaction: options.automaticCompaction,
		branchName: options.branchName,
	};
}

export async function runTasksWorkflow(
	input: MarkdownInput,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
	ignoreStateFile: boolean,
	isRepository: boolean,
): Promise<void> {
	const commandName = "/implement-tasks";
	report(ctx, commandName, `Indexing tasks in ${input.sourcePath}...`, "info");
	const taskIndex = await indexTaskFile(input.markdown, ctx);
	const options = await selectExecutionOptions(
		`Implement tasks from ${input.sourcePath}`,
		taskIndex,
		isRepository,
		ctx,
		git,
	);
	if (!options) {
		report(ctx, commandName, "Task-file implementation cancelled.", "info");
		return;
	}

	if (ignoreStateFile) {
		await addStateFileToGitignore(ctx.cwd);
	}
	const prompts = taskIndex.tasks.map((task, index) => buildTaskFilePrompt(input.sourcePath, index + 1, task));
	await executeTaskSet(
		commandName,
		"Task-file implementation",
		ctx,
		executor,
		git,
		createImplementationState(ctx.cwd, input.sourcePath, taskIndex, prompts, options),
	);
}

function formatRestorePrompt(state: ImplementationState): string {
	const taskNumber = Math.min(state.nextTaskIndex + 1, state.tasks.length);
	const lines = [
		"Unfinished implementation found",
		"Workflow: /implement-tasks",
		`Task: ${taskNumber}/${state.tasks.length}`,
		`Status: ${state.status}`,
	];
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
): Promise<boolean> {
	const state = await loadState(ctx.cwd);
	if (!state) {
		return false;
	}

	const choice = await ctx.ui.select(formatRestorePrompt(state), ["Resume", "Discard and start new", "Cancel"]);
	if (choice === "Discard and start new") {
		await deleteState(ctx.cwd);
		return false;
	}
	if (choice !== "Resume") {
		report(ctx, requestedCommand, "Implementation resume cancelled.", "info");
		return true;
	}

	const currentCwd = resolve(ctx.cwd);
	if (currentCwd !== state.cwd) {
		throw new Error(
			`Cannot resume this implementation from a different working directory.\nExpected: ${state.cwd}\nCurrent: ${currentCwd}`,
		);
	}

	if (state.checkpoint) {
		const currentBranch = await git.currentBranch(ctx.cwd);
		if (currentBranch !== state.branchName) {
			throw new Error(
				`Cannot resume: expected local branch ${JSON.stringify(state.branchName)}, but current branch is ${JSON.stringify(currentBranch || "detached HEAD")}. Switch branches manually and try again.`,
			);
		}
	}

	await executeTaskSet("/implement-tasks", "Task-file implementation", ctx, executor, git, state);
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
			if (await handleExistingState(commandName, ctx, executor, git)) {
				return;
			}
			const isRepository = await git.isRepository(ctx.cwd);
			const ignoreStateFile = isRepository
				? await ctx.ui.select(`Add ${STATE_FILE_NAME} to .gitignore?`, ["Yes", "No"])
				: "No";
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
				await runTasksWorkflow(input, ctx, executor, git, ignoreStateFile, isRepository);
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

				if (await generatedTasksFileExists(ctx.cwd)) {
					const overwrite = await ctx.ui.select(`${GENERATED_TASKS_FILE} already exists. Overwrite it?`, [
						"Overwrite",
						"Cancel",
					]);
					if (overwrite !== "Overwrite") {
						report(ctx, "/implement-plan", "Plan conversion cancelled.", "info");
						return;
					}
				}

				report(ctx, "/implement-plan", `Converting ${input.sourcePath} to ${GENERATED_TASKS_FILE}...`, "info");
				const markdown = await convertPlanToTaskDocument(input.markdown, ctx);
				const resolvedPath = await writeGeneratedTaskDocument(ctx.cwd, markdown);
				report(ctx, "/implement-plan", `Generated ${GENERATED_TASKS_FILE}.`, "info");
				await runTasksWorkflow(
					{ sourcePath: GENERATED_TASKS_FILE, resolvedPath, markdown },
					ctx,
					executor,
					git,
					ignoreStateFile,
					isRepository,
				);
			}),
	});
}
