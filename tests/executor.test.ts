import assert from "node:assert/strict";
import test from "node:test";
import { ActiveSessionExecutor } from "../src/executor.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("active-session execution settles only after agent_settled", async () => {
	const sent: string[] = [];
	const executor = new ActiveSessionExecutor((message) => sent.push(message));
	let completed = false;
	const execution = executor.execute("implement one").then(() => {
		completed = true;
	});

	executor.onAgentStart();
	executor.onAgentEnd([{ role: "assistant", stopReason: "stop" }]);
	await tick();
	assert.equal(completed, false);

	executor.onAgentSettled();
	await execution;
	assert.equal(completed, true);
	assert.deepEqual(sent, ["implement one"]);
});

test("active-session execution treats every non-stop reason, including toolUse, as failure", async () => {
	for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
		const executor = new ActiveSessionExecutor(() => {});
		const execution = executor.execute("implement one");
		executor.onAgentStart();
		executor.onAgentEnd([{ role: "assistant", stopReason, errorMessage: "provider failed" }]);
		executor.onAgentSettled();
		await assert.rejects(execution);
	}
});

test("text execution extracts only the settled final assistant text blocks", async () => {
	const executor = new ActiveSessionExecutor(() => {});
	const execution = executor.executeForText("review one");
	executor.onAgentStart();
	executor.onAgentEnd([{ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Intermediate text" }] }]);
	executor.onAgentEnd([
		{ role: "assistant", stopReason: "stop", content: [
			{ type: "thinking", thinking: "Do not expose reasoning" },
			{ type: "text", text: "Final summary" }, { type: "text", text: "Final JSON" },
		] },
		{ role: "toolResult", content: [{ type: "text", text: "Ignore tool output" }] },
	]);
	executor.onAgentSettled();
	assert.equal(await execution, "Final summary\nFinal JSON");
});

for (const content of [undefined, [], [{ type: "thinking", thinking: "No final answer" }], [{ type: "text", text: " " }]]) {
	test("text execution rejects a successful stop without final text while task execution remains compatible", async () => {
		const executor = new ActiveSessionExecutor(() => {});
		const execution = executor.executeForText("review one");
		executor.onAgentStart();
		executor.onAgentEnd([{ role: "assistant", stopReason: "stop", content }]);
		executor.onAgentSettled();
		await assert.rejects(execution, /without final assistant text/);
		const task = executor.execute("implement one");
		executor.onAgentStart();
		executor.onAgentEnd([{ role: "assistant", stopReason: "stop", content }]);
		executor.onAgentSettled();
		assert.equal(await task, undefined);
	});
}

test("text and task execution share overlap guards and cancellation", async () => {
	const executor = new ActiveSessionExecutor(() => {});
	const review = executor.executeForText("review one");
	await assert.rejects(executor.execute("implement one"), /already running/);
	await assert.rejects(executor.executeForText("review two"), /already running/);
	executor.cancel("Session changed");
	await assert.rejects(review, /Session changed/);
});

test("text execution uses the last lifecycle response rather than an earlier successful report", async () => {
	const executor = new ActiveSessionExecutor(() => {});
	const execution = executor.executeForText("review one");
	executor.onAgentStart();
	executor.onAgentEnd([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Earlier success" }] }]);
	executor.onAgentEnd([{ role: "assistant", stopReason: "error", errorMessage: "Final attempt failed" }]);
	executor.onAgentSettled();
	await assert.rejects(execution, /Final attempt failed/);
});

test("active-session executor rejects overlapping prompts", async () => {
	const executor = new ActiveSessionExecutor(() => {});
	const first = executor.execute("one");
	await assert.rejects(executor.execute("two"), /already running/);
	executor.cancel("cancelled");
	await assert.rejects(first, /cancelled/);
});
