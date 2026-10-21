import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createLocalGit } from "../src/git.ts";

function executeGit(cwd: string, args: string[]) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1, killed: result.signal !== null };
}

function runGit(cwd: string, args: string[]): string {
	const result = executeGit(cwd, args);
	assert.equal(result.code, 0, result.stderr);
	return result.stdout;
}

async function withRepository(callback: (cwd: string) => Promise<void>) {
	const cwd = await mkdtemp(join(process.cwd(), ".initial-checkpoint-test-"));
	try {
		runGit(cwd, ["init", "-q", "-b", "main"]);
		runGit(cwd, ["config", "user.name", "Pi Implement Test"]);
		runGit(cwd, ["config", "user.email", "pi-implement@example.invalid"]);
		await callback(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

for (const branch of ["main", "feature/implementation"]) {
	test(`initial checkpoint integration captures staged, unstaged, and untracked changes on ${branch}`, async () => {
		await withRepository(async (cwd) => {
			await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
			await writeFile(join(cwd, "tracked.txt"), "original\n");
			runGit(cwd, ["add", "-A"]);
			runGit(cwd, ["commit", "-q", "-m", "baseline"]);
			const baseline = runGit(cwd, ["rev-parse", "HEAD"]).trim();

			await writeFile(join(cwd, "staged.txt"), "staged\n");
			runGit(cwd, ["add", "staged.txt"]);
			await writeFile(join(cwd, "tracked.txt"), "unstaged\n");
			await writeFile(join(cwd, "untracked.txt"), "untracked\n");
			await writeFile(join(cwd, "ignored.txt"), "ignored\n");
			const git = createLocalGit(async (_command, args) => executeGit(cwd, args));
			assert.equal(await git.isWorkingTreeClean(cwd), false);
			if (branch !== "main") await git.createBranch(cwd, branch);
			await git.commitInitialChanges(cwd);

			assert.equal(await git.currentBranch(cwd), branch);
			assert.equal(runGit(cwd, ["log", "-1", "--format=%s"]).trim(), "chore: capture initial implementation state");
			assert.equal(runGit(cwd, ["rev-parse", "HEAD^"]).trim(), baseline);
			assert.equal(runGit(cwd, ["show", "HEAD:staged.txt"]), "staged\n");
			assert.equal(runGit(cwd, ["show", "HEAD:tracked.txt"]), "unstaged\n");
			assert.equal(runGit(cwd, ["show", "HEAD:untracked.txt"]), "untracked\n");
			assert.equal(runGit(cwd, ["ls-files", "ignored.txt"]), "");
			assert.equal(await readFile(join(cwd, "ignored.txt"), "utf8"), "ignored\n");
			assert.equal(await git.isWorkingTreeClean(cwd), true);
			if (branch !== "main") assert.equal(runGit(cwd, ["rev-parse", "main"]).trim(), baseline);

			const initialCheckpoint = runGit(cwd, ["rev-parse", "HEAD"]).trim();
			await writeFile(join(cwd, "tracked.txt"), "implementation\n");
			assert.equal(await git.commitChanges(cwd, "Task 1: Implement"), true);
			assert.equal(runGit(cwd, ["rev-parse", "HEAD^"]).trim(), initialCheckpoint);
			assert.equal(runGit(cwd, ["show", `${initialCheckpoint}:tracked.txt`]), "unstaged\n");
		});
	});
}

test("initial checkpoint integration restores staged changes and leaves files intact when Git rejects the commit", async () => {
	await withRepository(async (cwd) => {
		await writeFile(join(cwd, "tracked.txt"), "baseline\n");
		runGit(cwd, ["add", "-A"]);
		runGit(cwd, ["commit", "-q", "-m", "baseline"]);
		const head = runGit(cwd, ["rev-parse", "HEAD"]);
		await writeFile(join(cwd, "tracked.txt"), "staged version\n");
		runGit(cwd, ["add", "tracked.txt"]);
		await writeFile(join(cwd, "tracked.txt"), "unstaged version\n");
		await writeFile(join(cwd, "untracked.txt"), "untracked work\n");
		const status = runGit(cwd, ["status", "--porcelain"]);
		const staged = runGit(cwd, ["diff", "--cached"]);
		const git = createLocalGit(async (_command, args) => executeGit(cwd,
			args[0] === "commit" ? ["-c", "user.name=", "-c", "user.email=", ...args] : args,
		));

		await assert.rejects(git.commitInitialChanges(cwd), /Git initial checkpoint commit failed:/);

		assert.equal(runGit(cwd, ["rev-parse", "HEAD"]), head);
		assert.equal(runGit(cwd, ["status", "--porcelain"]), status);
		assert.equal(runGit(cwd, ["diff", "--cached"]), staged);
		assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "unstaged version\n");
		assert.equal(await readFile(join(cwd, "untracked.txt"), "utf8"), "untracked work\n");
	});
});

for (const unborn of [false, true]) {
	test(`initial checkpoint excludes staged recovery metadata (unborn: ${unborn})`, async () => {
		await withRepository(async (cwd) => {
			if (!unborn) {
				await writeFile(join(cwd, "baseline.txt"), "Baseline\n");
				runGit(cwd, ["add", "-A"]);
				runGit(cwd, ["commit", "-q", "-m", "Baseline"]);
			}
			await writeFile(join(cwd, ".pi-implement-state.json"), "Recovery intent\n");
			await writeFile(join(cwd, ".pi-implement-state.json.tmp"), "Pending state write\n");
			await writeFile(join(cwd, "work.txt"), "User work\n");
			runGit(cwd, ["add", "-A"]);
			const nested = join(cwd, "packages", "app");
			await mkdir(nested, { recursive: true });
			const git = createLocalGit(async (_command, args, options) => executeGit(options?.cwd ?? cwd, args));
			await git.commitInitialChanges(nested);
			const files = runGit(cwd, ["ls-tree", "-r", "--name-only", "HEAD"]);
			assert.ok(files.includes("work.txt"));
			assert.ok(!files.includes(".pi-implement-state.json"));
			assert.equal(await readFile(join(cwd, ".pi-implement-state.json"), "utf8"), "Recovery intent\n");
			assert.equal(await readFile(join(cwd, ".pi-implement-state.json.tmp"), "utf8"), "Pending state write\n");
			await writeFile(join(cwd, "work.txt"), "Task work\n");
			await git.commitChanges(nested, "Task checkpoint");
			assert.ok(!runGit(cwd, ["ls-tree", "-r", "--name-only", "HEAD"]).includes(".pi-implement-state.json"));
		});
	});
}

test("initial checkpoint skips a metadata-only worktree without creating an empty commit", async () => {
	await withRepository(async (cwd) => {
		await writeFile(join(cwd, ".pi-implement-state.json"), "Recovery intent\n");
		const git = createLocalGit(async (_command, args) => executeGit(cwd, args));
		await git.commitInitialChanges(cwd);
		assert.equal(await git.head(cwd), null);
	});
});

test("initial checkpoint integration supports a repository without an existing commit", async () => {
	await withRepository(async (cwd) => {
		await writeFile(join(cwd, "untracked.txt"), "initial work\n");
		const git = createLocalGit(async (_command, args) => executeGit(cwd, args));
		await git.createBranch(cwd, "feature/implementation");
		await git.commitInitialChanges(cwd);
		assert.equal(await git.currentBranch(cwd), "feature/implementation");
		assert.equal(runGit(cwd, ["rev-list", "--count", "HEAD"]).trim(), "1");
		assert.equal(runGit(cwd, ["show", "HEAD:untracked.txt"]), "initial work\n");
		assert.equal(await git.isWorkingTreeClean(cwd), true);
	});
});
