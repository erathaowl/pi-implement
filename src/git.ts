import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STATE_FILE_NAME } from "./state.ts";

export interface LocalGit {
	isRepository(cwd: string): Promise<boolean>;
	isWorkingTreeClean(cwd: string): Promise<boolean>;
	createBranch(cwd: string, branchName: string): Promise<void>;
	currentBranch(cwd: string): Promise<string>;
	commitChanges(cwd: string, message: string): Promise<boolean>;
}

type Exec = ExtensionAPI["exec"];

function failureDetail(result: ExecResult): string {
	return result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
}

export function createLocalGit(exec: Exec): LocalGit {
	const run = async (cwd: string, args: string[], action: string): Promise<ExecResult> => {
		const result = await exec("git", args, { cwd });
		if (result.code !== 0) {
			throw new Error(`Git ${action} failed: ${failureDetail(result)}`);
		}
		return result;
	};

	return {
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
			return (await run(cwd, ["status", "--porcelain"], "status check")).stdout.trim() === "";
		},

		async createBranch(cwd, branchName) {
			await run(cwd, ["switch", "-c", branchName], "branch creation");
		},

		async currentBranch(cwd) {
			return (await run(cwd, ["branch", "--show-current"], "branch check")).stdout.trim();
		},

		async commitChanges(cwd, message) {
			await run(cwd, ["add", "-A"], "staging");
			await run(cwd, ["reset", "-q", "HEAD", "--", STATE_FILE_NAME], "state-file unstaging");

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
