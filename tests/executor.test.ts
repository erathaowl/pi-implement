import assert from "node:assert/strict";
import test from "node:test";
import { ActiveSessionExecutor, runPromptSequence, type TaskStatus } from "../src/executor.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("runs prompts strictly in order and waits for each prompt to complete", async () => {
	const started: string[] = [];
	const releases: Array<() => void> = [];
	const snapshots: TaskStatus[][] = [];
	const execution = runPromptSequence(
		["one", "two", "three"],
		(prompt) => {
			started.push(prompt);
			return new Promise<void>((resolve) => releases.push(resolve));
		},
		(statuses) => snapshots.push([...statuses]),
	);

	await tick();
	assert.deepEqual(started, ["one"]);
	releases.shift()?.();
	await tick();
	assert.deepEqual(started, ["one", "two"]);
	releases.shift()?.();
	await tick();
	assert.deepEqual(started, ["one", "two", "three"]);
	releases.shift()?.();

	const result = await execution;
	assert.equal(result.completed, true);
	assert.deepEqual(result.statuses, ["completed", "completed", "completed"]);
	assert.ok(snapshots.some((state) => state.includes("pending")));
	assert.ok(snapshots.some((state) => state.includes("running")));
	assert.deepEqual(snapshots.at(-1), ["completed", "completed", "completed"]);
});

test("marks a failed prompt and does not execute later prompts", async () => {
	const started: string[] = [];
	const result = await runPromptSequence(["one", "two", "three"], async (prompt) => {
		started.push(prompt);
		if (prompt === "two") throw new Error("turn failed");
	});

	assert.equal(result.completed, false);
	assert.equal(result.error?.message, "turn failed");
	assert.deepEqual(started, ["one", "two"]);
	assert.deepEqual(result.statuses, ["completed", "failed", "pending"]);
});

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
