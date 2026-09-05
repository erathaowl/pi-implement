import assert from "node:assert/strict";
import test from "node:test";
import {
	extractImplementationPlan,
	TASK_EXTRACTION_PROMPT,
	validateImplementationPlan,
} from "../src/tasks.ts";

function response(value: unknown, stopReason = "stop") {
	return {
		content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
		stopReason,
	};
}

function extractionContext(result: unknown) {
	const model = { provider: "test", id: "selected-model" };
	const calls: unknown[][] = [];
	const ctx = {
		model,
		modelRegistry: {
			async complete(...args: unknown[]) {
				calls.push(args);
				return result;
			},
		},
	};
	return { calls, ctx, model };
}

test("extraction uses the selected standalone model boundary without tools or session messages", async () => {
	const markdown = "## Add API\nImplement the endpoint.";
	const activeSessionHistory = [{ role: "user", content: "existing conversation" }];
	const { calls, ctx, model } = extractionContext(
		response({ tasks: [{ title: "Add API", instructions: "Implement the endpoint." }] }),
	);

	const plan = await extractImplementationPlan(markdown, ctx as never);

	assert.deepEqual(plan, {
		tasks: [{ title: "Add API", instructions: "Implement the endpoint." }],
	});
	assert.equal(calls.length, 1);
	const [calledModel, context, options] = calls[0] as [
		unknown,
		{ systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }>; tools?: unknown },
		{ toolChoice?: string; cacheRetention?: string },
	];
	assert.equal(calledModel, model);
	assert.equal(context.systemPrompt, TASK_EXTRACTION_PROMPT);
	assert.equal(context.messages.length, 1);
	assert.equal(context.messages[0].content[0].text, markdown);
	assert.equal("tools" in context, false);
	assert.equal(options.toolChoice, "none");
	assert.equal(options.cacheRetention, "none");
	assert.deepEqual(activeSessionHistory, [{ role: "user", content: "existing conversation" }]);
});

for (const [style, markdown] of [
	["heading-based", "## Add API\nImplement the endpoint.\n## Add tests\nCover the endpoint."],
	["checklist", "- [ ] Add endpoint\n- [ ] Add validation\n- [ ] Update tests"],
	[
		"prose",
		"First add the configuration settings. Then implement the middleware. Finally update the documentation.",
	],
] as const) {
	test(`preserves model task order for ${style} Markdown`, async () => {
		const expected = {
			tasks: [
				{ title: "First", instructions: "Do the first task." },
				{ title: "Second", instructions: "Do the second task." },
			],
		};
		const { ctx } = extractionContext(response(expected));

		assert.deepEqual(await extractImplementationPlan(markdown, ctx as never), expected);
	});
}

test("accepts a JSON fenced response", async () => {
	const { ctx } = extractionContext(
		response('```json\n{"tasks":[{"title":"Test","instructions":"Add tests."}]}\n```'),
	);

	assert.deepEqual(await extractImplementationPlan("Add tests", ctx as never), {
		tasks: [{ title: "Test", instructions: "Add tests." }],
	});
});

test("rejects empty task lists", () => {
	assert.throws(() => validateImplementationPlan({ tasks: [] }), /No implementation tasks/);
});

test("rejects empty task titles", () => {
	assert.throws(
		() => validateImplementationPlan({ tasks: [{ title: "  ", instructions: "Do it" }] }),
		/empty title/,
	);
});

test("rejects empty task instructions", () => {
	assert.throws(
		() => validateImplementationPlan({ tasks: [{ title: "Do it", instructions: "" }] }),
		/empty instructions/,
	);
});

test("rejects malformed structured output", async () => {
	const { ctx } = extractionContext(response("not json"));
	await assert.rejects(extractImplementationPlan("Do something", ctx as never), /invalid JSON/);
});

test("reports standalone model failures", async () => {
	const { ctx } = extractionContext({
		content: [{ type: "text", text: "" }],
		stopReason: "error",
		errorMessage: "provider unavailable",
	});
	await assert.rejects(extractImplementationPlan("Do something", ctx as never), /provider unavailable/);
});

test("requires a selected model", async () => {
	const ctx = { model: undefined, modelRegistry: { complete: () => assert.fail("must not be called") } };
	await assert.rejects(extractImplementationPlan("Do something", ctx as never), /No model is selected/);
});
