import assert from "node:assert/strict";
import test from "node:test";
import {
	buildTaskFilePrompt,
	buildTaskContinuationPrompt,
	parseTaskResult, TASK_RESULT_START, TASK_RESULT_END,
	indexTaskFile,
	TASK_INDEX_PROMPT,
	validateTaskIndex,
} from "../src/tasks.ts";

function indexingContext(result: unknown) {
	const model = { provider: "test", id: "selected-model" };
	const calls: unknown[][] = [];
	const ctx = {
		model,
		thinkingLevel: "high",
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
	assert.equal(options.reasoning, "high");
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
	assert.match(prompt, /Do not perform remote Git operations/);
	assert.match(prompt, /Do not push, pull, fetch, clone, or modify remotes/);
	assert.match(prompt, /Do not create commits/);
});

test("task index validation rejects malformed or empty indexes", () => {
	assert.throws(() => validateTaskIndex({ wrong: [] }), /invalid tasks list/);
	assert.throws(() => validateTaskIndex({ tasks: [] }), /No implementation tasks/);
	assert.throws(() => validateTaskIndex({ tasks: [{ title: " " }] }), /empty title/);
});

test("task prompt requires one terminal result and distinguishes authorization waits", () => {
	const prompt = buildTaskFilePrompt("tasks.md", 3, { title: "Example" });
	assert.match(prompt, /exactly one task-result block/);
	assert.match(prompt, /"taskNumber":3/);
	assert.match(prompt, /only after implementing and checking/);
	assert.match(prompt, /waiting_for_user/);
	assert.match(prompt, /Never report completed while blocked/);
});

const resultBlock = (value: unknown) => `${TASK_RESULT_START}\n${JSON.stringify(value)}\n${TASK_RESULT_END}`;

test("task result accepts only a flat completed or waiting result for the current task", () => {
	assert.deepEqual(parseTaskResult("Implemented and checked.\n" + resultBlock({ status: "completed", taskNumber: 2 }), 2), { status: "completed", taskNumber: 2 });
	assert.deepEqual(parseTaskResult(resultBlock({ status: "waiting_for_user", taskNumber: 2, reason: " Approve the tool " }), 2), { status: "waiting_for_user", taskNumber: 2, reason: "Approve the tool" });
	assert.deepEqual(parseTaskResult(resultBlock({ status: "waiting_for_user", taskNumber: 2 }), 2), { status: "waiting_for_user", taskNumber: 2 });
});

test("task result rejects missing, malformed, duplicate, contradictory and wrong-task reports", () => {
	const valid = resultBlock({ status: "completed", taskNumber: 2 });
	for (const text of [
		"", "Please approve access.", "Done!", valid + valid,
		valid + resultBlock({ status: "waiting_for_user", taskNumber: 2 }),
		valid + " more text", TASK_RESULT_END + TASK_RESULT_START,
		`${TASK_RESULT_START}{invalid}${TASK_RESULT_END}`,
		`${TASK_RESULT_START}{"status":"waiting_for_user","status":"completed","taskNumber":2}${TASK_RESULT_END}`,
		`${TASK_RESULT_START}{"status":"completed","taskNumber":2,"taskNumber":2}${TASK_RESULT_END}`,
		...[
			null, [], { status: "completed" }, { status: "completed", taskNumber: "2" },
			{ status: "completed", taskNumber: 1 }, { status: "failed", taskNumber: 2 },
			{ status: "completed", taskNumber: 2, reason: "Awaiting approval" },
			{ status: "completed", taskNumber: 2, extra: true },
			{ status: "waiting_for_user", taskNumber: 2, reason: " " },
			{ status: "waiting_for_user", taskNumber: 2, reason: 42 },
			{ status: "waiting_for_user", taskNumber: 2, reason: "x".repeat(501) },
		].map(resultBlock),
	]) assert.equal(parseTaskResult(text, 2).status, "completion_unconfirmed", text);
});


test("continuation references the saved task and requires inspection instead of repeated side effects", () => {
	const prompt = buildTaskContinuationPrompt("saved task files/tasks.md", 2, { title: "Finish API" });
	assert.match(prompt, /Resume the unfinished task #2/);
	assert.match(prompt, /Read "saved task files\/tasks.md" and implement task #2/);
	assert.match(prompt, /Inspect already applied changes and existing verification results/);
	assert.match(prompt, /Finish only the outstanding work/);
	assert.match(prompt, /avoid repeating completed side effects/);
	assert.match(prompt, /Resume confirmation is not authorization/);
	assert.match(prompt, /Do not bypass permission rules/);
	assert.match(prompt, /automatically retry denied actions/);
	assert.match(prompt, /report waiting_for_user and stop/);
	assert.ok(prompt.endsWith(buildTaskFilePrompt("saved task files/tasks.md", 2, { title: "Finish API" })));
	assert.equal(prompt.split(TASK_RESULT_START).length, 2);
	assert.equal(prompt.split(TASK_RESULT_END).length, 2);
	assert.match(prompt, /"taskNumber":2/);
});
