import assert from "node:assert/strict";
import test from "node:test";
import { compactIfNeeded, DEFAULT_COMPACTION_THRESHOLD_PERCENT } from "../src/compaction.ts";

function context(usage: { percent: number | null } | undefined) {
	let usageCalls = 0;
	const compactCalls: Array<{ onComplete?: (result: unknown) => void; onError?: (error: Error) => void }> = [];
	const workingMessages: Array<string | undefined> = [];
	const ctx = {
		getContextUsage() {
			usageCalls++;
			return usage ? { tokens: usage.percent, contextWindow: 100, percent: usage.percent } : undefined;
		},
		compact(options: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }) {
			compactCalls.push(options);
		},
		ui: {
			setWorkingMessage(message?: string) {
				workingMessages.push(message);
			},
		},
	};
	return { compactCalls, ctx, get usageCalls() { return usageCalls; }, workingMessages };
}

test("disabled compaction does not inspect context usage", async () => {
	const runtime = context({ percent: 90 });
	await compactIfNeeded(runtime.ctx as never, false, DEFAULT_COMPACTION_THRESHOLD_PERCENT, 2);
	assert.equal(runtime.usageCalls, 0);
	assert.equal(runtime.compactCalls.length, 0);
});

for (const [name, usage] of [
	["unavailable usage", undefined],
	["null usage", { percent: null }],
	["usage below threshold", { percent: 69 }],
	["usage exactly at threshold", { percent: 70 }],
] as const) {
	test(`${name} skips compaction`, async () => {
		const runtime = context(usage);
		await compactIfNeeded(runtime.ctx as never, true, DEFAULT_COMPACTION_THRESHOLD_PERCENT, 2);
		assert.equal(runtime.usageCalls, 1);
		assert.equal(runtime.compactCalls.length, 0);
	});
}

test("usage above threshold waits for compaction and restores the working message", async () => {
	const runtime = context({ percent: 74 });
	let settled = false;
	const compaction = compactIfNeeded(runtime.ctx as never, true, DEFAULT_COMPACTION_THRESHOLD_PERCENT, 3).then(
		() => {
			settled = true;
		},
	);

	await Promise.resolve();
	assert.equal(settled, false);
	assert.deepEqual(runtime.workingMessages, ["Compact context before task 3 (74%)"]);
	runtime.compactCalls[0].onComplete?.({});
	await compaction;
	assert.equal(settled, true);
	assert.deepEqual(runtime.workingMessages, ["Compact context before task 3 (74%)", undefined]);
});

test("compaction failure rejects and restores the working message", async () => {
	const runtime = context({ percent: 80 });
	const compaction = compactIfNeeded(runtime.ctx as never, true, DEFAULT_COMPACTION_THRESHOLD_PERCENT, 2);
	await Promise.resolve();
	runtime.compactCalls[0].onError?.(new Error("summary failed"));
	await assert.rejects(compaction, /summary failed/);
	assert.equal(runtime.workingMessages.at(-1), undefined);
});
