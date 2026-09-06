import assert from "node:assert/strict";
import test from "node:test";
import {
	buildRewritePrompt,
	extractRewritePlan,
	REWRITE_EXTRACTION_PROMPT,
	validateRewritePlan,
} from "../src/rewrite.ts";

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

test("rewrite extraction uses the selected isolated model without tools or session messages", async () => {
	const markdown = "## Add API\nImplement the endpoint.";
	const activeSessionHistory = [{ role: "user", content: "existing conversation" }];
	const { calls, ctx, model } = extractionContext(
		response({ tasks: [{ title: "Add API", instructions: "Implement the endpoint." }] }),
	);

	const plan = await extractRewritePlan(markdown, ctx as never);

	assert.deepEqual(plan, {
		tasks: [{ title: "Add API", instructions: "Implement the endpoint." }],
	});
	assert.equal(calls.length, 1);
	const [calledModel, context, options] = calls[0] as [
		unknown,
		{ systemPrompt: string; messages: Array<{ content: Array<{ text: string }> }>; tools?: unknown },
		Record<string, unknown>,
	];
	assert.equal(calledModel, model);
	assert.equal(context.systemPrompt, REWRITE_EXTRACTION_PROMPT);
	assert.equal(context.messages.length, 1);
	assert.equal(context.messages[0].content[0].text, markdown);
	assert.equal("tools" in context, false);
	assert.equal("toolChoice" in options, false);
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
	test(`rewrite preserves model task order for ${style} Markdown`, async () => {
		const expected = {
			tasks: [
				{ title: "First", instructions: "Do the first task." },
				{ title: "Second", instructions: "Do the second task." },
			],
		};
		const { ctx } = extractionContext(response(expected));
		assert.deepEqual(await extractRewritePlan(markdown, ctx as never), expected);
	});
}

test("rewrite prompt propagates applicable shared requirements into each task", () => {
	assert.match(REWRITE_EXTRACTION_PROMPT, /document-level constraints/);
	assert.match(REWRITE_EXTRACTION_PROMPT, /acceptance criteria/);
	assert.match(REWRITE_EXTRACTION_PROMPT, /Repeat each applicable shared requirement in every affected task/);
});

test("rewrite builds a self-contained active-session prompt", () => {
	const prompt = buildRewritePrompt({ title: "Two", instructions: "Implement two." });
	assert.match(prompt, /Title:\nTwo/);
	assert.match(prompt, /Instructions:\nImplement two\./);
	assert.match(prompt, /Complete only this task/);
});

test("rewrite accepts a JSON fenced response", async () => {
	const { ctx } = extractionContext(
		response('```json\n{"tasks":[{"title":"Test","instructions":"Add tests."}]}\n```'),
	);
	assert.deepEqual(await extractRewritePlan("Add tests", ctx as never), {
		tasks: [{ title: "Test", instructions: "Add tests." }],
	});
});

test("rewrite validation rejects invalid and empty tasks", () => {
	assert.throws(() => validateRewritePlan({ tasks: [] }), /No implementation tasks/);
	assert.throws(
		() => validateRewritePlan({ tasks: [{ title: "", instructions: "Do it" }] }),
		/empty title/,
	);
	assert.throws(
		() => validateRewritePlan({ tasks: [{ title: "Do it", instructions: "" }] }),
		/empty instructions/,
	);
});

test("rewrite reports malformed output and model failures", async () => {
	const malformed = extractionContext(response("not json"));
	await assert.rejects(extractRewritePlan("Do something", malformed.ctx as never), /invalid JSON/);

	const failed = extractionContext({
		content: [{ type: "text", text: "" }],
		stopReason: "error",
		errorMessage: "provider unavailable",
	});
	await assert.rejects(extractRewritePlan("Do something", failed.ctx as never), /provider unavailable/);
});
