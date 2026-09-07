import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	STATE_FILE_NAME,
	addStateFileToGitignore,
	deleteState,
	loadState,
	saveState,
	type ImplementationState,
} from "../src/state.ts";

const state: ImplementationState = {
	version: 1,
	cwd: "/project",
	sourcePath: "tasks.md",
	tasks: [{ title: "One", prompt: "Implement one" }],
	nextTaskIndex: 0,
	status: "running",
	checkpoint: false,
	automaticCompaction: false,
};

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-implement-state-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("state save is atomic, loadable, updateable, and deletable", async () => {
	await withTempDir(async (directory) => {
		assert.equal(await loadState(directory), undefined);
		await saveState(directory, state);
		assert.deepEqual(await loadState(directory), state);
		assert.equal((await readdir(directory)).includes(`${STATE_FILE_NAME}.tmp`), false);

		const failed: ImplementationState = { ...state, status: "failed", error: "turn failed" };
		await saveState(directory, failed);
		assert.deepEqual(await loadState(directory), failed);

		await deleteState(directory);
		assert.equal(await loadState(directory), undefined);
	});
});

test("gitignore addition uses one exact state filename without duplicates", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, ".gitignore"), "node_modules/", "utf8");
		await addStateFileToGitignore(directory);
		await addStateFileToGitignore(directory);

		const lines = (await readFile(join(directory, ".gitignore"), "utf8")).split(/\r?\n/);
		assert.equal(lines.filter((line) => line === STATE_FILE_NAME).length, 1);
		assert.deepEqual(lines.slice(0, 2), ["node_modules/", STATE_FILE_NAME]);
	});
});

test("state and gitignore are stored at the repository root", async () => {
	await withTempDir(async (directory) => {
		const nested = join(directory, "packages", "app");
		await mkdir(join(directory, ".git"));
		await mkdir(nested, { recursive: true });

		await saveState(nested, state);
		await addStateFileToGitignore(nested);

		assert.deepEqual(await loadState(nested), state);
		assert.equal(JSON.parse(await readFile(join(directory, STATE_FILE_NAME), "utf8")).sourcePath, "tasks.md");
		assert.equal(await readFile(join(directory, ".gitignore"), "utf8"), `${STATE_FILE_NAME}\n`);
	});
});

test("state validation requires a non-empty working directory", async () => {
	await withTempDir(async (directory) => {
		for (const cwd of [undefined, "   "]) {
			const candidate: Record<string, unknown> = { ...state, cwd };
			if (cwd === undefined) delete candidate.cwd;
			await writeFile(join(directory, STATE_FILE_NAME), JSON.stringify(candidate), "utf8");
			await assert.rejects(loadState(directory), /Invalid implementation state/);
		}
	});
});

test("invalid state is rejected", async () => {
	await withTempDir(async (directory) => {
		await writeFile(join(directory, STATE_FILE_NAME), "{}", "utf8");
		await assert.rejects(loadState(directory), /Invalid implementation state/);
	});
});
