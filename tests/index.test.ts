import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import implementExtension, { readMarkdownInput } from "../src/index.ts";

type Handler = (event: any, ctx?: any) => void | Promise<void>;

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(process.cwd(), ".implement-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function fakeRuntime(options: {
	cwd: string;
	choice?: string;
	plan?: unknown;
	turnStopReasons?: string[];
	model?: unknown;
}) {
	let commandHandler: Handler | undefined;
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const completeCalls: unknown[][] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const selections: Array<{ title: string; choices: string[] }> = [];
	const widgets: Array<string[] | undefined> = [];
	const workingMessages: Array<string | undefined> = [];
	const stopReasons = [...(options.turnStopReasons ?? [])];
	const sessionHistory = [{ role: "user", content: "existing context" }];

	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) {
			await handler(event, ctx);
		}
	};

	const pi = {
		registerCommand(name: string, command: { handler: Handler }) {
			if (name === "implement") commandHandler = command.handler;
		},
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		sendUserMessage(message: string) {
			sent.push(message);
			const stopReason = stopReasons.shift() ?? "stop";
			queueMicrotask(async () => {
				await emit("agent_start", { type: "agent_start" });
				await emit("agent_end", {
					type: "agent_end",
					messages: [
						{
							role: "assistant",
							stopReason,
							errorMessage: stopReason === "error" ? "provider failed" : undefined,
						},
					],
				});
				await emit("agent_settled", { type: "agent_settled" });
			});
		},
	};

	const ctx = {
		cwd: options.cwd,
		hasUI: true,
		mode: "tui",
		model: options.model === undefined ? { provider: "test", id: "selected" } : options.model,
		isIdle: () => true,
		modelRegistry: {
			async complete(...args: unknown[]) {
				completeCalls.push(args);
				return {
					stopReason: "stop",
					content: [
						{
							type: "text",
							text: JSON.stringify(
								options.plan ?? {
									tasks: [
										{ title: "One", instructions: "Implement one." },
										{ title: "Two", instructions: "Implement two." },
										{ title: "Three", instructions: "Implement three." },
									],
								},
							),
						},
					],
				};
			},
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			async select(title: string, choices: string[]) {
				selections.push({ title, choices });
				return options.choice;
			},
			setWidget(_key: string, value: string[] | undefined) {
				widgets.push(value);
			},
			setWorkingMessage(message?: string) {
				workingMessages.push(message);
			},
		},
		sessionManager: {
			getEntries: () => sessionHistory,
		},
	};

	implementExtension(pi as never);
	assert.ok(commandHandler, "the /implement command should be registered");
	return {
		completeCalls,
		ctx,
		handler: commandHandler!,
		notifications,
		selections,
		sent,
		sessionHistory,
		widgets,
		workingMessages,
	};
}

test("file handling rejects a missing argument", async () => {
	await assert.rejects(readMarkdownInput("   ", process.cwd()), /Usage: \/implement/);
});

test("file handling rejects a nonexistent path", async () => {
	await withTempDir(async (directory) => {
		await assert.rejects(readMarkdownInput("missing.md", directory), /File not found/);
	});
});

test("file handling rejects directories", async () => {
	await withTempDir(async (directory) => {
		await mkdir(join(directory, "tasks"));
		await assert.rejects(readMarkdownInput("tasks", directory), /not a file/);
	});
});

test("file handling rejects an empty Markdown file", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "empty.md"), " \n");
		await assert.rejects(readMarkdownInput("empty.md", directory), /is empty/);
	});
});

test("file handling reads a valid Markdown file without modifying it", async () => {
	await withTempDir(async (directory) => {
		const markdown = "- Add endpoint\n- Add tests\n";
		await writeFile(join(directory, "tasks.md"), markdown);
		const input = await readMarkdownInput("tasks.md", directory);
		assert.equal(input.sourcePath, "tasks.md");
		assert.equal(input.markdown, markdown);
		assert.equal(await import("node:fs/promises").then((fs) => fs.readFile(input.resolvedPath, "utf8")), markdown);
	});
});

test("choosing Cancel from preview executes no active-session turns", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "- Add endpoint");
		const runtime = fakeRuntime({ cwd: directory, choice: "Cancel" });

		await runtime.handler("tasks.md", runtime.ctx);

		assert.equal(runtime.completeCalls.length, 1);
		assert.deepEqual(runtime.sent, []);
		assert.match(runtime.selections[0].title, /3 tasks detected/);
		assert.deepEqual(runtime.selections[0].choices, ["Implement", "Cancel"]);
		assert.ok(runtime.notifications.some(({ message }) => message.includes("cancelled")));
	});
});

test("command keeps extraction isolated and implements tasks through active-session turns", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "## One\nDo one.\n## Two\nDo two.");
		const runtime = fakeRuntime({ cwd: directory, choice: "Implement" });

		await runtime.handler("tasks.md", runtime.ctx);

		assert.equal(runtime.completeCalls.length, 1);
		assert.equal(runtime.sent.length, 3);
		assert.match(runtime.sent[0], /Title:\nOne/);
		assert.match(runtime.sent[1], /Title:\nTwo/);
		assert.match(runtime.sent[2], /Title:\nThree/);
		assert.deepEqual(runtime.sessionHistory, [{ role: "user", content: "existing context" }]);
		assert.ok(runtime.notifications.some(({ message }) => message === "Implementation complete."));
		assert.ok(runtime.widgets.some((lines) => lines?.some((line) => line.includes("●"))));
		assert.ok(runtime.widgets.some((lines) => lines?.slice(1).every((line) => line.includes("✓"))));
	});
});

test("command stops after an active-session task failure and renders failed state", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "- One\n- Two\n- Three");
		const runtime = fakeRuntime({
			cwd: directory,
			choice: "Implement",
			turnStopReasons: ["stop", "error", "stop"],
		});

		await runtime.handler("tasks.md", runtime.ctx);

		assert.equal(runtime.sent.length, 2);
		assert.ok(runtime.widgets.some((lines) => lines?.some((line) => line.includes("✗") && line.includes("Two"))));
		assert.ok(runtime.notifications.some(({ message }) => message.includes("Implementation stopped")));
	});
});

test("malformed extraction output fails cleanly without active-session execution", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "- One");
		const runtime = fakeRuntime({ cwd: directory, choice: "Implement", plan: { wrong: [] } });

		await runtime.handler("tasks.md", runtime.ctx);

		assert.equal(runtime.sent.length, 0);
		assert.ok(runtime.notifications.some(({ message, type }) => type === "error" && message.includes("tasks list")));
	});
});
