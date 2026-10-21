import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PREFERENCES_FILE_NAME, loadImplementationPreference, loadReviewPreference, saveImplementationPreference, saveReviewPreference, selectPreferredImplementationSettings, selectPreferredReviewSettings } from "../src/preferences.ts";
import { confirmExecutionSummary } from "../src/preview.ts";

const models = [{ provider: "test", id: "implementation", reasoning: true }, { provider: "test", id: "review", reasoning: true }];
const implementation = { implementationModel: { provider: "test", id: "implementation" }, implementationThinkingLevel: "medium" as const };
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
		cwd, mode: "rpc", hasUI: true, model: models[0], scopedModels: [],
		modelRegistry: { getAvailable: () => models },
		ui: {
			async select(title: string, choices: string[]) {
				prompts.push({ title, choices });
				return responses.length ? responses.shift() : choices[0];
			},
			notify(message: string) { warnings.push(message); },
		},
	} as unknown as ExtensionCommandContext;
	const controller = {
		getThinkingLevel: () => "medium" as const,
		async setModel() { throw new Error("Selection must not switch models"); },
		setThinkingLevel() { throw new Error("Selection must not switch thinking levels"); },
	};
	return { ctx, controller, prompts, warnings };
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

test("first implementation selection uses the session and only a confirmed save creates history", async () => {
	await withDirectory(async (directory) => {
		assert.equal(await loadImplementationPreference(directory), undefined);
		const r = context(directory);
		assert.deepEqual(await selectPreferredImplementationSettings(r.ctx, r.controller, directory), implementation);
		assert.equal(r.prompts.length, 2);
		await assert.rejects(readFile(join(directory, PREFERENCES_FILE_NAME)), { code: "ENOENT" });
		await saveImplementationPreference(preferred, directory);
		const second = context(join(directory, "another-project"));
		assert.deepEqual(await selectPreferredImplementationSettings(second.ctx, second.controller, directory), {
			implementationModel: preferred.model, implementationThinkingLevel: "high",
		});
		assert.equal(second.prompts[0].choices[0], "test/review");
		assert.equal(second.prompts[1].choices[0], "high");
	});
});

for (const policy of [undefined, true, false, "false"]) {
	test(`implementation default policy ${JSON.stringify(policy)} preserves history and requires both dialogs`, async () => {
		await withDirectory(async (directory) => {
			const saved = { version: 1, implementation: preferred, ...(policy === undefined ? {} : { reuseLastImplementationSettings: policy }) };
			const path = join(directory, PREFERENCES_FILE_NAME);
			await writeFile(path, JSON.stringify(saved));
			const r = context(directory);
			assert.deepEqual(await selectPreferredImplementationSettings(r.ctx, r.controller, directory), policy === false ? implementation : {
				implementationModel: preferred.model, implementationThinkingLevel: preferred.thinkingLevel,
			});
			assert.equal(r.prompts.length, 2);
			assert.deepEqual(await loadImplementationPreference(directory), preferred);
			await saveImplementationPreference({ ...preferred, thinkingLevel: "low" }, directory);
			const after = JSON.parse(await readFile(path, "utf8"));
			assert.equal(after.reuseLastImplementationSettings, policy);
			assert.equal(after.implementation.thinkingLevel, "low");
		});
	});
}

test("pair updates preserve review-only compatibility, the switch, unknown fields, and simultaneous updates", async () => {
	await withDirectory(async (directory) => {
		const path = join(directory, PREFERENCES_FILE_NAME);
		const original = { version: 1, review: preferred, reuseLastImplementationSettings: false, custom: { keep: [1, 2] } };
		await writeFile(path, JSON.stringify(original));
		assert.equal(await loadImplementationPreference(directory), undefined);
		assert.deepEqual(await loadReviewPreference(directory), preferred);
		await saveImplementationPreference({ model: models[0], thinkingLevel: "medium" }, directory);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			...original, implementation: { model: { provider: "test", id: "implementation" }, thinkingLevel: "medium" },
		});
		await Promise.all([
			saveImplementationPreference({ ...preferred, thinkingLevel: "low" }, directory),
			saveReviewPreference({ ...preferred, thinkingLevel: "off" }, directory),
		]);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			...original, implementation: { ...preferred, thinkingLevel: "low" }, review: { ...preferred, thinkingLevel: "off" },
		});
		assert.deepEqual(await readdir(directory), [PREFERENCES_FILE_NAME]);
	});
});

for (const responses of [[undefined], ["test/review", undefined], ["test/review", "low", "Cancel"]]) {
	test(`implementation cancellation leaves the complete configuration untouched (${JSON.stringify(responses)})`, async () => {
		await withDirectory(async (directory) => {
			await saveImplementationPreference(preferred, directory);
			await saveReviewPreference({ ...preferred, thinkingLevel: "off" }, directory);
			const path = join(directory, PREFERENCES_FILE_NAME);
			const before = await readFile(path, "utf8");
			const r = context(directory, [...responses]);
			const selected = await selectPreferredImplementationSettings(r.ctx, r.controller, directory);
			if (selected) assert.equal(await confirmExecutionSummary({
				...selected, command: "/implement-tasks", cwd: directory, sourcePlanPath: null, sourcePath: "tasks.md", taskCount: 1,
				checkpoint: false, createBranch: false, initiallyDirty: false, automaticCompaction: false,
				compactionThresholdPercent: 70, review: { enabled: false }, ignoreStateFile: false,
			}, r.ctx), false);
			assert.equal(await readFile(path, "utf8"), before);
		});
	});
}

for (const stale of [
	{ model: { provider: "missing", id: "model" }, thinkingLevel: "high" as const },
	{ model: preferred.model, thinkingLevel: "xhigh" as const },
]) {
	test(`implementation history ${JSON.stringify(stale)} warns and falls back without rewriting preferences`, async () => {
		await withDirectory(async (directory) => {
			await saveImplementationPreference(stale, directory);
			const path = join(directory, PREFERENCES_FILE_NAME);
			const before = await readFile(path, "utf8");
			const r = context(directory);
			assert.deepEqual(await selectPreferredImplementationSettings(r.ctx, r.controller, directory), implementation);
			assert.equal(r.warnings.length, 1);
			assert.equal(await readFile(path, "utf8"), before);
		});
	});
}

test("malformed implementation data cannot hide valid review data or modify the file during selection", async () => {
	await withDirectory(async (directory) => {
		const path = join(directory, PREFERENCES_FILE_NAME);
		for (const raw of ["invalid JSON", "null", "[]", "{}", JSON.stringify({ version: 2, implementation: preferred }),
			JSON.stringify({ version: 1, review: preferred, implementation: { ...preferred, thinkingLevel: "invalid" } })]) {
			await writeFile(path, raw);
			const r = context(directory);
			assert.deepEqual(await selectPreferredImplementationSettings(r.ctx, r.controller, directory), implementation);
			assert.equal(await loadImplementationPreference(directory), undefined);
			assert.equal(await readFile(path, "utf8"), raw);
		}
		assert.deepEqual(await loadReviewPreference(directory), preferred);
		await saveImplementationPreference({ model: models[0], thinkingLevel: "medium" }, directory);
		assert.deepEqual(await loadReviewPreference(directory), preferred);
		await writeFile(path, "invalid JSON");
		await saveImplementationPreference(preferred, directory);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, implementation: preferred });
	});
});

test("invalid implementation saves and filesystem errors preserve existing data and do not poison later writes", async () => {
	await withDirectory(async (directory) => {
		await saveImplementationPreference(preferred, directory);
		const path = join(directory, PREFERENCES_FILE_NAME);
		const before = await readFile(path, "utf8");
		await assert.rejects(saveImplementationPreference({ ...preferred, thinkingLevel: "invalid" } as never, directory), /Invalid implementation/);
		assert.equal(await readFile(path, "utf8"), before);
		const notDirectory = join(directory, "not-directory");
		await writeFile(notDirectory, "Keep this\n");
		await assert.rejects(saveImplementationPreference(preferred, notDirectory), /Unable to save implementation preferences/);
		await saveReviewPreference(preferred, directory);
		assert.deepEqual(await loadImplementationPreference(directory), preferred);
		assert.equal(await readFile(notDirectory, "utf8"), "Keep this\n");
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
