import { getSelectListTheme, keyHint, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";

type TaskList = { tasks: readonly { title: string }[] };

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
	const preview = formatPreview(title, tasks);
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
				const count = `${tasks.tasks.length} ${tasks.tasks.length === 1 ? "task" : "tasks"}`;
				const hint = `${count}  ${scrollHint}↑↓ navigate  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`;
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
