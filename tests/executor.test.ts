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

test("active-session executor rejects overlapping prompts", async () => {
	const executor = new ActiveSessionExecutor(() => {});
	const first = executor.execute("one");
	await assert.rejects(executor.execute("two"), /already running/);
	executor.cancel("cancelled");
	await assert.rejects(first, /cancelled/);
});
