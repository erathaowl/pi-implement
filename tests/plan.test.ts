import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
	convertPlanToTaskDocument,
	generatedTasksFileExists,
	PLAN_CONVERSION_PROMPT,
	writeGeneratedTaskDocument,
} from "../src/plan.ts";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(process.cwd(), ".plan-test-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("plan conversion uses an isolated tool-free model call and returns Markdown", async () => {
	const calls: unknown[][] = [];
	const model = { provider: "test", id: "selected" };
	const ctx = {
		model,
		thinkingLevel: "high",
		modelRegistry: {
			async complete(...args: unknown[]) {
				calls.push(args);
				return {
					stopReason: "stop",
					content: [{ type: "text", text: "```markdown\n# Tasks\n\n## Task 1 - Build\n\nBuild it.\n```" }],
				};
			},
		},
	};

	const markdown = await convertPlanToTaskDocument("Build the feature", ctx as never);
	assert.equal(markdown, "# Tasks\n\n## Task 1 - Build\n\nBuild it.\n");
	const [calledModel, context, options] = calls[0] as [
		unknown,
		{ systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }>; tools?: unknown },
		Record<string, unknown>,
	];
	assert.equal(calledModel, model);
	assert.equal(context.systemPrompt, PLAN_CONVERSION_PROMPT);
	assert.equal(context.messages[0].content[0].text, "Build the feature");
	assert.equal("tools" in context, false);
	assert.equal("toolChoice" in options, false);
	assert.equal(options.reasoning, "high");
	assert.match(PLAN_CONVERSION_PROMPT, /requirements, constraints, acceptance criteria/);
	assert.match(PLAN_CONVERSION_PROMPT, /intended execution order/);
});

test("generated task document helpers detect and write tasks.md", async () => {
	await withTempDir(async (directory) => {
		assert.equal(await generatedTasksFileExists(directory), false);
		const outputPath = await writeGeneratedTaskDocument(directory, "# Tasks\n");
		assert.equal(outputPath, join(directory, "tasks.md"));
		assert.equal(await generatedTasksFileExists(directory), true);
		assert.equal(await readFile(outputPath, "utf8"), "# Tasks\n");
	});
});
