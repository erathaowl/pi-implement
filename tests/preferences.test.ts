import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PREFERENCES_FILE_NAME, loadReviewPreference, saveReviewPreference, selectPreferredReviewSettings } from "../src/preferences.ts";
import { confirmExecutionSummary } from "../src/preview.ts";

const models = [{ provider: "test", id: "implementation", reasoning: true }, { provider: "test", id: "review", reasoning: true }];
const implementation = { implementationModel: models[0], implementationThinkingLevel: "medium" as const };
const preferred = { model: { provider: "test", id: "review" }, thinkingLevel: "high" as const };

async function withDirectory(run: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(process.cwd(), ".preferences-test-"));
	try { await run(directory); }
	finally { await rm(directory, { recursive: true, force: true }); }
}
function context(cwd: string, responses: Array<string | undefined> = []) {
	const prompts: Array<{ title: string; choices: string[] }> = [];
	const warnings: string[] = [];
	const ctx = {
		cwd, mode: "rpc", hasUI: true,
		modelRegistry: { getAvailable: () => models },
		ui: {
			async select(title: string, choices: string[]) {
				prompts.push({ title, choices });
				return responses.length ? responses.shift() : choices[0];
			},
			notify(message: string) { warnings.push(message); },
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, prompts, warnings };
}

test("preference storage follows the SDK user agent directory and writes atomically", async () => {
	await withDirectory(async (directory) => {
		const agentDir = join(directory, "agent");
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			assert.equal(await loadReviewPreference(), undefined);
			await saveReviewPreference(preferred);
			assert.deepEqual(await loadReviewPreference(), preferred);
			assert.deepEqual(await readdir(agentDir), [PREFERENCES_FILE_NAME]);
			assert.deepEqual(JSON.parse(await readFile(join(agentDir, PREFERENCES_FILE_NAME), "utf8")), { version: 1, review: preferred });
			await Promise.all([saveReviewPreference(preferred), saveReviewPreference({ ...preferred, thinkingLevel: "low" })]);
			assert.ok(["high", "low"].includes((await loadReviewPreference())!.thinkingLevel));
			assert.deepEqual(await readdir(agentDir), [PREFERENCES_FILE_NAME]);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
});

test("the last confirmed review preference is proposed across project directories", async () => {
	await withDirectory(async (directory) => {
		const agentDir = join(directory, "agent");
		const firstProject = join(directory, "first-project");
		const secondProject = join(directory, "second-project");
		await mkdir(firstProject);
		await mkdir(secondProject);
		const first = context(firstProject);
		assert.deepEqual(await selectPreferredReviewSettings(true, implementation, first.ctx, agentDir), {
			enabled: true, model: { provider: "test", id: "implementation" }, thinkingLevel: "medium",
		});
		await assert.rejects(readFile(join(agentDir, PREFERENCES_FILE_NAME)), { code: "ENOENT" });
		await saveReviewPreference(preferred, agentDir);
		const second = context(secondProject);
		assert.deepEqual(await selectPreferredReviewSettings(true, implementation, second.ctx, agentDir), { enabled: true, ...preferred });
		assert.equal(second.prompts[0].choices[0], "test/review");
		assert.equal(second.prompts[1].choices[0], "high");
		assert.deepEqual(await readdir(firstProject), []);
		assert.deepEqual(await readdir(secondProject), []);
	});
});

for (const responses of [[undefined], ["test/review", undefined], ["test/review", "low", "Cancel"], ["test/review", "low", "Start implementation"]]) {
	test(`only summary confirmation can persist a newly selected pair (${JSON.stringify(responses)})`, async () => {
		await withDirectory(async (directory) => {
			await saveReviewPreference(preferred, directory);
			const path = join(directory, PREFERENCES_FILE_NAME);
			const before = await readFile(path, "utf8");
			const { ctx } = context(directory, [...responses]);
			const review = await selectPreferredReviewSettings(true, implementation, ctx, directory);
			assert.equal(await readFile(path, "utf8"), before);
			if (review?.enabled && await confirmExecutionSummary({
				...implementation, command: "/implement-tasks", cwd: directory, sourcePlanPath: null,
				sourcePath: "tasks.md", taskCount: 1, checkpoint: false, createBranch: false,
				initiallyDirty: false, automaticCompaction: false, compactionThresholdPercent: 70,
				review, ignoreStateFile: false,
			}, ctx)) await saveReviewPreference(review, directory);
			if (responses.at(-1) === "Start implementation") assert.equal((await loadReviewPreference(directory))?.thinkingLevel, "low");
			else assert.equal(await readFile(path, "utf8"), before);
		});
	});
}

for (const stale of [
	{ model: { provider: "missing", id: "model" }, thinkingLevel: "high" as const },
	{ model: preferred.model, thinkingLevel: "xhigh" as const },
]) {
	test(`persisted unavailable preference ${JSON.stringify(stale)} requires explicit selection`, async () => {
		await withDirectory(async (directory) => {
			await saveReviewPreference(stale, directory);
			const before = await readFile(join(directory, PREFERENCES_FILE_NAME), "utf8");
			const r = context(directory);
			const selected = await selectPreferredReviewSettings(true, implementation, r.ctx, directory);
			assert.ok(selected?.enabled);
			assert.equal(r.prompts.length, 2);
			assert.equal(r.warnings.length, 1);
			assert.equal(await readFile(join(directory, PREFERENCES_FILE_NAME), "utf8"), before);
		});
	});
}

test("disabled review never reads preferences or prompts", async () => {
	await withDirectory(async (directory) => {
		const notDirectory = join(directory, "not-a-directory");
		await writeFile(notDirectory, "Do not read this as a directory");
		assert.deepEqual(await selectPreferredReviewSettings(false, implementation, {} as ExtensionCommandContext, notDirectory), { enabled: false });
		await assert.rejects(loadReviewPreference(notDirectory), /Unable to read review preferences/);
	});
});

test("malformed preferences require a fresh explicit selection without overwriting the file", async () => {
	await withDirectory(async (directory) => {
		const path = join(directory, PREFERENCES_FILE_NAME);
		for (const raw of ["not JSON", "null", "[]", "{}", JSON.stringify({ version: 2, review: preferred }),
			JSON.stringify({ version: 1, review: { ...preferred, thinkingLevel: "extreme" } }),
			JSON.stringify({ version: 1, review: { ...preferred, model: { provider: "", id: "missing" } } })]) {
			await writeFile(path, raw);
			assert.equal(await loadReviewPreference(directory), undefined);
			const r = context(directory);
			assert.ok((await selectPreferredReviewSettings(true, implementation, r.ctx, directory))?.enabled);
			assert.equal(r.prompts.length, 2);
			assert.equal(r.prompts[0].choices[0], "test/implementation");
			assert.equal(await readFile(path, "utf8"), raw);
		}
	});
});

test("invalid saves and filesystem errors do not silently destroy preferences", async () => {
	await withDirectory(async (directory) => {
		await saveReviewPreference(preferred, directory);
		const path = join(directory, PREFERENCES_FILE_NAME);
		const before = await readFile(path, "utf8");
		await assert.rejects(saveReviewPreference({ ...preferred, thinkingLevel: "invalid" } as never, directory), /Invalid review/);
		assert.equal(await readFile(path, "utf8"), before);
		const notDirectory = join(directory, "not-directory");
		await writeFile(notDirectory, "Keep this\n");
		await assert.rejects(saveReviewPreference(preferred, notDirectory), /Unable to save review preferences/);
		assert.equal(await readFile(notDirectory, "utf8"), "Keep this\n");
	});
});
