import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { COMPACTION_ENABLED_CHOICE } from "../src/compaction.ts";
import implementExtension, { readMarkdownInput } from "../src/index.ts";
import { STATE_FILE_NAME, loadState, saveState, type ImplementationState } from "../src/state.ts";
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
	const directory = await mkdtemp(join(tmpdir(), "pi-implement-test-"));
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
	ignoreStateChoice?: "Yes" | "No";
	manualTurns?: boolean;
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
	const ignoreStatePrompts: Array<{ title: string; choices: string[] }> = [];
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
	const pendingTurnReasons: string[] = [];

	const emit = async (name: string, event: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) {
			await handler(event, ctx);
		}
	};

	const settleTurn = async (override?: string) => {
		const queuedStopReason = pendingTurnReasons.shift();
		const stopReason = override ?? queuedStopReason ?? "stop";
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
			pendingTurnReasons.push(stopReasons.shift() ?? "stop");
			if (!options.manualTurns) {
				queueMicrotask(() => void settleTurn());
			}
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
				if (title.includes(".pi-implement-state.json")) {
					ignoreStatePrompts.push({ title, choices: selectChoices });
					return options.ignoreStateChoice ?? "Yes";
				}
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
		ignoreStatePrompts,
		notifications,
		selections,
		sent,
		sessionHistory,
		widgets,
		workingMessages,
		settleTurn,
		async run(command: string, argument: string) {
			const handler = commands.get(command);
			assert.ok(handler, `/${command} should be registered`);
			await handler(argument, ctx);
		},
	};
}

function savedState(cwd: string, overrides: Partial<ImplementationState> = {}): ImplementationState {
	return {
		version: 1,
		cwd: resolve(cwd),
		sourcePath: "tasks.md",
		tasks: [
			{ title: "One", prompt: "saved prompt one" },
			{ title: "Two", prompt: "saved prompt two" },
			{ title: "Three", prompt: "saved prompt three" },
		],
		nextTaskIndex: 1,
		status: "running",
		checkpoint: false,
		automaticCompaction: false,
		...overrides,
	};
}

test("registers the two implementation commands and removes the old /implement command", () => {
	const runtime = fakeRuntime({ cwd: process.cwd() });
	assert.deepEqual([...runtime.commands.keys()].sort(), ["implement-plan", "implement-tasks"]);
	assert.equal(runtime.commands.has("implement"), false);
});

test("file handling reports command-specific usage for a missing argument", async () => {
	await assert.rejects(
		readMarkdownInput("   ", process.cwd(), "/implement-tasks"),
		/Usage: \/implement-tasks/,
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

for (const status of ["running", "failed"] as const) {
	test(`restore resumes ${status} state from the saved task without model preparation`, async () => {
		await withTempDir(async (directory) => {
			const state = savedState(directory, { status, error: status === "failed" ? "previous failure" : undefined });
			await saveState(directory, state);
			const runtime = fakeRuntime({ cwd: directory, choices: ["Resume"], gitUnavailable: true });

			await runtime.run("implement-plan", "missing-plan.md");

			assert.deepEqual(runtime.sent, ["saved prompt two", "saved prompt three"]);
			assert.equal(runtime.completeCalls.length, 0);
			assert.equal(runtime.execCalls.length, 0);
			assert.equal(runtime.ignoreStatePrompts.length, 0);
			assert.match(runtime.selections[0].title, new RegExp(`Status: ${status}`));
			if (status === "failed") assert.match(runtime.selections[0].title, /Error: previous failure/);
			assert.equal(await loadState(directory), undefined);
		});
	});
}

test("discard deletes saved state and starts the newly requested workflow", async () => {
	await withTempDir(async (directory) => {
		await saveState(directory, savedState(join(directory, "original")));
		await writeFile(join(directory, "tasks.md"), "## Task 1 - New\nImplement it.");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Discard and start new", "Implement", "No"],
			modelOutputs: [{ tasks: [{ title: "New" }] }],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.equal(runtime.completeCalls.length, 1);
		assert.equal(runtime.sent.length, 1);
		assert.match(runtime.sent[0], /task #1 \("New"\)/);
		assert.equal(runtime.sent.includes("saved prompt two"), false);
		assert.equal(runtime.ignoreStatePrompts.length, 0);
		assert.equal(await loadState(directory), undefined);
	});
});

test("restore cancellation leaves state unchanged", async () => {
	await withTempDir(async (directory) => {
		const state = savedState(directory, { status: "failed", error: "keep this" });
		await saveState(directory, state);
		const before = await readFile(join(directory, STATE_FILE_NAME), "utf8");
		const runtime = fakeRuntime({ cwd: directory, choices: ["Cancel"] });

		await runtime.run("implement-tasks", "missing.md");

		assert.equal(await readFile(join(directory, STATE_FILE_NAME), "utf8"), before);
		assert.equal(runtime.completeCalls.length, 0);
		assert.deepEqual(runtime.sent, []);
		assert.equal(runtime.ignoreStatePrompts.length, 0);
	});
});

test("restore rejects a different working directory before saved work can run", async () => {
	await withTempDir(async (directory) => {
		const originalCwd = join(directory, "packages", "original");
		const currentCwd = join(directory, "packages", "current");
		await mkdir(join(directory, ".git"));
		await mkdir(originalCwd, { recursive: true });
		await mkdir(currentCwd, { recursive: true });
		await saveState(originalCwd, savedState(originalCwd, { pendingCompaction: true, automaticCompaction: true }));
		const runtime = fakeRuntime({ cwd: currentCwd, choices: ["Resume"] });

		await runtime.run("implement-tasks", "missing.md");

		assert.deepEqual(runtime.sent, []);
		assert.equal(runtime.execCalls.length, 0);
		assert.equal(runtime.compactCalls.length, 0);
		assert.equal(runtime.completeCalls.length, 0);
		assert.ok(
			runtime.notifications.some(
				({ message }) =>
					message ===
					`Cannot resume this implementation from a different working directory.\nExpected: ${resolve(originalCwd)}\nCurrent: ${resolve(currentCwd)}`,
			),
		);
		assert.equal((await loadState(currentCwd))?.pendingCompaction, true);
	});
});

test("checkpoint restore validates the saved branch without switching", async () => {
	await withTempDir(async (directory) => {
		await saveState(
			directory,
			savedState(directory, { checkpoint: true, branchName: "feature/saved", status: "failed", error: "commit failed" }),
		);
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Resume"],
			gitResults: [gitResult("feature/other\n")],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.deepEqual(runtime.execCalls.map(({ args }) => args), [["branch", "--show-current"]]);
		assert.equal(runtime.execCalls.some(({ args }) => args[0] === "switch"), false);
		assert.deepEqual(runtime.sent, []);
		assert.equal(runtime.completeCalls.length, 0);
		assert.ok(runtime.notifications.some(({ message }) => message.includes("expected local branch")));
		assert.equal((await loadState(directory))?.status, "failed");
	});
});

test("repository workflows offer the state-file gitignore update with Yes as the default", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement only", "No"],
			modelOutputs: [{ tasks: [{ title: "One" }] }],
			gitResults: [gitResult("true\n")],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.deepEqual(runtime.ignoreStatePrompts[0].choices, ["Yes", "No"]);
		assert.equal(await readFile(join(directory, ".gitignore"), "utf8"), `${STATE_FILE_NAME}\n`);
	});
});

test("workflow state is saved before each task, advances without Git, and is deleted after success", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", "No"],
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
			manualTurns: true,
		});

		const execution = runtime.run("implement-tasks", "tasks.md");
		await waitFor(() => runtime.sent.length === 1);
		const started = await loadState(directory);
		assert.equal(started?.cwd, resolve(directory));
		assert.equal(started?.status, "running");
		assert.equal(started?.nextTaskIndex, 0);
		assert.deepEqual(started?.tasks.map(({ title }) => title), ["One", "Two"]);
		assert.deepEqual(started?.tasks.map(({ prompt }) => prompt), [runtime.sent[0], runtime.sent[0].replace("#1 (\"One\")", "#2 (\"Two\")")]);

		await runtime.settleTurn();
		await waitFor(() => runtime.sent.length === 2);
		const advanced = await loadState(directory);
		assert.equal(advanced?.status, "running");
		assert.equal(advanced?.nextTaskIndex, 1);

		await runtime.settleTurn();
		await execution;
		assert.equal(await loadState(directory), undefined);
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
		assert.equal(runtime.ignoreStatePrompts.length, 0);
		await assert.rejects(readFile(join(directory, ".gitignore"), "utf8"), /ENOENT/);
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
				gitResult(),
				gitResult(),
				gitResult("", 1),
				gitResult(),
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
			["add", "-A"],
			["reset", "-q", "HEAD", "--", STATE_FILE_NAME],
			["diff", "--cached", "--quiet"],
			["commit", "-m", "Task 1: One"],
			["add", "-A"],
			["reset", "-q", "HEAD", "--", STATE_FILE_NAME],
			["diff", "--cached", "--quiet"],
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
				gitResult(),
				gitResult(),
				gitResult("", 1),
				gitResult("", 1, "commit hook failed"),
			],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.equal(runtime.sent.length, 1);
		assert.ok(runtime.notifications.some(({ message }) => message.includes("Git commit failed")));
		const saved = await loadState(directory);
		assert.equal(saved?.status, "failed");
		assert.equal(saved?.nextTaskIndex, 0);
		assert.match(saved?.error ?? "", /Git commit failed/);
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
		const saved = await loadState(directory);
		assert.equal(saved?.status, "failed");
		assert.equal(saved?.nextTaskIndex, 1);
		assert.equal(saved?.error, "provider failed");
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

test("compaction start is recoverable during interruption and success clears the pending flag", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", COMPACTION_ENABLED_CHOICE],
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
			contextUsages: [{ tokens: 80, contextWindow: 100, percent: 80 }],
			compactionOutcomes: ["manual"],
			manualTurns: true,
		});

		const execution = runtime.run("implement-tasks", "tasks.md");
		await waitFor(() => runtime.sent.length === 1);
		await runtime.settleTurn();
		await waitFor(() => runtime.compactCalls.length === 1);

		const interrupted = await loadState(directory);
		assert.equal(interrupted?.nextTaskIndex, 1);
		assert.equal(interrupted?.status, "running");
		assert.equal(interrupted?.pendingCompaction, true);
		assert.equal(runtime.sent.length, 1);

		runtime.compactCalls[0].onComplete?.({});
		await waitFor(() => runtime.sent.length === 2);
		const completedCompaction = await loadState(directory);
		assert.equal(completedCompaction?.nextTaskIndex, 1);
		assert.equal(completedCompaction?.pendingCompaction, undefined);

		await runtime.settleTurn();
		await execution;
		assert.equal(await loadState(directory), undefined);
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
		const saved = await loadState(directory);
		assert.equal(saved?.status, "failed");
		assert.equal(saved?.nextTaskIndex, 1);
		assert.equal(saved?.pendingCompaction, true);
		assert.equal(saved?.error, "compaction failed");

		const resumed = fakeRuntime({
			cwd: directory,
			choices: ["Resume"],
			compactionOutcomes: ["complete"],
			manualTurns: true,
		});
		const resumedExecution = resumed.run("implement-tasks", "missing.md");
		await waitFor(() => resumed.sent.length === 1);

		assert.equal(resumed.compactCalls.length, 1);
		assert.equal(resumed.contextUsageCalls, 0);
		assert.deepEqual(resumed.sent, [saved?.tasks[1].prompt]);
		assert.match(resumed.selections[0].title, /Pending compaction: yes/);
		const afterCompaction = await loadState(directory);
		assert.equal(afterCompaction?.nextTaskIndex, 1);
		assert.equal(afterCompaction?.pendingCompaction, undefined);
		assert.equal(afterCompaction?.status, "running");

		await resumed.settleTurn();
		await resumedExecution;
		assert.equal(await loadState(directory), undefined);
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
