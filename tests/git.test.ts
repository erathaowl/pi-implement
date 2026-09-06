import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGit } from "../src/git.ts";
import { STATE_FILE_NAME } from "../src/state.ts";

function executeGit(cwd: string, args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		code: result.status ?? 1,
		killed: result.signal !== null,
	};
}

function runGit(cwd: string, args: string[]): string {
	const result = executeGit(cwd, args);
	assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout;
}

test("checkpoint staging excludes the state file whether it is ignored or unignored", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-implement-git-"));
	try {
		for (const ignored of [true, false]) {
			const repository = join(directory, ignored ? "ignored" : "unignored");
			await mkdir(repository);
			runGit(repository, ["init", "-q"]);
			runGit(repository, ["config", "user.name", "Pi Implement Test"]);
			runGit(repository, ["config", "user.email", "pi-implement@example.invalid"]);
			await writeFile(join(repository, "tracked.txt"), "before\n", "utf8");
			if (ignored) {
				await writeFile(join(repository, ".gitignore"), `${STATE_FILE_NAME}\n`, "utf8");
			}
			runGit(repository, ["add", "-A"]);
			runGit(repository, ["commit", "-q", "-m", "initial"]);

			await writeFile(join(repository, STATE_FILE_NAME), "state\n", "utf8");
			await writeFile(join(repository, "tracked.txt"), "after\n", "utf8");
			const git = createLocalGit(async (command, args, options) =>
				executeGit(options?.cwd ?? repository, args) as never,
			);

			assert.equal(await git.commitChanges(repository, "Task 1: Update tracked file"), true);
			assert.equal(runGit(repository, ["show", "--format=", "--name-only", "HEAD"]).trim(), "tracked.txt");
			assert.notEqual(executeGit(repository, ["ls-files", "--error-unmatch", STATE_FILE_NAME]).code, 0);
			assert.equal(await readFile(join(repository, STATE_FILE_NAME), "utf8"), "state\n");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
