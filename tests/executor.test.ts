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

const completion = '<<<PI_IMPLEMENT_TASK_RESULT>>>\n{"status":"completed","taskNumber":1}\n<<<END_PI_IMPLEMENT_TASK_RESULT>>>';
const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text }] });

test("executeTask waits for settlement and validates the final assistant result only", async () => {
	const executor = new ActiveSessionExecutor(() => {});
	let resolved = false;
	const execution = executor.executeTask("task", 1).then((result) => { resolved = true; return result; });
	executor.onAgentStart();
	executor.onAgentEnd([assistant(completion)]);
	await tick();
	assert.equal(resolved, false);
	executor.onAgentSettled();
	assert.deepEqual(await execution, { status: "completed", taskNumber: 1 });
});

test("executeTask does not accept bare stops, earlier reports, or tool output as completion", async () => {
	for (const messages of [
		[{ role: "assistant", stopReason: "stop" }],
		[assistant(completion), assistant("Please authorize the tool.")],
		[assistant(""), { role: "toolResult", content: [{ type: "text", text: completion }] }],
		[assistant(completion.replace('"taskNumber":1', '"taskNumber":2'))],
		[assistant("<<<PI_IMPLEMENT_TASK_RESULT>>>bad JSON<<<END_PI_IMPLEMENT_TASK_RESULT>>>")],
	]) {
		const executor = new ActiveSessionExecutor(() => {});
		const execution = executor.executeTask("task", 1);
		executor.onAgentStart();
		executor.onAgentEnd([assistant(completion)]);
		executor.onAgentEnd(messages);
		executor.onAgentSettled();
		assert.equal((await execution).status, "completion_unconfirmed");
	}
});

test("executeTask returns a waiting outcome without claiming success", async () => {
	const executor = new ActiveSessionExecutor(() => {});
	const execution = executor.executeTask("task", 1);
	executor.onAgentStart();
	executor.onAgentEnd([assistant(completion.replace('"completed"', '"waiting_for_user"'))]);
	executor.onAgentSettled();
	assert.deepEqual(await execution, { status: "waiting_for_user", taskNumber: 1 });
});

test("executeTask rejects unsuccessful lifecycle outcomes even with a completion block", async () => {
	for (const stopReason of ["error", "length", "aborted", "toolUse", "stop"]) {
		const executor = new ActiveSessionExecutor(() => {});
		const execution = executor.executeTask("task", 1);
		executor.onAgentStart();
		executor.onAgentEnd([assistant(completion, stopReason)]);
		executor.onAgentSettled({ aborted: stopReason === "stop" });
		await assert.rejects(execution);
	}
});

test("executeTask preserves overlap guards, cancellation, and validates task numbers", async () => {
	const executor = new ActiveSessionExecutor(() => {});
	await assert.rejects(executor.executeTask("task", 0), /Invalid task number/);
	const execution = executor.executeTask("task", 1);
	await assert.rejects(executor.executeForText("review"), /already running/);
	await assert.rejects(executor.executeTask("task", 2), /already running/);
	executor.cancel("Session shut down");
	await assert.rejects(execution, /Session shut down/);
});
