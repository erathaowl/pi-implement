import { getSelectListTheme, keyHint, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ImplementationSettings } from "./model.ts";

type TaskList = { tasks: readonly { title: string }[] };

export type ExecutionSummary = ImplementationSettings & {
	command: "/implement-tasks" | "/implement-plan";
	cwd: string;
	sourcePlanPath: string | null;
	sourcePath: string;
	taskCount: number;
	checkpoint: boolean;
	branchName?: string;
	createBranch: boolean;
	initiallyDirty: boolean;
	automaticCompaction: boolean;
	compactionThresholdPercent: number;
	review: { enabled: false } | {
		enabled: true;
		model: ImplementationSettings["implementationModel"];
		thinkingLevel: ImplementationSettings["implementationThinkingLevel"];
	};
	preparedTasks?: { overwrite: boolean };
	ignoreStateFile: boolean;
};

export function formatExecutionSummary(summary: ExecutionSummary): string {
	const lines = [
		"Execution summary",
		`Command: ${summary.command}`,
		`Working directory: ${summary.cwd}`,
		`Source plan: ${summary.sourcePlanPath ?? "None"}`,
		`Task file: ${summary.sourcePath}`,
		`Tasks: ${summary.taskCount}`,
		`Implementation model: ${summary.implementationModel.provider}/${summary.implementationModel.id}`,
		`Implementation thinking: ${summary.implementationThinkingLevel}`,
		`Git checkpoints: ${summary.checkpoint ? "Enabled (local only)" : "Disabled"}`,
	];
	if (summary.checkpoint) {
		lines.push(`Branch: ${summary.branchName} (${summary.createBranch ? "create new" : "use current"})`);
	}
	lines.push(
		`Initial dirty-state commit: ${summary.checkpoint && summary.initiallyDirty ? "Planned" : "Not planned"}`,
		`Automatic compaction: ${summary.automaticCompaction ? `Enabled (threshold: ${summary.compactionThresholdPercent}%)` : "Disabled"}`,
		`Final review: ${summary.review.enabled ? "Enabled" : "Disabled"}`,
	);
	if (summary.review.enabled) {
		lines.push(
			`Review model: ${summary.review.model.provider}/${summary.review.model.id}`,
			`Review thinking: ${summary.review.thinkingLevel}`,
			"Review scope: plan compliance, tests, and documentation",
		);
		if (summary.sourcePlanPath === null) {
			lines.push("Review limitation: No source plan supplied; original-plan compliance cannot be independently verified.");
		}
	}
	if (summary.preparedTasks) {
		lines.push(`tasks.md: ${summary.preparedTasks.overwrite ? "Overwrite existing file (approved)" : "Create generated task file"}`);
	}
	lines.push(`.gitignore: ${summary.ignoreStateFile ? "Add .pi-implement-state.json if missing" : "No update planned"}`);
	return lines.join("\n");
}

export async function confirmExecutionSummary(
	summary: ExecutionSummary,
	ctx: ExtensionCommandContext,
	resume = false,
): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const action = resume ? "Resume" : "Start implementation";
	const preview = formatExecutionSummary(summary);
	let selected: string | undefined;
	if (ctx.mode === "tui") {
		selected = await selectPreviewAction(preview, "Default: Cancel", [action, "Cancel"], 1, ctx);
	} else {
		// The standard dialog has no selected-index option. Put Cancel first and require an exact affirmative response.
		selected = await ctx.ui.select(`${preview}\nChoose an action explicitly (Cancel is listed first).`, ["Cancel", action]);
	}
	return selected === action;
}

export function formatPreview(title: string, tasks: TaskList): string {
	const taskLines = tasks.tasks.map((task, index) => `${index + 1}. ${task.title}`);
	return [title, ...taskLines, `${tasks.tasks.length} ${tasks.tasks.length === 1 ? "task" : "tasks"} detected.`].join("\n");
}

export async function selectTaskAction(
	title: string,
	tasks: TaskList,
	choices: string[],
	defaultIndex: number,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	return selectPreviewAction(formatPreview(title, tasks),
		`${tasks.tasks.length} ${tasks.tasks.length === 1 ? "task" : "tasks"}`,
		choices, defaultIndex, ctx);
}

async function selectPreviewAction(
	preview: string,
	footer: string,
	choices: string[],
	defaultIndex: number,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") return ctx.ui.select(preview, choices);

	return ctx.ui.custom<string | undefined>((tui, _theme, kb, done) => {
		const text = new Text(preview, 0, 0);
		const actions = new SelectList(choices.map((value) => ({ value, label: value })), choices.length, getSelectListTheme());
		let selectedIndex = defaultIndex;
		let offset = 0;
		let pageSize = 1;
		let maxOffset = 0;
		actions.setSelectedIndex(selectedIndex);
		actions.onSelect = (item) => done(item.value);
		actions.onCancel = () => done(undefined);

		return {
			render(width: number) {
				// Budget visual rows, not task count: titles can wrap, and the terminal can resize at any time.
				const height = Math.max(1, tui.terminal.rows - 2);
				const menu = actions.render(Math.max(4, width)).map((line) => truncateToWidth(line, width, ""));
				if (height <= menu.length) {
					const start = Math.max(0, Math.min(selectedIndex, menu.length - height));
					return menu.slice(start, start + height);
				}
				pageSize = Math.max(0, height - menu.length - 1);
				const lines = text.render(width);
				maxOffset = Math.max(0, lines.length - pageSize);
				offset = Math.min(offset, maxOffset);
				const scrollHint = maxOffset > 0
					? `${keyHint("tui.select.pageUp", "")}/${keyHint("tui.select.pageDown", "preview")}  `
					: "";
				const hint = `${footer}  ${scrollHint}↑↓ navigate  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`;
				return [...lines.slice(offset, offset + pageSize), ...menu, truncateToWidth(hint, width)];
			},
			invalidate() {
				text.invalidate();
				actions.invalidate();
			},
			handleInput(data: string) {
				if (kb.matches(data, "app.tools.expand")) {
					ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded());
				} else if (kb.matches(data, "tui.select.pageUp")) {
					offset = Math.max(0, offset - Math.max(1, pageSize));
				} else if (kb.matches(data, "tui.select.pageDown")) {
					offset = Math.min(maxOffset, offset + Math.max(1, pageSize));
				} else if (kb.matches(data, "tui.select.up") || data === "k") {
					selectedIndex = Math.max(0, selectedIndex - 1);
					actions.setSelectedIndex(selectedIndex);
				} else if (kb.matches(data, "tui.select.down") || data === "j") {
					selectedIndex = Math.min(choices.length - 1, selectedIndex + 1);
					actions.setSelectedIndex(selectedIndex);
				} else if (data === "\n") {
					done(choices[selectedIndex]);
				} else {
					actions.handleInput(data);
				}
				tui.requestRender();
			},
		};
	}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
}
