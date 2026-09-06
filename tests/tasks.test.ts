import assert from "node:assert/strict";
import test from "node:test";
import {
	buildTaskFilePrompt,
	indexTaskFile,
	TASK_INDEX_PROMPT,
	validateTaskIndex,
} from "../src/tasks.ts";

function indexingContext(result: unknown) {
	const model = { provider: "test", id: "selected-model" };
	const calls: unknown[][] = [];
	const ctx = {
		model,
		modelRegistry: {
			async complete(...args: unknown[]) {
				calls.push(args);
				return {
					stopReason: "stop",
					content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
				};
			},
		},
	};
	return { calls, ctx, model };
}

test("task indexing uses an isolated tool-free call and returns titles only", async () => {
	const markdown = "# Tasks\n## Task 1 - Add API\nImplement it.";
	const { calls, ctx, model } = indexingContext({
		tasks: [{ title: "Add API", instructions: "This must not enter the index." }],
	});

	const index = await indexTaskFile(markdown, ctx as never);

	assert.deepEqual(index, { tasks: [{ title: "Add API" }] });
	const [calledModel, context, options] = calls[0] as [
		unknown,
		{ systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }>; tools?: unknown },
		Record<string, unknown>,
	];
	assert.equal(calledModel, model);
	assert.equal(context.systemPrompt, TASK_INDEX_PROMPT);
	assert.equal(context.messages[0].content[0].text, markdown);
	assert.equal("tools" in context, false);
	assert.equal("toolChoice" in options, false);
});

test("task index preserves source order", async () => {
	const { ctx } = indexingContext({
		tasks: [{ title: "Configure" }, { title: "Implement" }, { title: "Document" }],
	});
	assert.deepEqual(await indexTaskFile("task document", ctx as never), {
		tasks: [{ title: "Configure" }, { title: "Implement" }, { title: "Document" }],
	});
});

test("task indexing prompt excludes task-like examples and instruction rewriting", () => {
	assert.match(TASK_INDEX_PROMPT, /examples or templates/);
	assert.match(TASK_INDEX_PROMPT, /fenced code blocks/);
	assert.match(TASK_INDEX_PROMPT, /Do not copy, summarize, rewrite/);
	assert.match(TASK_INDEX_PROMPT, /authoritative source/);
});

test("task-file prompt references the original file, number, and title without rewritten instructions", () => {
	const prompt = buildTaskFilePrompt("docs/tasks.md", 2, { title: "Add middleware" });
	assert.match(prompt, /^Read "docs\/tasks\.md" and implement task #2 \("Add middleware"\)\./);
	assert.match(prompt, /task file itself as the authoritative source/);
	assert.match(prompt, /shared constraints and acceptance criteria/);
	assert.match(prompt, /Complete only this task/);
	assert.match(prompt, /Do not start subsequent tasks/);
});

test("task index validation rejects malformed or empty indexes", () => {
	assert.throws(() => validateTaskIndex({ wrong: [] }), /invalid tasks list/);
	assert.throws(() => validateTaskIndex({ tasks: [] }), /No implementation tasks/);
	assert.throws(() => validateTaskIndex({ tasks: [{ title: " " }] }), /empty title/);
});
