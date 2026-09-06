import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeIsolatedText } from "./model.ts";

export const GENERATED_TASKS_FILE = "tasks.md";

export const PLAN_CONVERSION_PROMPT = `Convert the plan into a clear, readable Markdown implementation task document.
Preserve the intended execution order and all relevant requirements, constraints, acceptance criteria, validation expectations, and technical details.
Organize the actual tasks as explicit ordered sections using headings such as "## Task 1 - Title".
Keep shared requirements in a clear document-level section or repeat them where needed so agents reading the task document can apply them correctly.
Do not invent requirements or implementation work.
Any task-file formats shown in the plan are illustrative examples, not additional tasks, unless the plan explicitly identifies them as work to perform.
Return only the generated Markdown document without a surrounding code fence or commentary.`;

type PlanContext = Pick<ExtensionCommandContext, "model" | "modelRegistry">;

function stripMarkdownFence(markdown: string): string {
	const fenced = /^```(?:markdown|md)?\s*\n?([\s\S]*?)\n?```$/i.exec(markdown.trim());
	return (fenced ? fenced[1] : markdown).trim();
}

export async function convertPlanToTaskDocument(plan: string, ctx: PlanContext): Promise<string> {
	const markdown = stripMarkdownFence(
		await completeIsolatedText(PLAN_CONVERSION_PROMPT, plan, ctx, "Plan conversion"),
	);
	if (!markdown) {
		throw new Error("Plan conversion returned an empty task document.");
	}
	return `${markdown}\n`;
}

export function generatedTasksPath(cwd: string): string {
	return resolve(cwd, GENERATED_TASKS_FILE);
}

export async function generatedTasksFileExists(cwd: string): Promise<boolean> {
	try {
		await stat(generatedTasksPath(cwd));
		return true;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			String((error as { code?: unknown }).code) === "ENOENT"
		) {
			return false;
		}
		throw new Error(`Unable to access ${GENERATED_TASKS_FILE}.`);
	}
}

export async function writeGeneratedTaskDocument(cwd: string, markdown: string): Promise<string> {
	const outputPath = generatedTasksPath(cwd);
	try {
		await writeFile(outputPath, markdown, "utf8");
	} catch {
		throw new Error(`Unable to write ${GENERATED_TASKS_FILE}.`);
	}
	return outputPath;
}
