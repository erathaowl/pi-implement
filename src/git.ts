import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { STATE_FILE_NAME } from "./state.ts";

export interface LocalGit {
	isRepository(cwd: string): Promise<boolean>;
	isWorkingTreeClean(cwd: string): Promise<boolean>;
	createBranch(cwd: string, branchName: string): Promise<void>;
	currentBranch(cwd: string): Promise<string>;
	hasChanges(cwd: string): Promise<boolean>;
	commitChanges(cwd: string, message: string): Promise<void>;
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

	const stateExclusion = `:(top,exclude)${STATE_FILE_NAME}`;
	const status = async (cwd: string, excludeState = false): Promise<string> =>
		(
			await run(
				cwd,
				excludeState ? ["status", "--porcelain", "--", ".", stateExclusion] : ["status", "--porcelain"],
				"status check",
			)
		).stdout.trim();

	return {
		async isRepository(cwd) {
			try {
				const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
				return result.code === 0 && result.stdout.trim() === "true";
			} catch {
				return false;
			}
		},

		async isWorkingTreeClean(cwd) {
			return (await status(cwd)) === "";
		},

		async createBranch(cwd, branchName) {
			await run(cwd, ["switch", "-c", branchName], "branch creation");
		},

		async currentBranch(cwd) {
			return (await run(cwd, ["branch", "--show-current"], "branch check")).stdout.trim();
		},

		async hasChanges(cwd) {
			return (await status(cwd, true)) !== "";
		},

		async commitChanges(cwd, message) {
			await run(cwd, ["add", "-A", "--", ".", stateExclusion], "staging");
			await run(cwd, ["commit", "-m", message, "--", ".", stateExclusion], "commit");
		},
	};
}
