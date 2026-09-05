import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	ActiveSessionTaskExecutor,
	formatPreview,
	formatProgress,
	runImplementationPlan,
	type TaskStatus,
} from "./implement.ts";
import { extractImplementationPlan } from "./tasks.ts";

const PROGRESS_WIDGET = "implement-progress";

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

export async function readMarkdownInput(argument: string, cwd: string): Promise<MarkdownInput> {
	const sourcePath = argument.trim();
	if (!sourcePath) {
		throw new Error("Usage: /implement <markdown-file>");
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

function report(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		console.error(`[implement] ${message}`);
	}
}

function updateProgressUi(
	ctx: ExtensionCommandContext,
	plan: Parameters<typeof formatProgress>[0],
	statuses: readonly TaskStatus[],
): void {
	ctx.ui.setWidget(PROGRESS_WIDGET, formatProgress(plan, statuses));
	const running = statuses.findIndex((status) => status === "running");
	if (running >= 0) {
		ctx.ui.setWorkingMessage(`Implementing ${running + 1}/${plan.tasks.length}: ${plan.tasks[running].title}`);
	} else {
		ctx.ui.setWorkingMessage();
	}
}

export default function implementExtension(pi: ExtensionAPI): void {
	let workflowRunning = false;
	const taskExecutor = new ActiveSessionTaskExecutor((message) => pi.sendUserMessage(message));

	pi.on("agent_start", () => taskExecutor.onAgentStart());
	pi.on("agent_end", (event) => taskExecutor.onAgentEnd(event.messages));
	pi.on("agent_settled", () => taskExecutor.onAgentSettled());
	pi.on("session_shutdown", () => taskExecutor.cancel("Task execution stopped because the session changed."));

	pi.registerCommand("implement", {
		description: "Implement tasks from a Markdown file sequentially",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				report(ctx, "/implement requires an interactive UI for confirmation.", "error");
				return;
			}
			if (workflowRunning) {
				report(ctx, "An implementation workflow is already running.", "warning");
				return;
			}
			if (!ctx.isIdle()) {
				report(ctx, "Wait for the current agent turn to finish before using /implement.", "warning");
				return;
			}

			workflowRunning = true;
			ctx.ui.setWidget(PROGRESS_WIDGET, undefined);

			try {
				const input = await readMarkdownInput(args, ctx.cwd);
				if (!ctx.model) {
					throw new Error("No model is selected.");
				}

				report(ctx, `Detecting tasks in ${input.sourcePath}...`, "info");
				const plan = await extractImplementationPlan(input.markdown, ctx);
				const choice = await ctx.ui.select(formatPreview(input.sourcePath, plan), ["Implement", "Cancel"]);
				if (choice !== "Implement") {
					report(ctx, "Implementation cancelled.", "info");
					return;
				}

				const result = await runImplementationPlan(plan, taskExecutor.execute, (statuses) =>
					updateProgressUi(ctx, plan, statuses),
				);

				if (result.completed) {
					report(ctx, "Implementation complete.", "info");
				} else {
					report(ctx, `Implementation stopped: ${result.error?.message ?? "task failed"}`, "error");
				}
			} catch (error) {
				report(ctx, error instanceof Error ? error.message : String(error), "error");
			} finally {
				ctx.ui.setWorkingMessage();
				workflowRunning = false;
			}
		},
	});
}
