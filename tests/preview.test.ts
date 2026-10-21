import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionCommandContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { confirmExecutionSummary, formatExecutionSummary, formatPreview, selectTaskAction, type ExecutionSummary } from "../src/preview.ts";

initTheme("dark");
const choices = ["Implement only", "Git checkpoints: new or current local branch", "Cancel"];

function openPreview(tasks: Array<{ title: string }>, menu = choices, defaultIndex = 1) {
	return openDialog((ctx) => selectTaskAction("Implement tasks", { tasks }, menu, defaultIndex, ctx));
}

function openDialog(select: (ctx: ExtensionCommandContext) => Promise<unknown>) {
	const terminal = { rows: 24 };
	let component!: Component;
	let customOptions: unknown;
	let renders = 0;
	let toolsExpanded = false;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom(factory: Parameters<ExtensionUIContext["custom"]>[0], options: unknown) {
				customOptions = options;
				return new Promise((done) => {
					const result = factory({ terminal, requestRender() { renders++; } } as never, {} as never, getKeybindings(), done);
					assert.ok(!(result instanceof Promise));
					component = result;
				});
			},
			getToolsExpanded: () => toolsExpanded,
			setToolsExpanded(value: boolean) { toolsExpanded = value; },
		},
	} as unknown as ExtensionCommandContext;
	const result = select(ctx);
	return {
		terminal,
		result,
		render: (width = 100) => component.render(width).map(stripVTControlCharacters),
		input: (data: string) => component.handleInput?.(data),
		invalidate: () => component.invalidate(),
		get options() { return customOptions; },
		get renders() { return renders; },
	};
}

const summary: ExecutionSummary = {
	command: "/implement-plan",
	cwd: "/project",
	sourcePlanPath: "plan.md",
	sourcePath: "tasks.md",
	taskCount: 12,
	implementationModel: { provider: "implementation", id: "model" },
	implementationThinkingLevel: "medium",
	checkpoint: true,
	branchName: "feature/implementation",
	createBranch: true,
	initiallyDirty: true,
	automaticCompaction: true,
	compactionThresholdPercent: 80,
	review: { enabled: false },
	preparedTasks: { overwrite: true },
	ignoreStateFile: true,
};

test("execution summary includes settings and pending writes with review disabled", () => {
	assert.equal(formatExecutionSummary(summary), [
		"Execution summary",
		"Command: /implement-plan",
		"Working directory: /project",
		"Source plan: plan.md",
		"Task file: tasks.md",
		"Tasks: 12",
		"Implementation model: implementation/model",
		"Implementation thinking: medium",
		"Git checkpoints: Enabled (local only)",
		"Branch: feature/implementation (create new)",
		"Initial dirty-state commit: Planned",
		"Automatic compaction: Enabled (threshold: 80%)",
		"Final review: Disabled",
		"tasks.md: Overwrite existing file (approved)",
		".gitignore: Add .pi-implement-state.json if missing",
	].join("\n"));
});

test("execution summary shows independent review settings and omitted options accurately", () => {
	const text = formatExecutionSummary({
		...summary,
		command: "/implement-tasks",
		sourcePlanPath: null,
		checkpoint: false,
		automaticCompaction: false,
		preparedTasks: undefined,
		ignoreStateFile: false,
		review: { enabled: true, model: { provider: "review", id: "other" }, thinkingLevel: "high" },
	});
	for (const expected of ["Command: /implement-tasks", "Source plan: None", "Git checkpoints: Disabled",
		"Initial dirty-state commit: Not planned", "Automatic compaction: Disabled", "Final review: Enabled",
		"Review model: review/other", "Review thinking: high", "Review scope: plan compliance, tests, and documentation",
		".gitignore: No update planned"]) assert.ok(text.includes(expected), expected);
	assert.ok(!text.includes("Branch:"));
	assert.ok(!text.includes("tasks.md: Overwrite"));
	assert.match(formatExecutionSummary({ ...summary, createBranch: false, preparedTasks: { overwrite: false } }),
		/Branch: feature\/implementation \(use current\)/);
	assert.match(formatExecutionSummary({ ...summary, preparedTasks: { overwrite: false } }), /Create generated task file/);
});

test("long execution summaries scroll while actions stay visible across resizing", async () => {
	const dialog = openDialog((ctx) => confirmExecutionSummary({
		...summary, cwd: "Long directory ＡＢＣ 😀 ".repeat(100),
	}, ctx));
	dialog.terminal.rows = 12;
	const first = dialog.render(40);
	assert.ok(first.some((line) => line.includes("Start implementation")));
	assert.ok(first.some((line) => line.startsWith("→ ") && line.includes("Cancel")));
	dialog.input("\u001b[6~");
	const next = dialog.render(40);
	assert.notDeepEqual(next.slice(0, -3), first.slice(0, -3));
	assert.deepEqual(next.slice(-3), first.slice(-3));
	dialog.input("\u001b[5~");
	assert.deepEqual(dialog.render(40), first);
	for (const [rows, width] of [[6, 30], [3, 10], [1, 1], [24, 80]]) {
		dialog.terminal.rows = rows;
		dialog.invalidate();
		const lines = dialog.render(width);
		assert.ok(lines.length <= Math.max(1, rows - 2));
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		if (width >= 30) {
			assert.ok(lines.some((line) => line.includes("Start implementation")));
			assert.ok(lines.some((line) => line.includes("Cancel")));
		}
	}
	dialog.input("\r");
	assert.equal(await dialog.result, false);
});

for (const resume of [false, true]) {
	for (const [name, keys, expected] of [
		["defaults to Cancel", ["\r"], false],
		["confirms with up and Enter", ["\u001b[A", "\r"], true],
		["confirms with up and newline", ["\u001b[A", "\n"], true],
		["returns to Cancel with down", ["\u001b[A", "\u001b[B", "\r"], false],
		["cancels with Escape", ["\u001b"], false],
		["cancels with Ctrl+C", ["\u0003"], false],
	] as const) {
		test(`${resume ? "resume" : "start"} summary ${name} without mutating input`, async () => {
			const before = structuredClone(summary);
			const dialog = openDialog((ctx) => confirmExecutionSummary(summary, ctx, resume));
			assert.ok(dialog.render().some((line) => line.includes(resume ? "Resume" : "Start implementation")));
			for (const key of keys) dialog.input(key);
			assert.equal(await dialog.result, expected);
			assert.deepEqual(summary, before);
		});
	}
	for (const response of ["Cancel", undefined, "unexpected", resume ? "Resume" : "Start implementation"]) {
		test(`non-TUI ${resume ? "resume" : "start"} summary handles ${response}`, async () => {
			const action = resume ? "Resume" : "Start implementation";
			let calls = 0;
			const ctx = {
				hasUI: true,
				mode: "rpc",
				ui: { async select(title: string, options: string[]) {
					calls++;
					assert.ok(title.startsWith(formatExecutionSummary(summary)));
					assert.match(title, /Choose an action explicitly/);
					assert.deepEqual(options, ["Cancel", action]);
					return response;
				} },
			} as unknown as ExtensionCommandContext;
			assert.equal(await confirmExecutionSummary(summary, ctx, resume), response === action);
			assert.equal(calls, 1);
		});
	}
}

test("execution summary fails closed without an interactive UI", async () => {
	assert.equal(await confirmExecutionSummary(summary, { hasUI: false } as ExtensionCommandContext), false);
});

const manyTasks = Array.from({ length: 100 }, (_, index) => ({ title: `Task ${index + 1}: ${"long title ".repeat(10)}` }));

test("long, wrapped previews reserve viewport space for all actions", async () => {
	const preview = openPreview(manyTasks);
	const lines = preview.render(80);
	assert.ok(lines.length <= 22);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	for (const choice of choices) assert.ok(lines.some((line) => line.includes(choice)));
	assert.ok(lines.some((line) => line.startsWith("→ ") && line.includes(choices[1])));
	assert.match(lines.at(-1)!, /100 tasks/);
	assert.deepEqual(preview.options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0 } });
	preview.input("\r");
	assert.equal(await preview.result, choices[1]);
});

test("PageUp and PageDown scroll the preview without moving the action selection", async () => {
	const preview = openPreview(manyTasks);
	const first = preview.render();
	preview.input("\u001b[6~");
	const next = preview.render();
	assert.notDeepEqual(next.slice(0, -4), first.slice(0, -4));
	assert.deepEqual(next.slice(-4), first.slice(-4));
	preview.input("\u001b[5~");
	assert.deepEqual(preview.render(), first);
	for (let i = 0; i < 200; i++) {
		preview.input("\u001b[6~");
		preview.render();
	}
	assert.ok(preview.render().some((line) => line.includes("100 tasks detected.")));
	preview.input("\n");
	assert.equal(await preview.result, choices[1]);
});

test("resizing and tiny viewports keep the selected action accessible without overflowing", async () => {
	const preview = openPreview(manyTasks);
	preview.render();
	preview.input("\u001b[6~");
	preview.input("\u001b[B");
	for (const [rows, width] of [[12, 60], [6, 20], [3, 10], [1, 1], [30, 120]]) {
		preview.terminal.rows = rows;
		preview.invalidate();
		const lines = preview.render(width);
		assert.ok(lines.length <= Math.max(1, rows - 2), `${width}x${rows}: too many rows`);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${rows}: line too wide`);
		if (width > 1) assert.ok(lines.some((line) => line.startsWith("→ ")));
	}
	preview.input("\r");
	assert.equal(await preview.result, choices[2]);
});

test("non-repository previews also keep actions visible for long Unicode task titles", async () => {
	const tasks = Array.from({ length: 60 }, () => ({ title: "Wide title ＡＢＣ and emoji 😀 ".repeat(10) }));
	const preview = openPreview(tasks, ["Implement", "Cancel"], 0);
	preview.terminal.rows = 12;
	const lines = preview.render(40);
	assert.ok(lines.length <= 10);
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
	assert.ok(lines.some((line) => line.includes("Implement")));
	assert.ok(lines.some((line) => line.includes("Cancel")));
	preview.input("\r");
	assert.equal(await preview.result, "Implement");
});

for (const [name, keys, expected] of [
	["up arrow clamps at the first option", ["\u001b[A", "\u001b[A", "\r"], choices[0]],
	["down arrow clamps at Cancel", ["\u001b[B", "\u001b[B", "\r"], choices[2]],
	["j and k preserve navigation", ["k", "j", "j", "\n"], choices[2]],
	["Escape cancels", ["\u001b"], undefined],
	["Ctrl+C cancels", ["\u0003"], undefined],
] as const) {
	test(`bounded preview: ${name}`, async () => {
		const preview = openPreview(manyTasks);
		preview.terminal.rows = 3;
		preview.render(30);
		for (const key of keys) preview.input(key);
		assert.equal(await preview.result, expected);
		assert.ok(preview.renders > 0);
	});
}

test("short previews retain all task titles and non-repository action defaults", async () => {
	const tasks = [{ title: "First" }, { title: "Second" }];
	const preview = openPreview(tasks, ["Implement", "Cancel"], 0);
	assert.deepEqual(preview.render().slice(0, 4).map((line) => line.trimEnd()), [
		"Implement tasks", "1. First", "2. Second", "2 tasks detected.",
	]);
	preview.input("\r");
	assert.equal(await preview.result, "Implement");
});

test("RPC retains the full preview and existing select dialog", async () => {
	let selection: unknown;
	const tasks = { tasks: manyTasks };
	const ctx = {
		mode: "rpc",
		ui: { async select(title: string, options: string[]) { selection = { title, options }; return "Cancel"; } },
	} as unknown as ExtensionCommandContext;
	assert.equal(await selectTaskAction("Implement tasks", tasks, choices, 1, ctx), "Cancel");
	assert.deepEqual(selection, { title: formatPreview("Implement tasks", tasks), options: choices });
});
