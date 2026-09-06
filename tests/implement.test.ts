import assert from "node:assert/strict";
import test from "node:test";
import {
	ActiveSessionTaskExecutor,
	buildImplementationPrompt,
	formatProgress,
	runImplementationPlan,
	type TaskStatus,
} from "../src/implement.ts";
import type { ImplementationPlan } from "../src/tasks.ts";

const plan: ImplementationPlan = {
	tasks: [
		{ title: "One", instructions: "Implement one." },
		{ title: "Two", instructions: "Implement two." },
		{ title: "Three", instructions: "Implement three." },
	],
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("executes tasks in order and waits for each complete task promise", async () => {
	const started: string[] = [];
	const releases: Array<() => void> = [];
	const snapshots: TaskStatus[][] = [];
	const execution = runImplementationPlan(
		plan,
		(task) => {
			started.push(task.title);
			return new Promise<void>((resolve) => releases.push(resolve));
		},
		(statuses) => snapshots.push([...statuses]),
	);

	await tick();
	assert.deepEqual(started, ["One"]);
	releases.shift()?.();
	await tick();
	assert.deepEqual(started, ["One", "Two"]);
	releases.shift()?.();
	await tick();
	assert.deepEqual(started, ["One", "Two", "Three"]);
	releases.shift()?.();

	const result = await execution;
	assert.equal(result.completed, true);
	assert.deepEqual(result.statuses, ["completed", "completed", "completed"]);
	assert.ok(snapshots.some((state) => state.includes("pending")));
	assert.ok(snapshots.some((state) => state.includes("running")));
	assert.deepEqual(snapshots.at(-1), ["completed", "completed", "completed"]);
});

test("marks a failed task and does not execute later tasks", async () => {
	const started: string[] = [];
	const snapshots: TaskStatus[][] = [];
	const result = await runImplementationPlan(
		plan,
		async (task) => {
			started.push(task.title);
			if (task.title === "Two") throw new Error("turn failed");
		},
		(statuses) => snapshots.push([...statuses]),
	);

	assert.equal(result.completed, false);
	assert.equal(result.error?.message, "turn failed");
	assert.deepEqual(started, ["One", "Two"]);
	assert.deepEqual(result.statuses, ["completed", "failed", "pending"]);
	assert.deepEqual(snapshots.at(-1), ["completed", "failed", "pending"]);
});

test("active-session execution settles only on agent_settled", async () => {
	const sent: string[] = [];
	const executor = new ActiveSessionTaskExecutor((message) => sent.push(message));
	let completed = false;
	const execution = executor.execute(plan.tasks[0]).then(() => {
		completed = true;
	});

	executor.onAgentStart();
	executor.onAgentEnd([{ role: "assistant", stopReason: "stop" }]);
	await tick();
	assert.equal(completed, false);

	executor.onAgentSettled();
	await execution;
	assert.equal(completed, true);
	assert.equal(sent.length, 1);
	assert.match(sent[0], /Title:\nOne/);
	assert.match(sent[0], /Complete only this task/);
});

test("active-session lifecycle treats every non-stop reason, including toolUse, as failure", async () => {
	for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
		const executor = new ActiveSessionTaskExecutor(() => {});
		const execution = executor.execute(plan.tasks[0]);
		executor.onAgentStart();
		executor.onAgentEnd([{ role: "assistant", stopReason, errorMessage: "provider failed" }]);
		executor.onAgentSettled();
		await assert.rejects(execution);
	}
});

test("implementation prompt contains only the selected task and workflow guardrails", () => {
	const prompt = buildImplementationPrompt(plan.tasks[1]);
	assert.match(prompt, /Two/);
	assert.match(prompt, /Implement two\./);
	assert.doesNotMatch(prompt, /Three/);
	assert.match(prompt, /Do not start subsequent tasks/);
});

test("progress formatting exposes pending, running, completed, and failed states", () => {
	const lines = formatProgress(plan, ["completed", "running", "failed"]);
	assert.ok(lines.some((line) => line.includes("✓") && line.includes("One")));
	assert.ok(lines.some((line) => line.includes("●") && line.includes("Two")));
	assert.ok(lines.some((line) => line.includes("✗") && line.includes("Three")));

	const pending = formatProgress(plan, ["pending", "pending", "pending"]);
	assert.ok(pending.slice(1).every((line) => line.includes("○")));
});
