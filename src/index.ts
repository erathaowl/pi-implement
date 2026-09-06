import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	COMPACTION_DISABLED_CHOICE,
	COMPACTION_ENABLED_CHOICE,
	DEFAULT_COMPACTION_THRESHOLD_PERCENT,
	compactIfNeeded,
} from "./compaction.ts";
import { ActiveSessionExecutor, runPromptSequence, type TaskStatus } from "./executor.ts";
import { createLocalGit, type LocalGit } from "./git.ts";
import {
	GENERATED_TASKS_FILE,
	convertPlanToTaskDocument,
	generatedTasksFileExists,
	writeGeneratedTaskDocument,
} from "./plan.ts";
import { buildRewritePrompt, extractRewritePlan } from "./rewrite.ts";
import { buildTaskFilePrompt, indexTaskFile } from "./tasks.ts";

const PROGRESS_WIDGET = "implement-progress";

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

	return [
		title,
		...tasks.tasks.map(
			(task, index) =>
				`${symbols[statuses[index] ?? "pending"]} ${index + 1}/${tasks.tasks.length} ${task.title}`,
		),
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

async function executeTaskSet(
	commandName: string,
	progressTitle: string,
	tasks: TitledTaskList,
	prompts: readonly string[],
	ctx: ExtensionCommandContext,
	executePrompt: (prompt: string, index: number) => Promise<void>,
): Promise<void> {
	const result = await runPromptSequence(prompts, executePrompt, (statuses) =>
		updateProgressUi(ctx, progressTitle, tasks, statuses),
	);

	if (result.completed) {
		report(ctx, commandName, "Implementation complete.", "info");
	} else {
		report(ctx, commandName, `Implementation stopped: ${result.error?.message ?? "task failed"}`, "error");
	}
}

async function executeTaskFileSet(
	tasks: TitledTaskList,
	prompts: readonly string[],
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
	checkpoint: boolean,
	automaticCompaction: boolean,
): Promise<void> {
	const statuses: TaskStatus[] = prompts.map(() => "pending");
	const update = () => updateProgressUi(ctx, "Task-file implementation", tasks, statuses);
	update();

	for (let index = 0; index < prompts.length; index++) {
		statuses[index] = "running";
		update();

		try {
			await executor.execute(prompts[index]);
		} catch (error) {
			statuses[index] = "failed";
			update();
			report(
				ctx,
				"/implement-tasks",
				`Implementation stopped: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}

		statuses[index] = "completed";
		update();

		try {
			if (checkpoint && (await git.hasChanges(ctx.cwd))) {
				const title = tasks.tasks[index].title.replace(/\s+/g, " ").trim();
				await git.commitChanges(ctx.cwd, `Task ${index + 1}: ${title}`);
			}

			if (index + 1 < prompts.length) {
				await compactIfNeeded(
					ctx,
					automaticCompaction,
					DEFAULT_COMPACTION_THRESHOLD_PERCENT,
					index + 2,
				);
			}
		} catch (error) {
			report(
				ctx,
				"/implement-tasks",
				`Implementation stopped: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}
	}

	report(ctx, "/implement-tasks", "Implementation complete.", "info");
}

async function runRewriteWorkflow(
	input: MarkdownInput,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
): Promise<void> {
	const commandName = "/implement-rewrite";
	report(ctx, commandName, `Rewriting tasks in ${input.sourcePath}...`, "info");
	const plan = await extractRewritePlan(input.markdown, ctx);
	const choice = await ctx.ui.select(formatPreview(`Rewrite and implement ${input.sourcePath}`, plan), [
		"Implement",
		"Cancel",
	]);
	if (choice !== "Implement") {
		report(ctx, commandName, "Rewrite implementation cancelled.", "info");
		return;
	}

	await executeTaskSet(
		commandName,
		"Rewrite implementation",
		plan,
		plan.tasks.map(buildRewritePrompt),
		ctx,
		executor.execute,
	);
}

export async function runTasksWorkflow(
	input: MarkdownInput,
	ctx: ExtensionCommandContext,
	executor: ActiveSessionExecutor,
	git: LocalGit,
): Promise<void> {
	const commandName = "/implement-tasks";
	const isRepository = await git.isRepository(ctx.cwd);
	report(ctx, commandName, `Indexing tasks in ${input.sourcePath}...`, "info");
	const taskIndex = await indexTaskFile(input.markdown, ctx);
	const choices = isRepository
		? ["Implement only", "New local branch + commit after each task", "Cancel"]
		: ["Implement", "Cancel"];
	const choice = await ctx.ui.select(formatPreview(`Implement tasks from ${input.sourcePath}`, taskIndex), choices);
	if (choice !== "Implement" && choice !== "Implement only" && choice !== "New local branch + commit after each task") {
		report(ctx, commandName, "Task-file implementation cancelled.", "info");
		return;
	}

	const checkpoint = choice === "New local branch + commit after each task";
	if (checkpoint && !(await git.isWorkingTreeClean(ctx.cwd))) {
		throw new Error("A clean working tree is required for Git checkpoint mode.");
	}

	const compactionChoice = await ctx.ui.select("Automatic compaction between tasks?", [
		COMPACTION_DISABLED_CHOICE,
		COMPACTION_ENABLED_CHOICE,
	]);
	if (compactionChoice !== COMPACTION_DISABLED_CHOICE && compactionChoice !== COMPACTION_ENABLED_CHOICE) {
		report(ctx, commandName, "Task-file implementation cancelled.", "info");
		return;
	}

	if (checkpoint) {
		const branchName = (await ctx.ui.input("New local branch name", "feature/task-checkpoints"))?.trim();
		if (!branchName) {
			report(ctx, commandName, "Task-file implementation cancelled.", "info");
			return;
		}
		await git.createBranch(ctx.cwd, branchName);
	}

	await executeTaskFileSet(
		taskIndex,
		taskIndex.tasks.map((task, index) => buildTaskFilePrompt(input.sourcePath, index + 1, task)),
		ctx,
		executor,
		git,
		checkpoint,
		compactionChoice === COMPACTION_ENABLED_CHOICE,
	);
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
		workflow: () => Promise<void>,
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
			await workflow();
		} catch (error) {
			report(ctx, commandName, error instanceof Error ? error.message : String(error), "error");
		} finally {
			ctx.ui.setWorkingMessage();
			workflowRunning = false;
		}
	};

	pi.registerCommand("implement-rewrite", {
		description: "Rewrite Markdown into self-contained tasks and implement them sequentially",
		handler: async (args, ctx) =>
			runCommand("/implement-rewrite", ctx, async () => {
				const input = await readMarkdownInput(args, ctx.cwd, "/implement-rewrite");
				await runRewriteWorkflow(input, ctx, executor);
			}),
	});

	pi.registerCommand("implement-tasks", {
		description: "Implement tasks sequentially from an authoritative Markdown task file",
		handler: async (args, ctx) =>
			runCommand("/implement-tasks", ctx, async () => {
				const input = await readMarkdownInput(args, ctx.cwd, "/implement-tasks");
				await runTasksWorkflow(input, ctx, executor, git);
			}),
	});

	pi.registerCommand("implement-plan", {
		description: "Convert a plan to tasks.md and implement it through the task-file workflow",
		handler: async (args, ctx) =>
			runCommand("/implement-plan", ctx, async () => {
				const input = await readMarkdownInput(args, ctx.cwd, "/implement-plan");
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
				);
			}),
	});
}
