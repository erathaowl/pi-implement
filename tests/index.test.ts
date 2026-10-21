import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { COMPACTION_ENABLED_CHOICE, DEFAULT_COMPACTION_THRESHOLD_PERCENT } from "../src/compaction.ts";
import implementExtension, { formatProgress, readMarkdownInput, selectExecutionOptions, startExecutionSetup } from "../src/index.ts";
import { STATE_FILE_NAME, loadState, saveState, type ImplementationState } from "../src/state.ts";
import { snapshotGeneratedTasks } from "../src/plan.ts";
import { TASK_INDEX_PROMPT } from "../src/tasks.ts";

initTheme("dark");

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

type FakeModel = {
	provider: string;
	id: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
};

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const gitResult = (stdout = "", code = 0, stderr = ""): GitResult => ({ stdout, stderr, code, killed: false });
const UNSTAGE_STATE = ["reset", "-q", "--", `:(top)${STATE_FILE_NAME}`, `:(top)${STATE_FILE_NAME}.tmp`];

const fakeModel = (provider: string, id: string): FakeModel => ({
	provider,
	id,
	reasoning: true,
	thinkingLevelMap: { xhigh: "xhigh", max: "max" },
});

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
	gitResults?: Array<GitResult | Promise<GitResult>>;
	gitUnavailable?: boolean;
	inputs?: string[];
	confirmations?: boolean[];
	contextUsages?: Array<{ tokens: number | null; contextWindow: number; percent: number | null } | undefined>;
	compactionOutcomes?: Array<"complete" | "error" | "manual">;
	ignoreStateChoice?: "Yes" | "No";
	manualTurns?: boolean;
	models?: FakeModel[];
	currentModel?: FakeModel;
	thinkingLevel?: ThinkingLevel;
	scopedModels?: FakeModel[];
	setModelOutcomes?: Array<boolean | Error>;
	thresholdInputs?: Array<string | undefined>;
	summaryActions?: Array<"Start implementation" | "Resume" | "Cancel" | "escape">;
	onSummary?: () => void | Promise<void>;
	preflightSnapshots?: string[];
	currentBranch?: string;
}) {
	const commands = new Map<string, Handler>();
	const handlers = new Map<string, Handler[]>();
	const sent: string[] = [];
	const completeCalls: unknown[][] = [];
	const completeSettings: Array<{ model: string; thinkingLevel: ThinkingLevel }> = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	const selections: Array<{ title: string; choices: string[] }> = [];
	const widgets: Array<string[] | undefined> = [];
	const workingMessages: Array<string | undefined> = [];
	const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const preflightCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
	const summaryActions = [...(options.summaryActions ?? [])];
	const preflightSnapshots = [...(options.preflightSnapshots ?? [])];
	let mockHead = "baseline";
	let mockBranch = options.currentBranch ?? "main";
	const inputPrompts: Array<{ title: string; placeholder?: string }> = [];
	const confirmationPrompts: Array<{ title: string; message: string }> = [];
	const ignoreStatePrompts: Array<{ title: string; choices: string[] }> = [];
	const compactCalls: CompactCallbacks[] = [];
	const setModelCalls: FakeModel[] = [];
	const setThinkingLevelCalls: ThinkingLevel[] = [];
	const sentSettings: Array<{ model: string; thinkingLevel: ThinkingLevel }> = [];
	let contextUsageCalls = 0;
	const stopReasons = [...(options.turnStopReasons ?? [])];
	const modelOutputs = [...(options.modelOutputs ?? [])];
	const choices = [...(options.choices ?? [])];
	const gitResults = options.gitResults
		? [...options.gitResults]
		: [gitResult("", 128, "fatal: not a git repository (or any of the parent directories): .git")];
	const inputs = [...(options.inputs ?? [])];
	const confirmations = [...(options.confirmations ?? [])];
	const contextUsages = [...(options.contextUsages ?? [])];
	const compactionOutcomes = [...(options.compactionOutcomes ?? [])];
	const defaultModel: FakeModel = {
		provider: "test",
		id: "selected",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	};
	let currentModel = options.currentModel ?? defaultModel;
	let currentThinkingLevel = options.thinkingLevel ?? "medium";
	const models = options.models ?? [currentModel];
	const setModelOutcomes = [...(options.setModelOutcomes ?? [])];
	const thresholdInputs = [...(options.thresholdInputs ?? [])];
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
			// Keep the new read-only guards separate from legacy scripted Git results and assertions.
			if (args.includes("--porcelain=v2")) {
				preflightCalls.push({ command, args, cwd: execOptions?.cwd });
				return gitResult(preflightSnapshots.shift() ?? "# branch.head main\n# branch.oid baseline\n");
			}
			if (args.join(" ") === "rev-parse --verify --quiet HEAD") {
				preflightCalls.push({ command, args, cwd: execOptions?.cwd });
				return gitResult(`${mockHead}\n`);
			}
			const saved = await loadState(options.cwd);
			if (saved?.phase === "setup" && (args[0] === "branch" || args[0] === "reset" || (args[0] === "diff" && args.includes("--name-only")))) {
				preflightCalls.push({ command, args, cwd: execOptions?.cwd });
				return gitResult(args[0] === "branch" ? `${mockBranch}\n` : args[0] === "diff" ? "dirty.txt\n" : "");
			}
			execCalls.push({ command, args, cwd: execOptions?.cwd });
			if (options.gitUnavailable) {
				throw new Error("git not found");
			}
			const result = await (gitResults.shift() ?? gitResult());
			if (result.code === 0 && args[0] === "switch") mockBranch = args.at(-1)!;
			if (result.code === 0 && args[0] === "commit") mockHead = `${mockHead}-commit`;
			return result;
		},
		sendUserMessage(message: string) {
			sent.push(message);
			sentSettings.push({ model: `${currentModel.provider}/${currentModel.id}`, thinkingLevel: currentThinkingLevel });
			pendingTurnReasons.push(stopReasons.shift() ?? "stop");
			if (!options.manualTurns) {
				queueMicrotask(() => void settleTurn());
			}
		},
		async setModel(model: FakeModel) {
			setModelCalls.push(model);
			const outcome = setModelOutcomes.shift() ?? true;
			if (outcome instanceof Error) throw outcome;
			if (outcome) currentModel = model;
			return outcome;
		},
		getThinkingLevel() {
			return currentThinkingLevel;
		},
		setThinkingLevel(level: ThinkingLevel) {
			setThinkingLevelCalls.push(level);
			currentThinkingLevel = level;
		},
	};

	const ctx = {
		cwd: options.cwd,
		hasUI: true,
		mode: "tui",
		get model() {
			return currentModel;
		},
		get thinkingLevel() {
			return currentThinkingLevel;
		},
		scopedModels: (options.scopedModels ?? []).map((model) => ({ model })),
		isIdle: () => true,
		modelRegistry: {
			getAvailable() {
				return models;
			},
			find(provider: string, id: string) {
				return models.find((model) => model.provider === provider && model.id === id);
			},
			async complete(...args: unknown[]) {
				completeCalls.push(args);
				completeSettings.push({ model: `${currentModel.provider}/${currentModel.id}`, thinkingLevel: currentThinkingLevel });
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
			async custom(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
				return new Promise((done, reject) => {
					const selector = factory({ terminal: { rows: 40 }, requestRender() {} } as never, {} as never, getKeybindings(), done);
					assert.ok(!(selector instanceof Promise));
					const lines = selector.render(200).map(stripVTControlCharacters);
					const menuChoices = lines.map((line) => line.trim().replace(/^→ /, ""))
						.filter((line) => ["Implement", "Implement only", "Git checkpoints: new or current local branch", "Start implementation", "Resume", "Cancel"].includes(line));
					selections.push({ title: lines.join("\n"), choices: menuChoices });
					const isSummary = lines[0].includes("Execution summary");
					const choice = isSummary ? summaryActions.shift() ?? (menuChoices.includes("Resume") ? "Resume" : "Start implementation") : choices.shift();
					if (choice !== undefined && choice !== "escape") {
						const selectedIndex = lines.filter((line) => line.trim().startsWith("→ "))
							.map((line) => menuChoices.indexOf(line.trim().slice(2)))[0];
						const targetIndex = menuChoices.indexOf(choice);
						assert.notEqual(targetIndex, -1);
						for (let i = 0; i < Math.abs(targetIndex - selectedIndex); i++) {
							selector.handleInput?.(targetIndex < selectedIndex ? "\u001b[A" : "\u001b[B");
						}
					}
					const finish = () => selector.handleInput?.(choice === "escape" ? "\u001b" : "\r");
					if (isSummary) void Promise.resolve().then(options.onSummary).then(finish, reject);
					else finish();
				});
			},
			async select(title: string, selectChoices: string[]) {
				if (title.startsWith("Add .pi-implement-state.json")) {
					ignoreStatePrompts.push({ title, choices: selectChoices });
					return options.ignoreStateChoice ?? "Yes";
				}
				selections.push({ title, choices: selectChoices });
				if (title.startsWith("Execution summary")) {
					await options.onSummary?.();
					const response = summaryActions.shift();
					return response === "escape" ? undefined : response ?? selectChoices[1];
				}
				const choice = choices.shift();
				if (choice !== undefined) return choice;
				if (title === "Automatic compaction between tasks?") return selectChoices[0];
				if (title.startsWith("Implementation model for all tasks")) {
					return `${currentModel.provider}/${currentModel.id}`;
				}
				if (title.startsWith("Thinking level for all implementation tasks")) return currentThinkingLevel;
				return undefined;
			},
			async input(title: string, placeholder?: string) {
				inputPrompts.push({ title, placeholder });
				if (title.startsWith("Compaction threshold percentage")) {
					return thresholdInputs.length > 0 ? thresholdInputs.shift() : "";
				}
				return inputs.shift();
			},
			async confirm(title: string, message: string) {
				confirmationPrompts.push({ title, message });
				return confirmations.shift() ?? false;
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
		pi,
		compactCalls,
		completeCalls,
		completeSettings,
		confirmationPrompts,
		get contextUsageCalls() {
			return contextUsageCalls;
		},
		ctx,
		execCalls,
		preflightCalls,
		inputPrompts,
		ignoreStatePrompts,
		notifications,
		selections,
		sent,
		sentSettings,
		setModelCalls,
		setThinkingLevelCalls,
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

function savedState(cwd: string, overrides: Partial<Omit<ImplementationState, "pendingCheckpoint">> & { pendingCheckpoint?: ImplementationState["pendingCheckpoint"] | boolean } = {}): ImplementationState {
	const { pendingCheckpoint, ...rest } = overrides;
	return {
		version: 2,
		phase: "tasks",
		review: { enabled: false },
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
		compactionThresholdPercent: DEFAULT_COMPACTION_THRESHOLD_PERCENT,
		implementationModel: { provider: "test", id: "selected" },
		implementationThinkingLevel: "medium",
		...rest,
		...(pendingCheckpoint ? { pendingCheckpoint: typeof pendingCheckpoint === "boolean" ? { purpose: "task", message: `Task ${overrides.nextTaskIndex ?? 1}: One` } : pendingCheckpoint } : {}),
	};
}

for (const command of ["implement-tasks", "implement-plan"]) {
	for (const previous of [false, true]) {
		for (const action of ["Cancel", "escape"] as const) {
			test(`${command}: ${action} at summary preserves files and ${previous ? "old recovery state" : "absence of state"}`, async () => {
				await withTempDir(async (directory) => {
					await writeFile(join(directory, "plan.md"), "Original plan\n");
					await writeFile(join(directory, "tasks.md"), "Original tasks\n");
					await writeFile(join(directory, ".gitignore"), "original-ignore\n");
					if (previous) await saveState(directory, savedState(directory));
					const before = previous ? await readFile(join(directory, STATE_FILE_NAME), "utf8") : undefined;
					const runtime = fakeRuntime({
						cwd: directory,
						choices: [...(previous ? ["Discard and start new"] : []), ...(command === "implement-plan" ? ["Overwrite"] : []), "Git checkpoints: new or current local branch"],
						inputs: ["feature/not-created"],
						gitResults: [gitResult("true\n"), gitResult(" M dirty.txt\n")],
						modelOutputs: command === "implement-plan" ? ["## Task 1 - One\n", { tasks: [{ title: "One" }] }] : undefined,
						summaryActions: [action],
					});
					await runtime.run(command, command === "implement-plan" ? "plan.md" : "tasks.md");
					assert.equal(await readFile(join(directory, "tasks.md"), "utf8"), "Original tasks\n");
					assert.equal(await readFile(join(directory, ".gitignore"), "utf8"), "original-ignore\n");
					if (previous) assert.equal(await readFile(join(directory, STATE_FILE_NAME), "utf8"), before);
					else assert.equal(await loadState(directory), undefined);
					assert.deepEqual(runtime.execCalls.map(({ args }) => args[0]), ["rev-parse", "--no-optional-locks"]);
					assert.deepEqual(runtime.sent, []);
					assert.deepEqual(runtime.setModelCalls, []);
					const summary = runtime.selections.find(({ title }) => title.startsWith("Execution summary"));
					assert.ok(summary);
					assert.match(summary.title, new RegExp(`Command: /${command}`));
					assert.match(summary.title, /Initial dirty-state commit: Planned/);
					assert.match(summary.title, /Final review: Disabled/);
					if (command === "implement-plan") assert.match(summary.title, /Source plan: plan.md/);
				});
			});
		}
	}

	test(`${command}: confirmed setup starts only after the summary`, async () => {
		await withTempDir(async (directory) => {
			await writeFile(join(directory, "plan.md"), "Plan\n");
			await writeFile(join(directory, "tasks.md"), "Original tasks\n");
			let confirmed = false;
			const runtime: ReturnType<typeof fakeRuntime> = fakeRuntime({
				cwd: directory,
				choices: [...(command === "implement-plan" ? ["Overwrite"] : []), "Git checkpoints: new or current local branch"],
				inputs: ["feature/confirmed"],
				gitResults: [gitResult("true\n"), gitResult(" M dirty.txt\n")],
				modelOutputs: command === "implement-plan" ? ["## Task 1 - One\n", { tasks: [{ title: "One" }] }] : undefined,
				turnStopReasons: ["error"],
				onSummary: async () => {
					assert.equal(await loadState(directory), undefined);
					await assert.rejects(readFile(join(directory, ".gitignore")), { code: "ENOENT" });
					assert.equal(await readFile(join(directory, "tasks.md"), "utf8"), "Original tasks\n");
					assert.deepEqual(runtime.execCalls.map(({ args }) => args[0]), ["rev-parse", "--no-optional-locks"]);
					assert.deepEqual(runtime.sent, []);
					confirmed = true;
				},
			});
			await runtime.run(command, command === "implement-plan" ? "plan.md" : "tasks.md");
			assert.equal(confirmed, true);
			assert.deepEqual(runtime.execCalls.map(({ args }) => args[0]), ["rev-parse", "--no-optional-locks", "switch", "write-tree", "add", "commit"]);
			assert.match(await readFile(join(directory, ".gitignore"), "utf8"), /\.pi-implement-state.json/);
			assert.equal(runtime.sent.length, 1);
			assert.ok(await loadState(directory));
			if (command === "implement-plan") assert.equal(await readFile(join(directory, "tasks.md"), "utf8"), "## Task 1 - One\n");
			assertNoRemoteGit([...runtime.execCalls, ...runtime.preflightCalls]);
		});
	});
}

for (const changed of ["tasks", "gitignore", "branch", "HEAD", "recovery"] as const) {
	test(`changed ${changed} at confirmation aborts before setup`, async () => {
		await withTempDir(async (directory) => {
			await writeFile(join(directory, "plan.md"), "Plan\n");
			await writeFile(join(directory, "tasks.md"), "Original\n");
			await writeFile(join(directory, ".gitignore"), "original-ignore\n");
			await saveState(directory, savedState(directory));
			const before = await readFile(join(directory, STATE_FILE_NAME), "utf8");
			const runtime = fakeRuntime({
				cwd: directory,
				choices: ["Discard and start new", "Overwrite", "Git checkpoints: new or current local branch"],
				inputs: ["feature/not-created"],
				gitResults: [gitResult("true\n"), gitResult(" M dirty.txt\n")],
				modelOutputs: ["## Task 1 - One\n", { tasks: [{ title: "One" }] }],
				preflightSnapshots: ["# branch.head main\n# branch.oid baseline\n", changed === "branch" || changed === "HEAD" ? changed : "# branch.head main\n# branch.oid baseline\n"],
				onSummary: async () => {
					if (changed === "tasks") await writeFile(join(directory, "tasks.md"), "External tasks\n");
					if (changed === "gitignore") await writeFile(join(directory, ".gitignore"), "external-ignore\n");
					if (changed === "recovery") await saveState(directory, savedState(directory, { error: "External state" }));
				},
			});
			await runtime.run("implement-plan", "plan.md");
			assert.deepEqual(runtime.execCalls.map(({ args }) => args[0]), ["rev-parse", "--no-optional-locks"]);
			assert.deepEqual(runtime.sent, []);
			assert.equal(await readFile(join(directory, "tasks.md"), "utf8"), changed === "tasks" ? "External tasks\n" : "Original\n");
			assert.equal(await readFile(join(directory, ".gitignore"), "utf8"), changed === "gitignore" ? "external-ignore\n" : "original-ignore\n");
			if (changed !== "recovery") assert.equal(await readFile(join(directory, STATE_FILE_NAME), "utf8"), before);
			assert.ok(runtime.notifications.some(({ type, message }) => type === "error" && message.includes("changed")));
		});
	});
}

for (const command of ["implement-tasks", "implement-plan"]) {
	for (const action of ["Start implementation", "Cancel"] as const) {
		test(`RPC ${command} ${action} is gated by its execution summary`, async () => {
			await withTempDir(async (directory) => {
				await writeFile(join(directory, "plan.md"), "Plan\n");
				await writeFile(join(directory, "tasks.md"), "Original tasks\n");
				const runtime = fakeRuntime({
					cwd: directory,
					choices: [...(command === "implement-plan" ? ["Overwrite"] : []), "Implement"],
					modelOutputs: command === "implement-plan" ? ["## Task 1 - One\n", { tasks: [{ title: "One" }] }] : undefined,
					summaryActions: [action],
				});
				runtime.ctx.mode = "rpc";
				await runtime.run(command, command === "implement-plan" ? "plan.md" : "tasks.md");
				assert.equal(runtime.sent.length, action === "Start implementation" ? 1 : 0);
				assert.ok(runtime.selections.some(({ choices }) => choices.join(",") === "Cancel,Start implementation"));
				assert.equal(await loadState(directory), undefined);
				if (action === "Cancel") assert.equal(await readFile(join(directory, "tasks.md"), "utf8"), "Original tasks\n");
			});
		});
	}
}

for (const command of ["implement-tasks", "implement-plan"]) {
	test(`${command}: changed source material aborts before setup`, async () => {
		await withTempDir(async (directory) => {
			const source = command === "implement-plan" ? "plan.md" : "tasks.md";
			await writeFile(join(directory, source), "Original source\n");
			const runtime = fakeRuntime({
				cwd: directory,
				modelOutputs: command === "implement-plan" ? ["## Task 1 - One\n", { tasks: [{ title: "One" }] }] : undefined,
				onSummary: async () => { await writeFile(join(directory, source), "External source\n"); },
			});
			await runtime.run(command, source);
			assert.deepEqual(runtime.sent, []);
			assert.equal(await loadState(directory), undefined);
			assert.equal(await readFile(join(directory, source), "utf8"), "External source\n");
			assert.ok(runtime.notifications.some(({ message }) => message.includes(`${source} changed`)));
		});
	});
}

test("version-1 workflows resume pending checkpoints and compaction without review prompts", async () => {
	await withTempDir(async (directory) => {
		const { phase: _phase, review: _review, ...common } = savedState(directory);
		const legacy = {
			...common, version: 1, checkpoint: true, branchName: "main", pendingCheckpoint: true,
			pendingCompaction: true, automaticCompaction: true,
		};
		const raw = JSON.stringify(legacy);
		await writeFile(join(directory, STATE_FILE_NAME), raw);
		const runtime = fakeRuntime({
			cwd: directory, choices: ["Resume"], gitResults: [gitResult("main\n")],
			onSummary: async () => {
				assert.equal(await readFile(join(directory, STATE_FILE_NAME), "utf8"), raw);
			},
		});
		await runtime.run("implement-tasks", "missing.md");
		assert.deepEqual(runtime.sent, legacy.tasks.slice(1).map(({ prompt }) => prompt));
		assert.equal(runtime.completeCalls.length, 0);
		assert.equal(runtime.compactCalls.length, 1);
		assert.ok(runtime.selections.some(({ title }) => title.includes("Final review: Disabled")));
		assert.ok(!runtime.selections.some(({ title }) => title === "Final review?"));
		assert.equal(await loadState(directory), undefined);
	});
});

test("interrupted plan setup resumes its saved branch and generated Markdown without reconversion", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "plan.md"), "Plan\n");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Git checkpoints: new or current local branch"], inputs: ["feature/setup"],
			gitResults: [gitResult("true\n"), gitResult(" M tracked.txt\n"), gitResult(), gitResult("saved-tree\n"), gitResult("", 1, "index locked")],
			modelOutputs: ["## Task 1 - Generated\n", { tasks: [{ title: "Generated" }] }],
		});
		await runtime.run("implement-plan", "plan.md");
		const interrupted = (await loadState(directory))!;
		assert.equal(interrupted.phase, "setup");
		assert.equal(interrupted.setup?.step, "initial_checkpoint");
		assert.equal(interrupted.pendingCheckpoint?.purpose, "initial");
		assert.equal(interrupted.preparedTasks?.markdown, "## Task 1 - Generated\n");
		await assert.rejects(readFile(join(directory, "tasks.md")), { code: "ENOENT" });
		const resumed = fakeRuntime({
			cwd: directory, choices: ["Resume"], currentBranch: "feature/setup",
			gitResults: [gitResult("saved-tree\n"), gitResult(), gitResult(), gitResult("feature/setup\n")],
		});
		await resumed.run("implement-plan", "missing.md");
		assert.equal(resumed.completeCalls.length, 0);
		assert.equal(resumed.execCalls.some(({ args }) => args[0] === "switch"), false);
		assert.equal(resumed.sent.length, 1);
		assert.equal(await readFile(join(directory, "tasks.md"), "utf8"), "## Task 1 - Generated\n");
		assert.equal(await loadState(directory), undefined);
	});
});

test("resume summary cancellation leaves pending recovery work untouched", async () => {
	await withTempDir(async (directory) => {
		await saveState(directory, savedState(directory, { checkpoint: true, branchName: "main", nextTaskIndex: 1, pendingCheckpoint: true }));
		const before = await readFile(join(directory, STATE_FILE_NAME), "utf8");
		const runtime = fakeRuntime({ cwd: directory, choices: ["Resume"], summaryActions: ["Cancel"] });
		await runtime.run("implement-tasks", "missing.md");
		assert.equal(await readFile(join(directory, STATE_FILE_NAME), "utf8"), before);
		assert.deepEqual(runtime.execCalls, []);
		assert.deepEqual(runtime.sent, []);
		assert.deepEqual(runtime.setModelCalls, []);
		assert.ok(runtime.selections.some(({ choices }) => choices.join(",") === "Resume,Cancel"));
	});
});

test("registers the two implementation commands and removes the old /implement command", () => {
	const runtime = fakeRuntime({ cwd: process.cwd() });
	assert.deepEqual([...runtime.commands.keys()].sort(), ["implement-plan", "implement-tasks"]);
	assert.equal(runtime.commands.has("implement"), false);
});

test("progress renders the first five tasks at the beginning", () => {
	const tasks = { tasks: Array.from({ length: 8 }, (_, index) => ({ title: `Task ${index + 1}` })) };
	const statuses = tasks.tasks.map((_, index) => index === 0 ? "running" as const : "pending" as const);

	assert.deepEqual(formatProgress("Task-file implementation", tasks, statuses), [
		"Task-file implementation",
		"● 1/8 Task 1",
		"○ 2/8 Task 2",
		"○ 3/8 Task 3",
		"○ 4/8 Task 4",
		"○ 5/8 Task 5",
	]);
});

test("progress advances its five-task window to a middle running task", () => {
	const tasks = { tasks: Array.from({ length: 20 }, (_, index) => ({ title: `Task ${index + 1}` })) };
	const statuses = tasks.tasks.map((_, index) => index === 7 ? "running" as const : "pending" as const);

	assert.deepEqual(formatProgress("Task-file implementation", tasks, statuses), [
		"Task-file implementation",
		"● 8/20 Task 8",
		"○ 9/20 Task 9",
		"○ 10/20 Task 10",
		"○ 11/20 Task 11",
		"○ 12/20 Task 12",
	]);
});

test("progress renders only the final task when it is running", () => {
	const tasks = { tasks: Array.from({ length: 20 }, (_, index) => ({ title: `Task ${index + 1}` })) };
	const statuses = tasks.tasks.map((_, index) => index === 19 ? "running" as const : "completed" as const);

	assert.deepEqual(formatProgress("Task-file implementation", tasks, statuses), [
		"Task-file implementation",
		"● 20/20 Task 20",
	]);
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

for (const workflow of [
	{
		command: "implement-tasks",
		sourcePath: "tasks.md",
		source: "## Task 1 - One\nDo one.",
		modelOutputs: [{ tasks: [{ title: "One" }] }],
		preparationCalls: 1,
	},
	{
		command: "implement-plan",
		sourcePath: "plan.md",
		source: "Do one thing.",
		modelOutputs: ["## Task 1 - One\n\nDo one.", { tasks: [{ title: "One" }] }],
		preparationCalls: 2,
	},
]) {
	for (const prompted of [false, true]) {
		test(`/${workflow.command} accepts a ${prompted ? "prompted" : "provided"} Markdown path`, async () => {
			await withTempDir(async (directory) => {
				await writeFile(join(directory, workflow.sourcePath), workflow.source);
				const runtime = fakeRuntime({
					cwd: directory,
					choices: ["Cancel"],
					inputs: prompted ? [`  ${workflow.sourcePath}  `] : [],
					modelOutputs: workflow.modelOutputs,
				});

				await runtime.run(workflow.command, prompted ? "   " : workflow.sourcePath);

				assert.equal(runtime.inputPrompts.length, prompted ? 1 : 0);
				if (prompted) {
					assert.deepEqual(runtime.inputPrompts[0], {
						title: `Markdown file for /${workflow.command}`,
						placeholder: "path/to/file.md",
					});
				}
				assert.equal(runtime.completeCalls.length, workflow.preparationCalls);
				assert.equal(runtime.notifications.some(({ type }) => type === "error"), false);
			});
		});
	}
}

for (const command of ["implement-tasks", "implement-plan"]) {
	for (const input of [undefined, "   "]) {
		test(`/${command} cancels cleanly for ${input === undefined ? "dismissed" : "empty"} file input`, async () => {
			await withTempDir(async (directory) => {
				const runtime = fakeRuntime({
					cwd: directory,
					inputs: input === undefined ? [] : [input],
				});

				await runtime.run(command, "");

				assert.equal(runtime.inputPrompts.length, 1);
				assert.equal(runtime.completeCalls.length, 0);
				assert.deepEqual(runtime.sent, []);
				assert.equal(runtime.notifications.some(({ type }) => type === "error"), false);
				assert.ok(runtime.notifications.some(({ message, type }) => type === "info" && message.includes("cancelled")));
			});
		});
	}
}

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

test("confirmed replacement supersedes saved state and starts the newly requested workflow", async () => {
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
			savedState(directory, {
				checkpoint: true,
				branchName: "feature/saved",
				status: "failed",
				error: "commit failed",
				pendingCheckpoint: true,
				pendingCompaction: true,
				automaticCompaction: true,
			}),
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
		assert.equal(runtime.compactCalls.length, 0);
		assert.equal((await loadState(directory))?.pendingCheckpoint?.purpose, "task");
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

test("implementation model and thinking selections default to the current pair", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "one task");
		const currentModel = fakeModel("current", "planning-model");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", "No"],
			currentModel,
			models: [currentModel, fakeModel("other", "implementation-model")],
			thinkingLevel: "high",
			manualTurns: true,
		});

		const execution = runtime.run("implement-tasks", "tasks.md");
		await waitFor(() => runtime.sent.length === 1);

		const modelSelection = runtime.selections.find(({ title }) => title.startsWith("Implementation model"));
		const thinkingSelection = runtime.selections.find(({ title }) => title.startsWith("Thinking level"));
		assert.equal(modelSelection?.choices[0], "current/planning-model");
		assert.equal(thinkingSelection?.choices[0], "high");
		assert.deepEqual((await loadState(directory))?.implementationModel, {
			provider: "current",
			id: "planning-model",
		});
		assert.equal((await loadState(directory))?.implementationThinkingLevel, "high");
		assert.deepEqual(runtime.sentSettings, [{ model: "current/planning-model", thinkingLevel: "high" }]);

		await runtime.settleTurn();
		await execution;
	});
});

test("a custom implementation model and thinking level are fixed for every task", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "two tasks");
		const currentModel = fakeModel("current", "planning-model");
		const implementationModel = fakeModel("selected", "implementation-model");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", "No", "selected/implementation-model", "high"],
			currentModel,
			models: [currentModel, implementationModel],
			thinkingLevel: "low",
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
			manualTurns: true,
		});

		const execution = runtime.run("implement-tasks", "tasks.md");
		await waitFor(() => runtime.sent.length === 1);
		const state = await loadState(directory);
		assert.deepEqual(state?.implementationModel, { provider: "selected", id: "implementation-model" });
		assert.equal(state?.implementationThinkingLevel, "high");

		await runtime.settleTurn();
		await waitFor(() => runtime.sent.length === 2);
		assert.deepEqual(runtime.sentSettings, [
			{ model: "selected/implementation-model", thinkingLevel: "high" },
			{ model: "selected/implementation-model", thinkingLevel: "high" },
		]);
		await runtime.settleTurn();
		await execution;
	});
});

test("Resume restores the persisted implementation model and thinking level", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "one task");
		const originalModel = fakeModel("current", "planning-model");
		const implementationModel = fakeModel("selected", "implementation-model");
		const failed = fakeRuntime({
			cwd: directory,
			choices: ["Implement", "No", "selected/implementation-model", "xhigh"],
			currentModel: originalModel,
			models: [originalModel, implementationModel],
			thinkingLevel: "low",
			turnStopReasons: ["error"],
		});
		await failed.run("implement-tasks", "tasks.md");
		assert.equal((await loadState(directory))?.implementationThinkingLevel, "xhigh");

		const laterCurrentModel = fakeModel("later", "active-model");
		const resumed = fakeRuntime({
			cwd: directory,
			choices: ["Resume"],
			currentModel: laterCurrentModel,
			models: [laterCurrentModel, implementationModel],
			thinkingLevel: "medium",
		});
		await resumed.run("implement-plan", "missing.md");

		assert.equal(resumed.completeCalls.length, 0);
		assert.equal(resumed.setModelCalls[0], implementationModel);
		assert.deepEqual(resumed.sentSettings, [
			{ model: "selected/implementation-model", thinkingLevel: "xhigh" },
		]);
		assert.equal(await loadState(directory), undefined);
	});
});

test("Resume fails clearly when the saved implementation model cannot be selected", async () => {
	await withTempDir(async (directory) => {
		const state = savedState(directory, {
			implementationModel: { provider: "selected", id: "implementation-model" },
			implementationThinkingLevel: "high",
		});
		await saveState(directory, state);
		const implementationModel = fakeModel("selected", "implementation-model");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Resume"],
			models: [implementationModel],
			setModelOutcomes: [false],
		});

		await runtime.run("implement-tasks", "missing.md");

		assert.deepEqual(runtime.sent, []);
		assert.ok(runtime.notifications.some(({ message, type }) =>
			type === "error" && message.includes("Cannot use implementation model") && message.includes("model selection failed"),
		));
		assert.equal((await loadState(directory))?.status, "failed");
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
		assert.deepEqual(runtime.selections[1].choices, [COMPACTION_ENABLED_CHOICE, "No"]);
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

for (const command of ["implement-tasks", "implement-plan"]) {
	for (const unavailable of [false, true]) {
		test(`${command} reports Git detection ${unavailable ? "exceptions" : "failures"} before preparation`, async () => {
			await withTempDir(async (directory) => {
				const detail = unavailable ? "git not found" : `fatal: detected dubious ownership in repository at '${directory}'`;
				const runtime = fakeRuntime({
					cwd: directory,
					gitUnavailable: unavailable,
					gitResults: [gitResult("", 128, detail)],
				});

				await runtime.run(command, "tasks.md");

				assert.deepEqual(runtime.selections, []);
				assert.equal(runtime.ignoreStatePrompts.length, 0);
				assert.equal(runtime.completeCalls.length, 0);
				assert.deepEqual(runtime.sent, []);
				assert.equal(runtime.execCalls.length, 1);
				assert.ok(runtime.notifications.some(({ message, type }) =>
					type === "error" && message.includes("Git repository check failed") && message.includes(detail),
				));
				await assert.rejects(readFile(join(directory, ".gitignore"), "utf8"), /ENOENT/);
				assert.equal(await loadState(directory), undefined);
			});
		});
	}
}

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
			"Git checkpoints: new or current local branch",
			"Cancel",
		]);
		assert.equal(runtime.execCalls.length, 1);
		assert.equal(runtime.sent.length, 1);
		assert.match(runtime.sent[0], /Do not perform remote Git operations/);
		assert.match(runtime.sent[0], /Do not create commits/);
	});
});

test("repository confirmation still allows navigating down to Cancel", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "one task");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Cancel"],
			gitResults: [gitResult("true\n")],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.equal(runtime.sent.length, 0);
		assert.equal(runtime.execCalls.length, 1);
		assert.equal(await loadState(directory), undefined);
	});
});

for (const branchInput of ["feature/checkpoints", ""]) {
	for (const status of ["M  staged.ts\n", " M unstaged.ts\n", "?? untracked.ts\n"]) {
		test(`dirty ${JSON.stringify(status.trim())} state is captured on ${branchInput || "the current branch"} before implementation`, async () => {
			await withTempDir(async (directory) => {
				await writeFile(join(directory, "tasks.md"), "one task");
				const runtime = fakeRuntime({
					cwd: directory,
					choices: ["Git checkpoints: new or current local branch"],
					inputs: [branchInput],
					confirmations: [true],
					gitResults: [
						gitResult("true\n"), gitResult(status), gitResult("main\n"), gitResult("staged-tree\n"),
						gitResult(), gitResult(), gitResult(), gitResult(), gitResult("", 1), gitResult(),
					],
					manualTurns: true,
				});

				const execution = runtime.run("implement-tasks", "tasks.md");
				await waitFor(() => runtime.sent.length === 1);
				assert.deepEqual(runtime.execCalls.map(({ args }) => args), [
					["rev-parse", "--is-inside-work-tree"],
					["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"],
					branchInput ? ["switch", "-c", branchInput] : ["branch", "--show-current"],
					["write-tree"],
					["add", "-A"],
					["commit", "-m", "chore: capture initial implementation state"],
				]);
				assert.equal((await loadState(directory))?.branchName, branchInput || "main");
				await runtime.settleTurn();
				await execution;
				assert.deepEqual(runtime.execCalls.filter(({ args }) => args[0] === "commit").map(({ args }) => args), [
					["commit", "-m", "chore: capture initial implementation state"],
					["commit", "-m", "Task 1: One"],
				]);
				assertNoRemoteGit(runtime.execCalls);
			});
		});
	}
}

test("Enter defaults to checkpoint mode, creating a local branch and committing only successful tasks with changes", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			inputs: ["  feature/local-checkpoints  "],
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
			["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"],
			["switch", "-c", "feature/local-checkpoints"],
			["add", "-A"],
			UNSTAGE_STATE,
			["diff", "--cached", "--quiet"],
			["commit", "-m", "Task 1: One"],
			["add", "-A"],
			UNSTAGE_STATE,
			["diff", "--cached", "--quiet"],
		]);
		assert.equal(runtime.sent.length, 2);
		assert.equal(runtime.execCalls.filter(({ args }) => args[0] === "commit").length, 1);
		assert.deepEqual(runtime.selections[0].choices, [
			"Implement only", "Git checkpoints: new or current local branch", "Cancel",
		]);
		assert.equal(runtime.inputPrompts.find(({ title }) => title.startsWith("New local branch name"))?.placeholder, "feature/task-checkpoints");
		assert.equal(runtime.confirmationPrompts.length, 0);
		assertNoRemoteGit(runtime.execCalls);
	});
});

for (const input of ["", "   "]) {
	test(`checkpoint mode confirms and saves the current branch for ${JSON.stringify(input)} input`, async () => {
		await withTempDir(async (directory) => {
			await writeFile(join(directory, "tasks.md"), "tasks");
			const runtime = fakeRuntime({
				cwd: directory,
				choices: ["Git checkpoints: new or current local branch"],
				inputs: [input],
				confirmations: [true],
				gitResults: [gitResult("true\n"), gitResult(), gitResult("main\n")],
				manualTurns: true,
			});

			const execution = runtime.run("implement-tasks", "tasks.md");
			await waitFor(() => runtime.sent.length === 1);
			assert.equal(runtime.confirmationPrompts.length, 1);
			assert.match(runtime.confirmationPrompts[0].message, /commit changes directly to the current local branch/);
			assert.equal(runtime.inputPrompts.find(({ title }) => title.startsWith("New local branch name"))?.placeholder, "feature/task-checkpoints");
			assert.deepEqual(runtime.execCalls.map(({ args }) => args), [
				["rev-parse", "--is-inside-work-tree"],
				["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"],
				["branch", "--show-current"],
			]);
			assert.equal((await loadState(directory))?.branchName, "main");
			assert.equal((await loadState(directory))?.checkpoint, true);
			await runtime.settleTurn("error");
			await execution;

			const resumed = fakeRuntime({ cwd: directory, choices: ["Resume"], gitResults: [gitResult("main\n")] });
			await resumed.run("implement-tasks", "missing.md");
			assert.deepEqual(resumed.execCalls[0].args, ["branch", "--show-current"]);
			assert.equal(resumed.sent.length, 1);
			assert.equal(await loadState(directory), undefined);
			assertNoRemoteGit(resumed.execCalls);
		});
	});
}

for (const scenario of [
	{ name: "dismissed branch input", input: undefined, confirmed: true, result: gitResult(), action: undefined, error: undefined },
	{ name: "declined current branch", input: "", confirmed: false, result: gitResult(), action: undefined, error: undefined },
	{ name: "detached HEAD", input: "", confirmed: true, result: gitResult(), action: "branch", error: /detached HEAD/ },
	{ name: "branch lookup failure", input: "", confirmed: true, result: gitResult("", 128, "lookup failed"), action: "branch", error: /Git branch check failed/ },
	{ name: "branch creation failure", input: "feature/existing", confirmed: false, result: gitResult("", 128, "branch already exists"), action: "switch", error: /Git branch creation failed/ },
]) {
	test(`checkpoint setup stops safely on ${scenario.name}`, async () => {
		await withTempDir(async (directory) => {
			await writeFile(join(directory, "tasks.md"), "tasks");
			const runtime = fakeRuntime({
				cwd: directory,
				choices: ["Git checkpoints: new or current local branch"],
				inputs: scenario.input === undefined ? [] : [scenario.input],
				confirmations: [scenario.confirmed],
				gitResults: [gitResult("true\n"), gitResult(" M existing.txt\n"), scenario.result],
			});

			await runtime.run("implement-tasks", "tasks.md");

			assert.deepEqual(runtime.sent, []);
			if (scenario.action === "switch") assert.equal((await loadState(directory))?.phase, "setup");
			else assert.equal(await loadState(directory), undefined);
			await assert.rejects(readFile(join(directory, ".gitignore")), /ENOENT/);
			assert.equal(runtime.confirmationPrompts.length, scenario.input === "" ? 1 : 0);
			assert.equal(runtime.execCalls[2]?.args[0], scenario.action);
			assert.equal(runtime.execCalls.length, scenario.action ? 3 : 2);
			assert.ok(runtime.notifications.some(({ message, type }) => scenario.error
				? type === "error" && scenario.error.test(message)
				: type === "info" && message.includes("cancelled")));
		});
	});
}

for (const [action, results, restoresIndex] of [
	["initial index snapshot", [gitResult("", 1, "unmerged entries")], false],
	["initial checkpoint staging", [gitResult("saved-tree\n"), gitResult("", 1, "index locked")], true],
	["initial checkpoint commit", [gitResult("saved-tree\n"), gitResult(), gitResult("", 1, "commit hook rejected")], true],
] as const) {
	test(`${action} failure stops before implementation and preserves existing work`, async () => {
		await withTempDir(async (directory) => {
			await writeFile(join(directory, "tasks.md"), "one task");
			await writeFile(join(directory, "existing.txt"), "existing work\n");
			const runtime = fakeRuntime({
				cwd: directory,
				choices: ["Git checkpoints: new or current local branch"],
				inputs: ["feature/checkpoints"],
				gitResults: [gitResult("true\n"), gitResult(" M existing.txt\n"), gitResult(), ...results],
			});

			await runtime.run("implement-tasks", "tasks.md");

			assert.deepEqual(runtime.sent, []);
			assert.equal((await loadState(directory))?.phase, "setup");
			assert.equal((await loadState(directory))?.pendingCheckpoint?.purpose, "initial");
			assert.equal(await readFile(join(directory, "existing.txt"), "utf8"), "existing work\n");
			assert.equal(runtime.execCalls.some(({ args }) => args[0] === "read-tree"), restoresIndex);
			if (restoresIndex) assert.deepEqual(runtime.execCalls.at(-1)?.args, ["read-tree", "saved-tree"]);
			assert.ok(runtime.notifications.some(({ message, type }) => type === "error"
				&& message.includes(`Git ${action} failed`) && message.includes(results.at(-1)!.stderr)));
		});
	});
}

test("task completion and pending checkpoint are persisted before staging", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		let finishStaging!: (result: GitResult) => void;
		const staging = new Promise<GitResult>((resolve) => { finishStaging = resolve; });
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Git checkpoints: new or current local branch"],
			inputs: ["feature/checkpoints"],
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
			gitResults: [gitResult("true\n"), gitResult(), gitResult(), staging],
			manualTurns: true,
		});

		const execution = runtime.run("implement-tasks", "tasks.md");
		await waitFor(() => runtime.sent.length === 1);
		await runtime.settleTurn();
		await waitFor(() => runtime.execCalls.some(({ args }) => args[0] === "add"));
		const pending = await loadState(directory);
		assert.equal(pending?.nextTaskIndex, 1);
		assert.equal(pending?.pendingCheckpoint?.purpose, "task");
		assert.equal(pending?.status, "running");
		assert.equal(runtime.sent.length, 1);

		finishStaging(gitResult());
		await waitFor(() => runtime.sent.length === 2);
		assert.equal((await loadState(directory))?.pendingCheckpoint, undefined);
		await runtime.settleTurn();
		await execution;
		assert.equal(await loadState(directory), undefined);
	});
});

for (const [action, results] of [
	["staging", [gitResult("", 1, "staging failed")]],
	["state-file unstaging", [gitResult(), gitResult("", 1, "unstaging failed")]],
	["change check", [gitResult(), gitResult(), gitResult("", 128, "diff failed")]],
] as const) {
	test(`Git ${action} failure preserves completed progress and a pending checkpoint`, async () => {
		await withTempDir(async (directory) => {
			await writeFile(join(directory, "tasks.md"), "tasks");
			const runtime = fakeRuntime({
				cwd: directory,
				choices: ["Git checkpoints: new or current local branch", COMPACTION_ENABLED_CHOICE],
				inputs: ["feature/checkpoints"],
				modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
				gitResults: [gitResult("true\n"), gitResult(), gitResult(), ...results],
			});

			await runtime.run("implement-tasks", "tasks.md");

			const saved = await loadState(directory);
			assert.equal(saved?.nextTaskIndex, 1);
			assert.equal(saved?.pendingCheckpoint?.purpose, "task");
			assert.equal(saved?.status, "failed");
			assert.ok(saved?.error?.includes(`Git ${action} failed`));
			assert.equal(runtime.sent.length, 1);
			assert.equal(runtime.compactCalls.length, 0);
			assert.equal(runtime.contextUsageCalls, 0);
		});
	});
}

test("Git checkpoint failure stops before the next task", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Git checkpoints: new or current local branch"],
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
		assert.equal(saved?.nextTaskIndex, 1);
		assert.equal(saved?.pendingCheckpoint?.purpose, "task");
		assert.match(saved?.error ?? "", /Git commit failed/);
		assertNoRemoteGit(runtime.execCalls);

		const failedRecovery = fakeRuntime({
			cwd: directory,
			choices: ["Resume"],
			gitResults: [gitResult("feature/checkpoint-failure\n"), gitResult(), gitResult(), gitResult("", 1), gitResult("", 1, "hook still failing")],
		});
		await failedRecovery.run("implement-tasks", "missing.md");
		assert.deepEqual(failedRecovery.sent, []);
		assert.equal(failedRecovery.completeCalls.length, 0);
		assert.equal((await loadState(directory))?.pendingCheckpoint?.purpose, "task");
		assert.equal((await loadState(directory))?.nextTaskIndex, 1);
		assert.equal((await loadState(directory))?.status, "failed");

		let finishCommit!: (result: GitResult) => void;
		const commit = new Promise<GitResult>((resolve) => { finishCommit = resolve; });
		const resumed = fakeRuntime({
			cwd: directory,
			choices: ["Resume"],
			gitResults: [gitResult("feature/checkpoint-failure\n"), gitResult(), gitResult(), gitResult("", 1), commit],
			manualTurns: true,
		});
		const recovery = resumed.run("implement-plan", "missing.md");
		await waitFor(() => resumed.execCalls.some(({ args }) => args[0] === "commit"));
		assert.deepEqual(resumed.sent, []);
		assert.equal(resumed.completeCalls.length, 0);
		assert.match(resumed.selections[0].title, /Pending Git checkpoint: yes/);
		assert.equal((await loadState(directory))?.pendingCheckpoint?.purpose, "task");
		assert.deepEqual(resumed.execCalls.map(({ args }) => args), [
			["branch", "--show-current"],
			["add", "-A"],
			UNSTAGE_STATE,
			["diff", "--cached", "--quiet"],
			["commit", "-m", "Task 1: One"],
		]);

		finishCommit(gitResult());
		await waitFor(() => resumed.sent.length === 1);
		assert.deepEqual(resumed.sent, [saved?.tasks[1].prompt]);
		const recovered = await loadState(directory);
		assert.equal(recovered?.pendingCheckpoint, undefined);
		assert.equal(recovered?.nextTaskIndex, 1);
		assert.equal(recovered?.status, "running");
		assert.equal(recovered?.error, undefined);
		await resumed.settleTurn();
		await recovery;
		assert.equal(await loadState(directory), undefined);
		assertNoRemoteGit(resumed.execCalls);
	});
});

for (const nextTaskIndex of [2, 3]) {
	test(`Resume recovers an already committed checkpoint at task index ${nextTaskIndex}`, async () => {
		await withTempDir(async (directory) => {
			const state = savedState(directory, {
				checkpoint: true,
				branchName: "feature/saved",
				pendingCheckpoint: true,
				nextTaskIndex,
			});
			await saveState(directory, state);
			const runtime = fakeRuntime({
				cwd: directory,
				choices: ["Resume"],
				gitResults: [gitResult("feature/saved\n"), gitResult(), gitResult(), gitResult()],
			});

			await runtime.run("implement-tasks", "missing.md");

			assert.deepEqual(runtime.sent, state.tasks.slice(nextTaskIndex).map(({ prompt }) => prompt));
			assert.equal(runtime.completeCalls.length, 0);
			assert.deepEqual(runtime.execCalls.slice(0, 4).map(({ args }) => args), [
				["branch", "--show-current"],
				["add", "-A"],
				UNSTAGE_STATE,
				["diff", "--cached", "--quiet"],
			]);
			assert.equal(runtime.execCalls.some(({ args }) => args[0] === "commit"), false);
			assert.equal(await loadState(directory), undefined);
		});
	});
}

for (const pendingCompaction of [undefined, true]) {
	test(`checkpoint recovery precedes ${pendingCompaction ? "pending" : "threshold-triggered"} compaction`, async () => {
		await withTempDir(async (directory) => {
			const state = savedState(directory, {
				checkpoint: true,
				branchName: "feature/saved",
				pendingCheckpoint: true,
				automaticCompaction: true,
				pendingCompaction,
				nextTaskIndex: 2,
			});
			state.tasks[1].title = "Two\n  with spacing";
			state.pendingCheckpoint!.message = "Task 2: Two with spacing";
			await saveState(directory, state);
			const failed = fakeRuntime({
				cwd: directory,
				choices: ["Resume"],
				gitResults: [gitResult("feature/saved\n"), gitResult("", 1, "staging failed")],
			});
			await failed.run("implement-tasks", "missing.md");
			assert.deepEqual(failed.sent, []);
			assert.equal(failed.compactCalls.length, 0);
			assert.equal(failed.contextUsageCalls, 0);
			assert.equal((await loadState(directory))?.pendingCheckpoint?.purpose, "task");
			assert.equal((await loadState(directory))?.pendingCompaction, pendingCompaction);

			const runtime = fakeRuntime({
				cwd: directory,
				choices: ["Resume"],
				gitResults: [gitResult("feature/saved\n"), gitResult(), gitResult(), gitResult("", 1), gitResult()],
				contextUsages: [{ tokens: 80, contextWindow: 100, percent: 80 }],
				compactionOutcomes: ["manual"],
			});
			const execution = runtime.run("implement-tasks", "missing.md");
			await waitFor(() => runtime.compactCalls.length === 1);
			assert.deepEqual(runtime.sent, []);
			assert.deepEqual(runtime.execCalls.at(-1)?.args, ["commit", "-m", "Task 2: Two with spacing"]);
			assert.equal(runtime.contextUsageCalls, pendingCompaction ? 0 : 1);
			assert.equal((await loadState(directory))?.pendingCheckpoint, undefined);
			assert.equal((await loadState(directory))?.pendingCompaction, true);

			runtime.compactCalls[0].onError?.(new Error("compaction failed"));
			await execution;
			assert.equal((await loadState(directory))?.pendingCheckpoint, undefined);
			assert.equal((await loadState(directory))?.pendingCompaction, true);
			assert.equal((await loadState(directory))?.nextTaskIndex, 2);
			assert.equal((await loadState(directory))?.status, "failed");

			const resumed = fakeRuntime({
				cwd: directory,
				choices: ["Resume"],
				gitResults: [gitResult("feature/saved\n")],
				compactionOutcomes: ["manual"],
			});
			const recovery = resumed.run("implement-tasks", "missing.md");
			await waitFor(() => resumed.compactCalls.length === 1);
			assert.deepEqual(resumed.execCalls.map(({ args }) => args), [["branch", "--show-current"]]);
			assert.deepEqual(resumed.sent, []);
			assert.equal(resumed.contextUsageCalls, 0);
			resumed.compactCalls[0].onComplete?.({});
			await recovery;
			assert.deepEqual(resumed.sent, [state.tasks[2].prompt]);
			assert.equal(await loadState(directory), undefined);
		});
	});
}

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

test("automatic compaction defaults to Yes and waits above 70% before starting the next task", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement"],
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
			contextUsages: [{ tokens: 74, contextWindow: 100, percent: 74 }],
			compactionOutcomes: ["manual"],
		});

		const execution = runtime.run("implement-tasks", "tasks.md");
		await waitFor(() => runtime.compactCalls.length === 1);

		assert.equal(runtime.sent.length, 1);
		assert.equal(runtime.compactCalls.length, 1);
		assert.deepEqual(
			runtime.selections.find(({ title }) => title === "Automatic compaction between tasks?")?.choices,
			["Yes", "No"],
		);
		assert.equal((await loadState(directory))?.compactionThresholdPercent, 70);
		assert.ok(runtime.inputPrompts.some(({ title, placeholder }) =>
			title === "Compaction threshold percentage (default: 70%)" && placeholder === "70",
		));
		assert.deepEqual(runtime.widgets.at(-1), ["Task-file implementation", "○ 2/2 Two"]);
		assert.equal(runtime.workingMessages.at(-1), "Compact context before task 2 (74%)");

		runtime.compactCalls[0].onComplete?.({});
		await execution;
		assert.equal(runtime.sent.length, 2);
		assert.equal(runtime.workingMessages.at(-1), undefined);
	});
});

test("a custom compaction threshold is persisted and used", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", COMPACTION_ENABLED_CHOICE],
			thresholdInputs: ["85"],
			modelOutputs: [{ tasks: [{ title: "One" }, { title: "Two" }] }],
			contextUsages: [{ tokens: 80, contextWindow: 100, percent: 80 }],
			manualTurns: true,
		});

		const execution = runtime.run("implement-tasks", "tasks.md");
		await waitFor(() => runtime.sent.length === 1);
		assert.equal((await loadState(directory))?.compactionThresholdPercent, 85);
		await runtime.settleTurn();
		await waitFor(() => runtime.sent.length === 2);
		assert.equal(runtime.contextUsageCalls, 1);
		assert.equal(runtime.compactCalls.length, 0);
		await runtime.settleTurn();
		await execution;
	});
});

test("invalid compaction threshold input stops before model selection or task execution", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "tasks");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", COMPACTION_ENABLED_CHOICE],
			thresholdInputs: ["70.5"],
		});

		await runtime.run("implement-tasks", "tasks.md");

		assert.deepEqual(runtime.sent, []);
		assert.equal(runtime.selections.some(({ title }) => title.startsWith("Implementation model")), false);
		assert.ok(runtime.notifications.some(({ message, type }) =>
			type === "error" && message === "Compaction threshold must be an integer from 1 to 100 percent.",
		));
		assert.equal(await loadState(directory), undefined);
	});
});

test("compaction-disabled workflows do not ask for a threshold", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "tasks.md"), "one task");
		const runtime = fakeRuntime({ cwd: directory, choices: ["Implement", "No"] });

		await runtime.run("implement-tasks", "tasks.md");

		assert.equal(runtime.inputPrompts.some(({ title }) => title.startsWith("Compaction threshold")), false);
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
		assert.deepEqual(runtime.widgets.at(-1), ["Task-file implementation", "○ 2/2 Two"]);
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

test("Resume uses the persisted compaction threshold for later checks", async () => {
	await withTempDir(async (directory) => {
		await saveState(directory, savedState(directory, {
			automaticCompaction: true,
			compactionThresholdPercent: 40,
			nextTaskIndex: 1,
		}));
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Resume"],
			contextUsages: [{ tokens: 50, contextWindow: 100, percent: 50 }],
			compactionOutcomes: ["manual"],
			manualTurns: true,
		});

		const execution = runtime.run("implement-tasks", "missing.md");
		await waitFor(() => runtime.sent.length === 1);
		await runtime.settleTurn();
		await waitFor(() => runtime.compactCalls.length === 1);

		assert.equal(runtime.contextUsageCalls, 1);
		assert.equal((await loadState(directory))?.compactionThresholdPercent, 40);
		runtime.compactCalls[0].onComplete?.({});
		await waitFor(() => runtime.sent.length === 2);
		await runtime.settleTurn();
		await execution;
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

test("/implement-plan prepares tasks with current settings and uses the selected pair for implementation", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, "plan.md"), "Build it.");
		const currentModel = fakeModel("current", "planning-model");
		const implementationModel = fakeModel("selected", "implementation-model");
		const runtime = fakeRuntime({
			cwd: directory,
			choices: ["Implement", "No", "selected/implementation-model", "high"],
			currentModel,
			models: [currentModel, implementationModel],
			thinkingLevel: "low",
			modelOutputs: ["## Task 1 - Build\n\nBuild it.\n", { tasks: [{ title: "Build" }] }],
		});

		await runtime.run("implement-plan", "plan.md");

		assert.deepEqual(runtime.completeSettings, [
			{ model: "current/planning-model", thinkingLevel: "low" },
			{ model: "current/planning-model", thinkingLevel: "low" },
		]);
		assert.deepEqual(runtime.sentSettings, [
			{ model: "selected/implementation-model", thinkingLevel: "high" },
		]);
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
			"Git checkpoints: new or current local branch",
			"Cancel",
		]);
		assert.deepEqual(runtime.execCalls[0].args, ["rev-parse", "--is-inside-work-tree"]);
		assert.equal(runtime.sent.length, 2);
		assert.match(runtime.sent[0], /^Read "tasks\.md" and implement task #1/);
		assert.match(runtime.sent[1], /^Read "tasks\.md" and implement task #2/);
		assert.ok(runtime.sent.every((prompt) => !prompt.includes("Build it.")));
	});
});

for (const dirty of [false, true]) {
	test(`option preparation is read-only for a ${dirty ? "dirty" : "clean"} Git worktree`, async () => {
		await withTempDir(async (directory) => {
			const runtime = fakeRuntime({
				cwd: directory,
				choices: ["Git checkpoints: new or current local branch"],
				inputs: ["feature/prepared"],
			});
			const mutations: string[] = [];
			const git = {
				isRepository: async () => true,
				isWorkingTreeClean: async () => !dirty,
				preflightSnapshot: async () => "main",
				currentBranch: async () => "main",
				head: async () => "baseline",
				checkpointCommitted: async () => false,
				createBranch: async () => { mutations.push("branch"); },
				commitInitialChanges: async () => { mutations.push("initial commit"); },
				commitChanges: async () => false,
			};
			const options = await selectExecutionOptions("Prepare", { tasks: [{ title: "One" }] }, true,
				runtime.ctx as never, git, runtime.pi as never);
			assert.ok(options);
			assert.equal(options.branchName, "feature/prepared");
			assert.equal(options.initiallyDirty, dirty);
			assert.deepEqual(mutations, []);
			assert.equal(await loadState(directory), undefined);
			await assert.rejects(readFile(join(directory, ".gitignore")), { code: "ENOENT" });
			await startExecutionSetup(directory, git, savedState(directory, {
				...options, phase: "setup", nextTaskIndex: 0,
				setup: { step: "branch", createBranch: true, initialCheckpoint: dirty, baseBranch: "main", expectedHead: "baseline" },
			}));
			assert.deepEqual(mutations, dirty ? ["branch", "initial commit"] : ["branch"]);
		});
	});
}

for (const existing of [false, true]) {
	test(`/implement-plan defers tasks.md writes through indexing and cancellation (existing: ${existing})`, async () => {
		await withTempDir(async (directory) => {
			await writeFile(join(directory, "plan.md"), "Plan");
			if (existing) await writeFile(join(directory, "tasks.md"), "Original tasks\n");
			await writeFile(join(directory, ".gitignore"), "original-ignore\n");
			const before = await snapshotGeneratedTasks(directory);
			const runtime = fakeRuntime({
				cwd: directory,
				choices: existing ? ["Overwrite", "Cancel"] : ["Cancel"],
				modelOutputs: ["## Task 1 - Generated\n", { tasks: [{ title: "Generated" }] }],
			});
			await runtime.run("implement-plan", "plan.md");
			assert.equal(runtime.completeCalls.length, 2);
			assert.equal(await snapshotGeneratedTasks(directory), before);
			assert.equal(await readFile(join(directory, ".gitignore"), "utf8"), "original-ignore\n");
			assert.equal(await loadState(directory), undefined);
			assert.deepEqual(runtime.sent, []);
		});
	});
}

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
