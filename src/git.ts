import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INITIAL_CHECKPOINT_MESSAGE, STATE_FILE_NAME } from "./state.ts";

export interface LocalGit {
	isRepository(cwd: string): Promise<boolean>;
	isWorkingTreeClean(cwd: string): Promise<boolean>;
	preflightSnapshot(cwd: string): Promise<string>;
	createBranch(cwd: string, branchName: string): Promise<void>;
	currentBranch(cwd: string): Promise<string>;
	head(cwd: string): Promise<string | null>;
	checkpointCommitted(cwd: string, headBefore: string | null, message: string): Promise<boolean>;
	commitInitialChanges(cwd: string, message?: string): Promise<void>;
	commitChanges(cwd: string, message: string): Promise<boolean>;
}

type Exec = ExtensionAPI["exec"];

function failureDetail(result: ExecResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

export function createLocalGit(exec: Exec): LocalGit {
	const run = async (cwd: string, args: string[], action: string): Promise<ExecResult> => {
		const result = await exec("git", args, { cwd });
		if (result.killed || result.code !== 0) {
			throw new Error(`Git ${action} failed: ${result.killed ? "command interrupted" : failureDetail(result)}`);
		}
		return result;
	};

	const head = async (cwd: string): Promise<string | null> => {
		const result = await exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd });
		if (!result.killed && result.code === 1 && !result.stderr.trim()) return null;
		if (result.killed || result.code !== 0 || !result.stdout.trim()) {
			throw new Error(`Git HEAD check failed: ${failureDetail(result)}`);
		}
		return result.stdout.trim();
	};
	const unstageState = async (cwd: string) => {
		// Omitting HEAD also works on an unborn branch. Preserve any existing committed version.
		await run(cwd, ["reset", "-q", "--", `:(top)${STATE_FILE_NAME}`, `:(top)${STATE_FILE_NAME}.tmp`], "state-file unstaging");
	};

	return {
		head,
		async checkpointCommitted(cwd, headBefore, message) {
			const current = await head(cwd);
			if (current === headBefore) return false;
			if (current !== null) {
				const commit = await run(cwd, ["log", "-1", "--format=%P%n%B"], "checkpoint recovery check");
				const [parents, ...body] = commit.stdout.trimEnd().split("\n");
				if (parents === (headBefore ?? "") && body.join("\n").trim() === message.trim()) return true;
			}
			throw new Error("Cannot recover checkpoint: Git HEAD changed unexpectedly. Inspect the local history before resuming.");
		},
		async isRepository(cwd) {
			let result: ExecResult;
			try {
				result = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
			} catch (error) {
				throw new Error(`Git repository check failed in ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
			}

			if (!result.killed) {
				const output = result.stdout.trim();
				if (result.code === 0 && (output === "true" || output === "false")) {
					return output === "true";
				}
				// Only Git's explicit non-repository result should hide checkpoint options.
				if (result.code !== 0 && /^fatal: not a git repository(?:\s|\()/i.test(result.stderr.trim())) {
					return false;
				}
			}

			throw new Error(`Git repository check failed in ${cwd}: ${result.killed ? "check interrupted" : failureDetail(result)}`);
		},

		async isWorkingTreeClean(cwd) {
			return (await run(cwd, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"], "status check")).stdout.trim() === "";
		},

		async preflightSnapshot(cwd) {
			// Include HEAD and branch identity; suppress optional index-refresh writes during preparation.
			return (await run(cwd, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=all"], "preflight")).stdout;
		},

		async createBranch(cwd, branchName) {
			await run(cwd, ["switch", "-c", branchName], "branch creation");
		},

		async currentBranch(cwd) {
			return (await run(cwd, ["branch", "--show-current"], "branch check")).stdout.trim();
		},

		async commitInitialChanges(cwd, message = INITIAL_CHECKPOINT_MESSAGE) {
			const originalHead = await head(cwd);
			// Save the staged tree before adding working-tree changes. This also rejects unresolved conflicts.
			const stagedTree = (await run(cwd, ["write-tree"], "initial index snapshot")).stdout.trim();
			try {
				await run(cwd, ["add", "-A"], "initial checkpoint staging");
				await unstageState(cwd);
				const changes = await run(cwd, ["diff", "--cached", "--name-only"], "initial change check");
				if (changes.stdout.trim()) await run(cwd, ["commit", "-m", message], "initial checkpoint commit");
			} catch (error) {
				// A process can report interruption after committing. Do not restore an index from the old HEAD.
				if (await head(cwd) !== originalHead) throw error;
				// Restore only the index; never reset or overwrite the user's working files.
				try {
					await run(cwd, ["read-tree", stagedTree], "initial index restoration");
				} catch (restoreError) {
					throw new Error(`${error instanceof Error ? error.message : String(error)}; ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
				}
				throw error;
			}
		},

		async commitChanges(cwd, message) {
			await run(cwd, ["add", "-A"], "staging");
			await unstageState(cwd);

			const stagedChanges = await exec("git", ["diff", "--cached", "--quiet"], { cwd });
			if (stagedChanges.code === 0) {
				return false;
			}
			if (stagedChanges.code !== 1) {
				throw new Error(`Git change check failed: ${failureDetail(stagedChanges)}`);
			}

			await run(cwd, ["commit", "-m", message], "commit");
			return true;
		},
	};
}
