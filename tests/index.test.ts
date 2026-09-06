import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { COMPACTION_ENABLED_CHOICE } from "../src/compaction.ts";
import implementExtension, { readMarkdownInput } from "../src/index.ts";
import { TASK_INDEX_PROMPT } from "../src/tasks.ts";

type Handler = (event: any, ctx?: any) => void | Promise<void>;

type CompactCallbacks = {
	onComplete?: (result: unknown) => void;
	onError?: (error: Error) => void;
};

type GitResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

const gitResult = (stdout = "", code = 0, stderr = ""): GitResult => ({ stdout, stderr, code, killed: false });

function assertNoRemoteGit(calls: Array<{ command: string; args: string[] }>): void {
	const forbidden = ["fetch", "pull", "push", "clone", "ls-remote", "remote"];
	for (const call of calls) {
		assert.equal(call.command, "git");
		assert.equal(call.args.some((argument) => forbidden.includes(argument)), false);
	}
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 200; attempts++) {
		if (condition()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	assert.fail("Timed out waiting for asynchronous workflow state.");
}

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
	gitResults?: GitResult[];
	gitUnavailable?: boolean;
	inputs?: string[];
	contextUsages?: Array<{ tokens: number | null; contextWindow: number; percent: number | null } | undefined>;
	compactionOutcomes?: Array<"complete" | "error" | "manual">;
}) {
	const commands = new Map<string, Handler>();
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const completeCalls: unknown[][] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const selections: Array<{ title: string; choices: string[] }> = [];
	const widgets: Array<string[] | undefined> = [];
	const workingMessages: Array<string | undefined> = [];
	const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const inputPrompts: Array<{ title: string; placeholder?: string }> = [];
	const compactCalls: CompactCallbacks[] = [];
	let contextUsageCalls = 0;
	const stopReasons = [...(options.turnStopReasons ?? [])];
	const modelOutputs = [...(options.modelOutputs ?? [])];
	const choices = [...(options.choices ?? [])];
	const gitResults = options.gitResults ? [...options.gitResults] : [gitResult("", 1, "not a repository")];
	const inputs = [...(options.inputs ?? [])];
	const contextUsages = [...(options.contextUsages ?? [])];
	const compactionOutcomes = [...(options.compactionOutcomes ?? [])];
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
		async exec(command: string, args: string[], execOptions?: { cwd?: string }) {
			execCalls.push({ command, args, cwd: execOptions?.cwd });
			if (options.gitUnavailable) {
				throw new Error("git not found");
			}
			return gitResults.shift() ?? gitResult();
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
				const choice = choices.shift();
				return choice ?? (title === "Automatic compaction between tasks?" ? "No" : undefined);
			},
			async input(title: string, placeholder?: string) {
				inputPrompts.push({ title, placeholder });
				return inputs.shift();
			},
			setWidget(_key: string, value: string[] | undefined) {
				widgets.push(value);
			},
			setWorkingMessage(message?: string) {
				workingMessages.push(message);
			},
		},
		getContextUsage() {
			contextUsageCalls++;
			return contextUsages.shift();
		},
		compact(callbacks: CompactCallbacks = {}) {
			compactCalls.push(callbacks);
			const outcome = compactionOutcomes.shift() ?? "complete";
			if (outcome === "complete") queueMicrotask(() => callbacks.onComplete?.({}));
			if (outcome === "error") queueMicrotask(() => callbacks.onError?.(new Error("compaction failed")));
		},
		sessionManager: {
			getEntries: () => sessionHistory,
		},
	};

	implementExtension(pi as never);
	return {
		commands,
		compactCalls,
		completeCalls,
		get contextUsageCalls() {
			return contextUsageCalls;
		},
		ctx,
		execCalls,
		inputPrompts,
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
		assert.deepEqual(runtime.selections[0].choices, ["Implement", "Cancel"]);
		assert.deepEqual(runtime.selections[1].choices, ["No", COMPACTION_ENABLED_CHOICE]);
		assert.equal(runtime.contextUsageCalls, 0);
		assert.equal(runtime.compactCalls.length, 0);
		assert.deepEqual(runtime.execCalls[0].args, ["rev-parse", "--is-inside-work-tree"]);
		assert.ok(runtime.sent.every((prompt) => prompt.includes("Do not perform remote Git operations")));
		assert.ok(runtime.sent.every((prompt) => prompt.includes("Do not create commits")));
		assert.deepEqual(runtime.sessionHistory, [{ role: "user", content: "existing context" }]);
		assert.equal(await readFile(join(directory, "notes.md"), "utf8"), source);
		assert.ok(runtime.notifications.some(({ message }) => message === "Implementation complete."));
	});
});

test("rewrite checkpoint mode creates a local branch and commits only tasks with changes", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "notes.md"), "rewrite tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["New local branch + commit after each task", "No"],
			inputs: ["feature/rewrite-checkpoints"],
			modelOutputs: [
				{
					tasks: [
						{ title: "One", instructions: "Implement one." },
						{ title: "Two", instructions: "Implement two." },
					],
				},
			],
			gitResults: [
				gitResult("true\n"),
				gitResult(),
				gitResult(),
				gitResult(" M one.ts\n"),
				gitResult(),
				gitResult(),
				gitResult(),
			],
		});

		await runtime.run("implement-rewrite", "notes.md");

		assert.deepEqual(runtime.selections[0].choices, [
			"Implement only",
			"New local branch + commit after each task",
			"Cancel",
		]);
		assert.deepEqual(runtime.execCalls.map(({ args }) => args), [
			["rev-parse", "--is-inside-work-tree"],
			["status", "--porcelain"],
			["switch", "-c", "feature/rewrite-checkpoints"],
			["status", "--porcelain"],
			["add", "-A"],
			["commit", "-m", "Task 1: One"],
			["status", "--porcelain"],
		]);
		assert.equal(runtime.sent.length, 2);
		assert.equal(runtime.execCalls.filter(({ args }) => args[0] === "commit").length, 1);
		assertNoRemoteGit(runtime.execCalls);
	});
});

test("rewrite checkpoint mode requires a clean working tree", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "notes.md"), "rewrite task");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["New local branch + commit after each task"],
			modelOutputs: [{ tasks: [{ title: "One", instructions: "Implement one." }] }],
			gitResults: [gitResult("true\n"), gitResult(" M existing.ts\n")],
		});

		await runtime.run("implement-rewrite", "notes.md");

		assert.equal(runtime.inputPrompts.length, 0);
		assert.deepEqual(runtime.sent, []);
		assert.ok(runtime.notifications.some(({ message }) => message.includes("clean working tree")));
	});
});

test("Git checkpoint failure stops rewrite execution before the next task", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "notes.md"), "rewrite tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["New local branch + commit after each task", "No"],
			inputs: ["feature/rewrite-failure"],
			modelOutputs: [
				{
					tasks: [
						{ title: "One", instructions: "Implement one." },
						{ title: "Two", instructions: "Implement two." },
					],
				},
			],
			gitResults: [
				gitResult("true\n"),
				gitResult(),
				gitResult(),
				gitResult(" M one.ts\n"),
				gitResult(),
				gitResult("", 1, "commit failed"),
			],
		});

		await runtime.run("implement-rewrite", "notes.md");

		assert.equal(runtime.sent.length, 1);
		assert.ok(runtime.notifications.some(({ message }) => message.includes("Git commit failed")));
		assertNoRemoteGit(runtime.execCalls);
	});
});

test("rewrite compaction completes before the next task starts", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "notes.md"), "rewrite tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", COMPACTION_ENABLED_CHOICE],
			modelOutputs: [
				{
					tasks: [
						{ title: "One", instructions: "Implement one." },
						{ title: "Two", instructions: "Implement two." },
					],
				},
			],
			contextUsages: [{ tokens: 74, contextWindow: 100, percent: 74 }],
			compactionOutcomes: ["manual"],
		});

		const execution = runtime.run("implement-rewrite", "notes.md");
		await waitFor(() => runtime.compactCalls.length === 1);

		assert.deepEqual(runtime.selections[1].choices, ["No", COMPACTION_ENABLED_CHOICE]);
		assert.equal(runtime.sent.length, 1);
		assert.ok(runtime.widgets.at(-1)?.some((line) => line.includes("✓") && line.includes("One")));
		assert.ok(runtime.widgets.at(-1)?.some((line) => line.includes("○") && line.includes("Two")));
		runtime.compactCalls[0].onComplete?.({});
		await execution;
		assert.equal(runtime.sent.length, 2);
	});
});

test("rewrite compaction failure stops execution and never compacts after the final task", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "notes.md"), "rewrite tasks");
		const failed = fakeRuntime({
			cwd: directory,
			choices: ["Implement", COMPACTION_ENABLED_CHOICE],
			modelOutputs: [
				{
					tasks: [
						{ title: "One", instructions: "Implement one." },
						{ title: "Two", instructions: "Implement two." },
					],
				},
			],
			contextUsages: [{ tokens: 80, contextWindow: 100, percent: 80 }],
			compactionOutcomes: ["error"],
		});
		await failed.run("implement-rewrite", "notes.md");
		assert.equal(failed.sent.length, 1);
		assert.ok(failed.notifications.some(({ message }) => message.includes("compaction failed")));

		const finalTask = fakeRuntime({
			cwd: directory,
			choices: ["Implement", COMPACTION_ENABLED_CHOICE],
			modelOutputs: [{ tasks: [{ title: "Only", instructions: "Implement it." }] }],
			contextUsages: [{ tokens: 90, contextWindow: 100, percent: 90 }],
		});
		await finalTask.run("implement-rewrite", "notes.md");
		assert.equal(finalTask.contextUsageCalls, 0);
		assert.equal(finalTask.compactCalls.length, 0);
	});
});

test("/implement-tasks indexes titles but makes each turn read the authoritative source file", async () => {
	await withTempDir(async (directory) => {
		const source = `# Tasks\n\n## Task 1 - Add API\nImplement it.\n\nExample:\n\`\`\`markdown\n## Task 1 - Not real\n\`\`\``;
		await writeFile(join(directory, "tasks.md"), source);
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", "No"],
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
		assert.deepEqual(runtime.execCalls[0].args, ["rev-parse", "--is-inside-work-tree"]);
		assert.deepEqual(runtime.selections[0].choices, ["Implement", "Cancel"]);
		assert.deepEqual(runtime.selections[1].choices, ["No", COMPACTION_ENABLED_CHOICE]);
		assert.equal(runtime.contextUsageCalls, 0);
		assert.equal(runtime.compactCalls.length, 0);
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

test("task workflow continues normally when Git is unavailable", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "## Task 1 - One\nDo one.");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement"],
			modelOutputs: [{ tasks: [{ title: "One" }] }],
			gitUnavailable: true,
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.deepEqual(runtime.selections[0].choices, ["Implement", "Cancel"]);
		assert.equal(runtime.sent.length, 1);
	});
});

test("repository task workflow offers implement-only mode without creating checkpoints", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "## Task 1 - One\nDo one.");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement only"],
			modelOutputs: [{ tasks: [{ title: "One" }] }],
			gitResults: [gitResult("true\n")],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.deepEqual(runtime.selections[0].choices, [
			"Implement only",
			"New local branch + commit after each task",
			"Cancel",
		]);
		assert.equal(runtime.execCalls.length, 1);
		assert.equal(runtime.sent.length, 1);
		assert.match(runtime.sent[0], /Do not perform remote Git operations/);
		assert.match(runtime.sent[0], /Do not create commits/);
	});
});

test("checkpoint mode rejects a dirty working tree before asking for a branch", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "## Task 1 - One\nDo one.");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["New local branch + commit after each task"],
			modelOutputs: [{ tasks: [{ title: "One" }] }],
			gitResults: [gitResult("true\n"), gitResult(" M existing.ts\n")],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.deepEqual(runtime.execCalls.map(({ args }) => args), [
			["rev-parse", "--is-inside-work-tree"],
			["status", "--porcelain"],
		]);
		assert.equal(runtime.inputPrompts.length, 0);
		assert.deepEqual(runtime.sent, []);
		assert.ok(runtime.notifications.some(({ message, type }) => type === "error" && message.includes("clean working tree")));
	});
});

test("checkpoint mode creates a local branch and commits only successful tasks with changes", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["New local branch + commit after each task"],
			inputs: ["feature/local-checkpoints"],
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
			gitResults: [
				gitResult("true\n"),
				gitResult(),
				gitResult(),
				gitResult(" M one.ts\n"),
				gitResult(),
				gitResult(),
				gitResult(),
			],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.deepEqual(runtime.execCalls.map(({ args }) => args), [
			["rev-parse", "--is-inside-work-tree"],
			["status", "--porcelain"],
			["switch", "-c", "feature/local-checkpoints"],
			["status", "--porcelain"],
			["add", "-A"],
			["commit", "-m", "Task 1: One"],
			["status", "--porcelain"],
		]);
		assert.equal(runtime.sent.length, 2);
		assert.equal(runtime.execCalls.filter(({ args }) => args[0] === "commit").length, 1);
		assertNoRemoteGit(runtime.execCalls);
	});
});

test("Git checkpoint failure stops before the next task", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["New local branch + commit after each task"],
			inputs: ["feature/checkpoint-failure"],
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
			gitResults: [
				gitResult("true\n"),
				gitResult(),
				gitResult(),
				gitResult(" M one.ts\n"),
				gitResult(),
				gitResult("", 1, "commit hook failed"),
			],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.equal(runtime.sent.length, 1);
		assert.ok(runtime.notifications.some(({ message }) => message.includes("Git commit failed")));
		assertNoRemoteGit(runtime.execCalls);
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

test("automatic compaction waits above 70% before starting the next task", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", COMPACTION_ENABLED_CHOICE],
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
			contextUsages: [{ tokens: 74, contextWindow: 100, percent: 74 }],
			compactionOutcomes: ["manual"],
		});

		const execution = runtime.run("implement-tasks", "tasks.md");
		await waitFor(() => runtime.compactCalls.length === 1);

		assert.equal(runtime.sent.length, 1);
		assert.equal(runtime.compactCalls.length, 1);
		assert.ok(runtime.widgets.at(-1)?.some((line) => line.includes("✓") && line.includes("One")));
		assert.ok(runtime.widgets.at(-1)?.some((line) => line.includes("○") && line.includes("Two")));
		assert.equal(runtime.workingMessages.at(-1), "Compact context before task 2 (74%)");

		runtime.compactCalls[0].onComplete?.({});
		await execution;
		assert.equal(runtime.sent.length, 2);
		assert.equal(runtime.workingMessages.at(-1), undefined);
	});
});

test("compaction failure stops before the next task", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", COMPACTION_ENABLED_CHOICE],
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
			contextUsages: [{ tokens: 80, contextWindow: 100, percent: 80 }],
			compactionOutcomes: ["error"],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.equal(runtime.sent.length, 1);
		assert.equal(runtime.compactCalls.length, 1);
		assert.ok(runtime.notifications.some(({ message }) => message.includes("compaction failed")));
		assert.ok(runtime.widgets.at(-1)?.some((line) => line.includes("✓") && line.includes("One")));
		assert.ok(runtime.widgets.at(-1)?.some((line) => line.includes("○") && line.includes("Two")));
	});
});

test("automatic compaction does not inspect usage after the final task", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "one task");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", COMPACTION_ENABLED_CHOICE],
			modelOutputs: [{ tasks: [{ title: "One" }] }],
			contextUsages: [{ tokens: 90, contextWindow: 100, percent: 90 }],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.equal(runtime.contextUsageCalls, 0);
		assert.equal(runtime.compactCalls.length, 0);
		assert.equal(runtime.sent.length, 1);
	});
});

test("/implement-plan receives automatic compaction through the delegated task workflow", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "plan.md"), "Build, then test.");
		const generated = "# Tasks\n\n## Task 1 - Build\n\nBuild.\n\n## Task 2 - Test\n\nTest.\n";
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", COMPACTION_ENABLED_CHOICE],
			modelOutputs: [generated, { tasks: [{ title: "Build" }, { title: "Test" }] }],
			contextUsages: [{ tokens: 85, contextWindow: 100, percent: 85 }],
		});

		await runtime.run("implement-plan", "plan.md");

		assert.equal(runtime.compactCalls.length, 1);
		assert.equal(runtime.contextUsageCalls, 1);
		assert.equal(runtime.sent.length, 2);
		assert.ok(runtime.selections.some(({ title }) => title === "Automatic compaction between tasks?"));
	});
});

test("/implement-plan overwrites with confirmation then delegates to the task-file workflow", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "plan.md"), "Build API, then test it.");
		await writeFile(join(directory, "tasks.md"), "old tasks\n");
		const generated = "# Tasks\n\n## Task 1 - Build API\n\nBuild it.\n\n## Task 2 - Test API\n\nTest it.\n";
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Overwrite", "Implement only"],
			modelOutputs: [generated, { tasks: [{ title: "Build API" }, { title: "Test API" }] }],
			gitResults: [gitResult("true\n")],
		});

		await runtime.run("implement-plan", "plan.md");

		assert.equal(await readFile(join(directory, "tasks.md"), "utf8"), generated);
		assert.equal(runtime.completeCalls.length, 2);
		const secondContext = runtime.completeCalls[1][1] as { systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }> };
		assert.equal(secondContext.systemPrompt, TASK_INDEX_PROMPT);
		assert.equal(secondContext.messages[0].content[0].text, generated);
		assert.match(runtime.selections[0].title, /tasks\.md already exists/);
		assert.match(runtime.selections[1].title, /Implement tasks from tasks\.md/);
		assert.deepEqual(runtime.selections[1].choices, [
			"Implement only",
			"New local branch + commit after each task",
			"Cancel",
		]);
		assert.deepEqual(runtime.execCalls[0].args, ["rev-parse", "--is-inside-work-tree"]);
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
