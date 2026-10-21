import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { completeCheckpoint } from "../src/checkpoint.ts";
import { snapshotFile } from "../src/files.ts";
import { createLocalGit } from "../src/git.ts";
import { startExecutionSetup } from "../src/setup.ts";
import { INITIAL_CHECKPOINT_MESSAGE, STATE_FILE_NAME, loadState, saveState, validateState, type ImplementationState, type ReviewResult } from "../src/state.ts";

function executeGit(cwd: string, args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1, killed: result.signal !== null };
}
function runGit(cwd: string, args: string[]): string {
	const result = executeGit(cwd, args);
	assert.equal(result.code, 0, result.stderr);
	return result.stdout;
}
function taskState(cwd: string): ImplementationState {
	return {
		version: 2, phase: "tasks", review: { enabled: false }, cwd, sourcePath: "tasks.md", originalPlanPath: null,
		tasks: [{ title: "One", prompt: "Read tasks.md and implement task 1." }],
		nextTaskIndex: 0, status: "running", checkpoint: true, branchName: "feature/implementation",
		automaticCompaction: true, compactionThresholdPercent: 70,
		implementationModel: { provider: "test", id: "selected" }, implementationThinkingLevel: "medium",
	};
}
async function withRepository(run: (cwd: string, state: ImplementationState) => Promise<void>) {
	const cwd = await mkdtemp(join(process.cwd(), ".recovery-test-"));
	try {
		runGit(cwd, ["init", "-q", "-b", "main"]);
		runGit(cwd, ["config", "user.name", "Pi Implement Test"]);
		runGit(cwd, ["config", "user.email", "pi-implement@example.invalid"]);
		await writeFile(join(cwd, "tracked.txt"), "Baseline\n");
		runGit(cwd, ["add", "-A"]);
		runGit(cwd, ["commit", "-q", "-m", "Baseline"]);
		await writeFile(join(cwd, "tracked.txt"), "Initial dirty work\n");
		await writeFile(join(cwd, "tasks.md"), "Original tasks\n");
		const state: ImplementationState = {
			...taskState(cwd), phase: "setup",
			setup: {
				step: "branch", createBranch: true, initialCheckpoint: true, baseBranch: "main",
				expectedHead: runGit(cwd, ["rev-parse", "HEAD"]).trim(),
				gitignore: { before: null, content: `${STATE_FILE_NAME}\n` },
			},
			preparedTasks: { markdown: "## Task 1 - Generated\n", destination: await snapshotFile(join(cwd, "tasks.md")), overwriteApproved: true },
		};
		await saveState(cwd, state);
		await run(cwd, state);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

for (const after of ["switch", "commit"]) {
	test(`setup recovers a completed ${after} interrupted before its progress save`, async () => {
		await withRepository(async (cwd, state) => {
			const mutations: string[] = [];
			let interrupted = false;
			const exec = async (_command: string, args: string[]) => {
				if (["switch", "commit"].includes(args[0])) {
					assert.equal((await loadState(cwd))?.phase, "setup");
					mutations.push(args[0]);
				}
				const result = executeGit(cwd, args);
				if (args[0] === after && !interrupted) {
					interrupted = true;
					assert.equal(result.code, 0, result.stderr);
					throw new Error("Simulated interruption after Git completed");
				}
				return result;
			};
			await assert.rejects(startExecutionSetup(cwd, createLocalGit(exec), state), /Simulated interruption/);
			const saved = (await loadState(cwd))!;
			assert.equal(saved.phase, "setup");
			assert.equal(saved.setup?.step, after === "switch" ? "branch" : "initial_checkpoint");
			assert.equal(saved.preparedTasks?.markdown, "## Task 1 - Generated\n");
			if (after === "commit") {
				assert.equal(saved.pendingCheckpoint?.purpose, "initial");
				// Changes made after the finished commit must not become a duplicate initial checkpoint.
				await writeFile(join(cwd, "external.txt"), "External work\n");
			}
			await startExecutionSetup(cwd, createLocalGit(exec), saved);
			assert.equal((await loadState(cwd))?.phase, "tasks");
			assert.equal((await loadState(cwd))?.pendingCheckpoint, undefined);
			assert.deepEqual(mutations, ["switch", "commit"]);
			assert.equal(runGit(cwd, ["branch", "--show-current"]).trim(), "feature/implementation");
			assert.equal(runGit(cwd, ["log", "-1", "--format=%s"]).trim(), INITIAL_CHECKPOINT_MESSAGE);
			assert.equal(runGit(cwd, ["rev-list", "--count", "HEAD"]).trim(), "2");
			assert.equal(await readFile(join(cwd, "tasks.md"), "utf8"), "## Task 1 - Generated\n");
			assert.equal(await readFile(join(cwd, ".gitignore"), "utf8"), `${STATE_FILE_NAME}\n`);
			assert.ok(!runGit(cwd, ["ls-tree", "-r", "--name-only", "HEAD"]).includes(STATE_FILE_NAME));
			if (after === "commit") assert.equal(executeGit(cwd, ["cat-file", "-e", "HEAD:external.txt"]).code, 128);
		});
	});
}

for (const step of ["gitignore", "tasks_file"] as const) {
	test(`setup recognizes an already-written ${step} after interruption`, async () => {
		await withRepository(async (cwd, state) => {
			state.branchName = "main";
			state.setup = { ...state.setup!, step, createBranch: false, initialCheckpoint: false };
			await writeFile(join(cwd, ".gitignore"), state.setup.gitignore!.content);
			if (step === "tasks_file") await writeFile(join(cwd, "tasks.md"), state.preparedTasks!.markdown);
			await saveState(cwd, state);
			const ignoreBefore = await snapshotFile(join(cwd, ".gitignore"));
			const tasksBefore = await snapshotFile(join(cwd, "tasks.md"));
			await startExecutionSetup(cwd, createLocalGit(async (_command, args) => executeGit(cwd, args)), (await loadState(cwd))!);
			assert.equal(await snapshotFile(join(cwd, ".gitignore")), ignoreBefore);
			if (step === "tasks_file") assert.equal(await snapshotFile(join(cwd, "tasks.md")), tasksBefore);
			assert.equal((await loadState(cwd))?.phase, "tasks");
		});
	});
}

test("setup rejects externally changed targets and unexpected branches without overwriting them", async () => {
	await withRepository(async (cwd, state) => {
		state.setup!.step = "tasks_file";
		state.setup!.createBranch = false;
		state.setup!.initialCheckpoint = false;
		state.branchName = "main";
		await saveState(cwd, state);
		await writeFile(join(cwd, "tasks.md"), "External tasks\n");
		const git = createLocalGit(async (_command, args) => executeGit(cwd, args));
		await assert.rejects(startExecutionSetup(cwd, git, state), /changed during preparation/);
		assert.equal(await readFile(join(cwd, "tasks.md"), "utf8"), "External tasks\n");
		runGit(cwd, ["switch", "-q", "-c", "unexpected"]);
		await assert.rejects(startExecutionSetup(cwd, git, state), /expected local branch main/);
		assert.equal((await loadState(cwd))?.phase, "setup");
	});
});

test("pending checkpoint uses its saved message and does not repeat a finished commit", async () => {
	await withRepository(async (cwd, state) => {
		state.phase = "tasks";
		delete state.setup;
		state.branchName = "main";
		state.nextTaskIndex = 1;
		state.pendingCheckpoint = { purpose: "task", message: "A saved checkpoint message", headBefore: runGit(cwd, ["rev-parse", "HEAD"]).trim() };
		await saveState(cwd, state);
		const git = createLocalGit(async (_command, args) => executeGit(cwd, args));
		await git.commitChanges(cwd, state.pendingCheckpoint.message);
		await writeFile(join(cwd, "later.txt"), "Later work\n");
		await completeCheckpoint(cwd, git, (await loadState(cwd))!);
		assert.equal(runGit(cwd, ["rev-list", "--count", "HEAD"]).trim(), "2");
		assert.equal(runGit(cwd, ["log", "-1", "--format=%s"]).trim(), "A saved checkpoint message");
		assert.equal((await loadState(cwd))?.pendingCheckpoint, undefined);
		assert.equal(await readFile(join(cwd, "later.txt"), "utf8"), "Later work\n");
	});
});

test("checkpoint recovery refuses unrelated HEAD changes", async () => {
	await withRepository(async (cwd, state) => {
		state.phase = "tasks";
		delete state.setup;
		state.branchName = "main";
		state.nextTaskIndex = 1;
		state.pendingCheckpoint = { purpose: "task", message: "Expected message", headBefore: runGit(cwd, ["rev-parse", "HEAD"]).trim() };
		await saveState(cwd, state);
		const git = createLocalGit(async (_command, args) => executeGit(cwd, args));
		await git.commitChanges(cwd, "External commit");
		await assert.rejects(completeCheckpoint(cwd, git, state), /HEAD changed unexpectedly/);
		assert.equal((await loadState(cwd))?.pendingCheckpoint?.message, "Expected message");
	});
});

test("version-1 state migrates without writing and preserves pending work", async () => {
	const cwd = await mkdtemp(join(process.cwd(), ".migration-test-"));
	try {
		await mkdir(join(cwd, ".git"));
		const { phase: _phase, review: _review, ...common } = taskState(cwd);
		const legacy = { ...common, version: 1, nextTaskIndex: 1, pendingCheckpoint: true, status: "failed", error: "Interrupted checkpoint" };
		const raw = JSON.stringify(legacy);
		await writeFile(join(cwd, STATE_FILE_NAME), raw);
		const migrated = (await loadState(cwd))!;
		assert.equal(migrated.version, 2);
		assert.equal(migrated.phase, "tasks");
		assert.deepEqual(migrated.review, { enabled: false });
		assert.deepEqual(migrated.tasks, legacy.tasks);
		assert.deepEqual(migrated.pendingCheckpoint, { purpose: "task", message: "Task 1: One" });
		assert.equal(migrated.status, "failed");
		assert.equal(await readFile(join(cwd, STATE_FILE_NAME), "utf8"), raw);
		assert.equal(validateState({ ...legacy, pendingCheckpoint: false }).phase, "completed");
		const pendingCompaction = validateState({ ...legacy, tasks: [...legacy.tasks, { title: "Two", prompt: "Implement two" }], pendingCompaction: true });
		assert.equal(pendingCompaction.pendingCompaction, true);
		assert.equal(pendingCompaction.nextTaskIndex, 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

const reviewResult: ReviewResult = {
	outcome: "passed", reviewedAreas: ["plan_compliance", "tests", "documentation"],
	checks: [
		{ area: "plan_compliance", check: "Inspect source", passed: true, evidence: "Compared plan.md and tasks.md against implementation files." },
		{ area: "tests", check: "npm test", passed: true, evidence: "Test output showed all tests passing." },
		{ area: "documentation", check: "Inspect README", passed: true, evidence: "Read README.md and compared the documented API with implementation." },
	],
	minorFixes: [], findings: [], unavailableChecks: [], remediationGenerated: false,
};

test("version-2 schema encodes review, review checkpoint, and completion explicitly", () => {
	const state = { ...taskState("/project"), nextTaskIndex: 1, review: { enabled: true as const, model: { provider: "review", id: "independent" }, thinkingLevel: "high" as const } };
	for (const phase of ["review", "review_checkpoint", "completed"] as const) {
		const candidate = { ...state, phase, reviewResult, originalPlanPath: "plan.md", ...(phase === "review_checkpoint" ? { pendingCheckpoint: { purpose: "review", message: "Saved review checkpoint" } } : {}) };
		assert.deepEqual(validateState(candidate), candidate);
	}
});

test("review result metadata is validated before it can be restored", () => {
	const state = {
		...taskState("/project"), phase: "review", nextTaskIndex: 1, originalPlanPath: "plan.md",
		review: { enabled: true, model: { provider: "review", id: "model" }, thinkingLevel: "high" },
	};
	for (const result of [
		null, {}, { ...reviewResult, outcome: "success" }, { ...reviewResult, checks: "npm test" },
		{ ...reviewResult, findings: [{ severity: "unknown", evidence: "Evidence", action: "Follow up" }] },
		{ ...reviewResult, unavailableChecks: [{ check: "npm test" }] },
		{ ...reviewResult, remediationGenerated: "yes" },
	]) assert.throws(() => validateState({ ...state, reviewResult: result }), /Invalid implementation state/);
});

test("invalid phases, setup intent, review settings/results, and pending operations fail clearly", () => {
	const state = taskState("/project");
	for (const overrides of [
		{ version: 3 }, { phase: "unknown" }, { phase: "setup" }, { phase: "completed" },
		{ review: { enabled: true } }, { review: { enabled: true, model: { provider: "review", id: "model" }, thinkingLevel: "extreme" } },
		{ reviewResult }, { phase: "review" }, { phase: "review_checkpoint", nextTaskIndex: 1 },
		{ pendingCheckpoint: { purpose: "task", message: "" } }, { pendingCheckpoint: { purpose: "initial", message: "Initial" } },
		{ pendingCheckpoint: { purpose: "review", message: "Review" } }, { pendingCheckpoint: { purpose: "other", message: "Other" } },
		{ pendingCompaction: true, nextTaskIndex: 1 },
		{ setup: { step: "branch", createBranch: true, initialCheckpoint: false, baseBranch: "main", expectedHead: "head" } },
		{ preparedTasks: { markdown: "Generated", destination: "existing", overwriteApproved: false } },
	]) assert.throws(() => validateState({ ...state, ...overrides }), /Invalid implementation state/);
});
