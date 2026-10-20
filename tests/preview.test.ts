import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionCommandContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { formatPreview, selectTaskAction } from "../src/preview.ts";

initTheme("dark");
const choices = ["Implement only", "Git checkpoints: new or current local branch", "Cancel"];

function openPreview(tasks: Array<{ title: string }>, menu = choices, defaultIndex = 1) {
	const terminal = { rows: 24 };
	let component!: Component;
	let customOptions: unknown;
	let renders = 0;
	let toolsExpanded = false;
	const ctx = {
		mode: "tui",
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
	const result = selectTaskAction("Implement tasks", { tasks }, menu, defaultIndex, ctx);
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
