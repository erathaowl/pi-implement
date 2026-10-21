import { readFile, writeFile } from "node:fs/promises";
import { completeCheckpoint } from "./checkpoint.ts";
import { assertFileUnchanged, snapshotFile } from "./files.ts";
import type { LocalGit } from "./git.ts";
import { generatedTasksPath } from "./plan.ts";
import { INITIAL_CHECKPOINT_MESSAGE, gitignorePath, saveState, type ImplementationState } from "./state.ts";

async function applyPreparedFile(path: string, before: string | null, content: string): Promise<void> {
	const current = await snapshotFile(path);
	// A write may have finished before its progress was persisted. Never rewrite it on recovery.
	if (current !== null && await readFile(path, "utf8") === content) return;
	await assertFileUnchanged(path, before);
	await writeFile(path, content, { encoding: "utf8", flag: before === null ? "wx" : "w" });
}

export async function startExecutionSetup(cwd: string, git: LocalGit, state: ImplementationState): Promise<void> {
	if (state.phase !== "setup" || !state.setup) throw new Error("No saved setup intent is available.");
	const setup = state.setup;
	if (setup.baseBranch !== null) {
		const current = await git.currentBranch(cwd);
		const expected = state.checkpoint ? state.branchName! : setup.baseBranch;
		if (setup.step === "branch") {
			if (await git.head(cwd) !== setup.expectedHead) throw new Error("Cannot recover setup: Git HEAD changed unexpectedly.");
			if (setup.createBranch) {
				if (expected === setup.baseBranch) throw new Error("The new branch name is already the current branch.");
				if (current === setup.baseBranch) await git.createBranch(cwd, expected);
				else if (current !== expected) throw new Error(`Cannot recover setup: expected local branch ${expected} or ${setup.baseBranch}.`);
			} else if (current !== expected) {
				throw new Error(`Cannot recover setup: expected local branch ${expected}.`);
			}
		} else {
			if (current !== expected) throw new Error(`Cannot recover setup: expected local branch ${expected}.`);
			if (setup.step !== "initial_checkpoint" && await git.head(cwd) !== setup.expectedHead) {
				throw new Error("Cannot recover setup: Git HEAD changed unexpectedly.");
			}
		}
	}
	if (setup.step === "branch") {
		setup.step = "initial_checkpoint";
		await saveState(cwd, state);
	}
	if (setup.step === "initial_checkpoint") {
		if (setup.initialCheckpoint) {
			state.pendingCheckpoint ??= { purpose: "initial", message: INITIAL_CHECKPOINT_MESSAGE, headBefore: setup.expectedHead };
			await saveState(cwd, state);
			await completeCheckpoint(cwd, git, state);
		} else {
			if (setup.baseBranch !== null && await git.head(cwd) !== setup.expectedHead) throw new Error("Cannot recover setup: Git HEAD changed unexpectedly.");
			setup.step = "gitignore";
			await saveState(cwd, state);
		}
	}
	if (setup.step === "gitignore") {
		if (setup.gitignore) await applyPreparedFile(await gitignorePath(cwd), setup.gitignore.before, setup.gitignore.content);
		setup.step = "tasks_file";
		await saveState(cwd, state);
	}
	if (setup.step === "tasks_file") {
		if (state.preparedTasks) {
			await applyPreparedFile(generatedTasksPath(cwd), state.preparedTasks.destination, state.preparedTasks.markdown);
		}
		setup.step = "done";
		state.phase = "tasks";
		state.status = "running";
		delete state.error;
		await saveState(cwd, state);
	}
}
