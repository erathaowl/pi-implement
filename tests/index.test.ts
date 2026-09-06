import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import implementExtension, { readMarkdownInput } from "../src/index.ts";
import { TASK_INDEX_PROMPT } from "../src/tasks.ts";

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
	choices?: string[];
	modelOutputs?: unknown[];
	turnStopReasons?: string[];
}) {
	const commands = new Map<string, Handler>();
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const completeCalls: unknown[][] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const selections: Array<{ title: string; choices: string[] }> = [];
	const widgets: Array<string[] | undefined> = [];
	const workingMessages: Array<string | undefined> = [];
	const stopReasons = [...(options.turnStopReasons ?? [])];
	const modelOutputs = [...(options.modelOutputs ?? [])];
	const choices = [...(options.choices ?? [])];
	const sessionHistory = [{ role: "user", content: "existing context" }];

	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) {
			await handler(event, ctx);
		}
	};

	const pi = {
		registerCommand(name: string, command: { handler: Handler }) {
			commands.set(name, command.handler);
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
		model: { provider: "test", id: "selected" },
		isIdle: () => true,
		modelRegistry: {
			async complete(...args: unknown[]) {
				completeCalls.push(args);
				const output = modelOutputs.shift() ?? { tasks: [{ title: "One" }] };
				return {
					stopReason: "stop",
					content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
				};
			},
		},
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			async select(title: string, selectChoices: string[]) {
				selections.push({ title, choices: selectChoices });
				return choices.shift();
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
	return {
		commands,
		completeCalls,
		ctx,
		notifications,
		selections,
		sent,
		sessionHistory,
		widgets,
		workingMessages,
		async run(command: string, argument: string) {
			const handler = commands.get(command);
			assert.ok(handler, `/${command} should be registered`);
			await handler(argument, ctx);
		},
	};
}

test("registers the three split commands and removes the old /implement command", () => {
	const runtime = fakeRuntime({ cwd: process.cwd() });
	assert.deepEqual([...runtime.commands.keys()].sort(), ["implement-plan", "implement-rewrite", "implement-tasks"]);
	assert.equal(runtime.commands.has("implement"), false);
});

test("file handling reports command-specific usage for a missing argument", async () => {
	await assert.rejects(
		readMarkdownInput("   ", process.cwd(), "/implement-rewrite"),
		/Usage: \/implement-rewrite/,
	);
});

test("file handling rejects nonexistent, directory, and empty paths", async () => {
	await withTempDir(async (directory) => {
		await assert.rejects(readMarkdownInput("missing.md", directory, "/implement-tasks"), /File not found/);
		await mkdir(join(directory, "directory"));
		await assert.rejects(readMarkdownInput("directory", directory, "/implement-tasks"), /not a file/);
		await writeFile(join(directory, "empty.md"), " \n");
		await assert.rejects(readMarkdownInput("empty.md", directory, "/implement-tasks"), /is empty/);
	});
});

test("/implement-rewrite preserves self-contained rewrite execution", async () => {
	await withTempDir(async (directory) => {
		const source = "## API\nAdd an endpoint.";
		await writeFile(join(directory, "notes.md"), source);
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement"],
			modelOutputs: [
				{
					tasks: [
						{ title: "Add API", instructions: "Add the endpoint and apply the shared validation rules." },
						{ title: "Test API", instructions: "Test the endpoint and all acceptance criteria." },
					],
				},
			],
		});

		await runtime.run("implement-rewrite", "notes.md");

		assert.equal(runtime.completeCalls.length, 1);
		assert.equal(runtime.sent.length, 2);
		assert.match(runtime.sent[0], /Instructions:\nAdd the endpoint and apply the shared validation rules\./);
		assert.match(runtime.sent[1], /Instructions:\nTest the endpoint and all acceptance criteria\./);
		assert.match(runtime.selections[0].title, /Rewrite and implement notes\.md/);
		assert.deepEqual(runtime.sessionHistory, [{ role: "user", content: "existing context" }]);
		assert.equal(await readFile(join(directory, "notes.md"), "utf8"), source);
		assert.ok(runtime.notifications.some(({ message }) => message === "Implementation complete."));
	});
});

test("/implement-tasks indexes titles but makes each turn read the authoritative source file", async () => {
	await withTempDir(async (directory) => {
		const source = `# Tasks\n\n## Task 1 - Add API\nImplement it.\n\nExample:\n\`\`\`markdown\n## Task 1 - Not real\n\`\`\``;
		await writeFile(join(directory, "tasks.md"), source);
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement"],
			modelOutputs: [
				{
					tasks: [
						{ title: "Add API", instructions: "rewritten text must be discarded" },
						{ title: "Add tests", instructions: "rewritten text must be discarded" },
					],
				},
			],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.equal(runtime.completeCalls.length, 1);
		assert.equal(runtime.sent.length, 2);
		assert.match(runtime.sent[0], /^Read "tasks\.md" and implement task #1 \("Add API"\)\./);
		assert.match(runtime.sent[1], /^Read "tasks\.md" and implement task #2 \("Add tests"\)\./);
		assert.ok(runtime.sent.every((prompt) => prompt.includes("task file itself as the authoritative source")));
		assert.ok(runtime.sent.every((prompt) => !prompt.includes("rewritten text")));
		assert.deepEqual(runtime.sessionHistory, [{ role: "user", content: "existing context" }]);
		assert.ok(runtime.widgets.some((lines) => lines?.some((line) => line.includes("●"))));
		assert.ok(runtime.widgets.some((lines) => lines?.slice(1).every((line) => line.includes("✓"))));
	});
});

test("/implement-tasks preview cancellation sends no active-session prompt", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "## Task 1 - One\nDo one.");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Cancel"],
			modelOutputs: [{ tasks: [{ title: "One" }] }],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.deepEqual(runtime.sent, []);
		assert.deepEqual(runtime.selections[0].choices, ["Implement", "Cancel"]);
		assert.ok(runtime.notifications.some(({ message }) => message.includes("cancelled")));
	});
});

test("/implement-tasks stops after failure and does not start a subsequent task", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement"],
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }, { title: "Three" }] }],
			turnStopReasons: ["stop", "error", "stop"],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.equal(runtime.sent.length, 2);
		assert.ok(runtime.widgets.some((lines) => lines?.some((line) => line.includes("✗") && line.includes("Two"))));
		assert.ok(runtime.notifications.some(({ message }) => message.includes("Implementation stopped")));
	});
});

test("/implement-plan overwrites with confirmation then delegates to the task-file workflow", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "plan.md"), "Build API, then test it.");
		await writeFile(join(directory, "tasks.md"), "old tasks\n");
		const generated = "# Tasks\n\n## Task 1 - Build API\n\nBuild it.\n\n## Task 2 - Test API\n\nTest it.\n";
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Overwrite", "Implement"],
			modelOutputs: [generated, { tasks: [{ title: "Build API" }, { title: "Test API" }] }],
		});

		await runtime.run("implement-plan", "plan.md");

		assert.equal(await readFile(join(directory, "tasks.md"), "utf8"), generated);
		assert.equal(runtime.completeCalls.length, 2);
		const secondContext = runtime.completeCalls[1][1] as { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> };
		assert.equal(secondContext.systemPrompt, TASK_INDEX_PROMPT);
		assert.equal(secondContext.messages[0].content[0].text, generated);
		assert.match(runtime.selections[0].title, /tasks\.md already exists/);
		assert.match(runtime.selections[1].title, /Implement tasks from tasks\.md/);
		assert.equal(runtime.sent.length, 2);
		assert.match(runtime.sent[0], /^Read "tasks\.md" and implement task #1/);
		assert.match(runtime.sent[1], /^Read "tasks\.md" and implement task #2/);
		assert.ok(runtime.sent.every((prompt) => !prompt.includes("Build it.")));
	});
});

test("/implement-plan cancellation does not overwrite an existing tasks.md", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "plan.md"), "new plan");
		await writeFile(join(directory, "tasks.md"), "keep this\n");
		const runtime = fakeRuntime({ cwd: directory, choices: ["Cancel"] });

		await runtime.run("implement-plan", "plan.md");

		assert.equal(await readFile(join(directory, "tasks.md"), "utf8"), "keep this\n");
		assert.equal(runtime.completeCalls.length, 0);
		assert.deepEqual(runtime.sent, []);
	});
});
