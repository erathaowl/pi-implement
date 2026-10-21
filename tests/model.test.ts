import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	applyReviewSettings, assertReviewSettingsAvailable, selectImplementationSettings, selectReviewSettings,
	supportedThinkingLevels, type ImplementationModelController, type ImplementationSettings,
} from "../src/model.ts";

const implementationModel = { provider: "test", id: "implementation", reasoning: true };
const reviewModel = { provider: "test", id: "review", reasoning: true };
const implementation: ImplementationSettings = { implementationModel: { provider: implementationModel.provider, id: implementationModel.id }, implementationThinkingLevel: "medium" };

function runtime(options: {
	models?: Array<typeof implementationModel>;
	responses?: Array<string | undefined>;
	selectionOutcome?: boolean | Error;
	coerceThinking?: boolean;
} = {}) {
	let currentModel = implementationModel;
	let currentThinking = "medium";
	const models = options.models ?? [implementationModel, reviewModel];
	const responses = [...(options.responses ?? [])];
	const prompts: Array<{ title: string; choices: string[] }> = [];
	const warnings: string[] = [];
	const switches: string[] = [];
	const ctx = {
		get model() { return currentModel; },
		scopedModels: [{ model: implementationModel }],
		modelRegistry: {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		},
		ui: {
			async select(title: string, choices: string[]) {
				prompts.push({ title, choices });
				return responses.length ? responses.shift() : choices[0];
			},
			notify(message: string) { warnings.push(message); },
		},
	} as unknown as ExtensionCommandContext;
	const controller = {
		getThinkingLevel: () => currentThinking,
		async setModel(model: typeof implementationModel) {
			switches.push(model.id);
			if (options.selectionOutcome instanceof Error) throw options.selectionOutcome;
			if (options.selectionOutcome === false) return false;
			currentModel = model;
			return true;
		},
		setThinkingLevel(level: string) { currentThinking = options.coerceThinking ? "low" : level; },
	} as ImplementationModelController;
	return { ctx, controller, prompts, warnings, switches };
}

test("shared selectors preserve implementation defaults while review can choose an independent pair", async () => {
	const implementationRuntime = runtime();
	assert.deepEqual(await selectImplementationSettings(implementationRuntime.ctx, implementationRuntime.controller), implementation);
	assert.equal(implementationRuntime.prompts[0].title, "Implementation model for all tasks (current: test/implementation)");
	assert.deepEqual(implementationRuntime.prompts[0].choices, ["test/implementation"]);
	assert.equal(implementationRuntime.prompts[1].choices[0], "medium");
	const reviewRuntime = runtime({ responses: ["test/review", "high"] });
	assert.deepEqual(await selectReviewSettings(true, implementation, reviewRuntime.ctx), {
		enabled: true, model: { provider: "test", id: "review" }, thinkingLevel: "high",
	});
	assert.deepEqual(reviewRuntime.prompts[0].choices, ["test/implementation", "test/review"]);
	assert.deepEqual(reviewRuntime.switches, []);
	assert.equal(reviewRuntime.controller.getThinkingLevel(), "medium");
	assert.equal(reviewRuntime.ctx.model?.id, "implementation");
});

test("first review use proposes the implementation model and thinking without switching settings", async () => {
	const r = runtime();
	assert.deepEqual(await selectReviewSettings(true, implementation, r.ctx), {
		enabled: true, model: { provider: "test", id: "implementation" }, thinkingLevel: "medium",
	});
	assert.equal(r.prompts.length, 2);
	assert.deepEqual(r.switches, []);
});

test("a saved review pair is proposed ahead of the implementation pair", async () => {
	const r = runtime();
	const preferred = { model: reviewModel, thinkingLevel: "high" as const };
	const selected = await selectReviewSettings(true, implementation, r.ctx, preferred);
	assert.deepEqual(selected, { enabled: true, model: { provider: "test", id: "review" }, thinkingLevel: "high" });
	assert.equal(r.prompts[0].choices[0], "test/review");
	assert.equal(r.prompts[1].choices[0], "high");
	assert.deepEqual(r.warnings, []);
});

test("a stale review model requires explicit fallback choices", async () => {
	const r = runtime();
	await selectReviewSettings(true, implementation, r.ctx, { model: { provider: "missing", id: "model" }, thinkingLevel: "high" });
	assert.equal(r.prompts.length, 2);
	assert.equal(r.prompts[0].choices[0], "test/implementation");
	assert.equal(r.prompts[1].choices[0], "medium");
	assert.equal(r.warnings.length, 1);
});

test("an incompatible preferred thinking level falls back to a compatible explicit selection", async () => {
	const plainModel = { ...reviewModel, reasoning: false };
	const r = runtime({ models: [implementationModel, plainModel] });
	assert.deepEqual(await selectReviewSettings(true, implementation, r.ctx, { model: plainModel, thinkingLevel: "high" }), {
		enabled: true, model: { provider: "test", id: "review" }, thinkingLevel: "off",
	});
	assert.deepEqual(r.prompts[1].choices, ["off"]);
	assert.equal(r.warnings.length, 1);
});

for (const responses of [[undefined], ["test/review", undefined]]) {
	test(`review selection cancellation after ${responses.length} prompts never switches settings`, async () => {
		const r = runtime({ responses });
		assert.equal(await selectReviewSettings(true, implementation, r.ctx), undefined);
		assert.deepEqual(r.switches, []);
	});
}

test("disabled review neither enumerates models nor prompts", async () => {
	assert.deepEqual(await selectReviewSettings(false, implementation, {} as ExtensionCommandContext), { enabled: false });
});

test("review requires an available model and rejects unsupported UI responses", async () => {
	await assert.rejects(selectReviewSettings(true, implementation, runtime({ models: [] }).ctx), /No models are available/);
	await assert.rejects(selectReviewSettings(true, implementation, runtime({ responses: ["test/missing"] }).ctx), /Unknown review model/);
	await assert.rejects(selectReviewSettings(true, implementation, runtime({ responses: ["test/review", "xhigh"] }).ctx), /Unsupported review thinking/);
});

test("a saved model with no supported thinking levels falls back to an explicitly selected usable model", async () => {
	const unusable = { ...reviewModel, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null } };
	const r = runtime({ models: [implementationModel, unusable] });
	assert.deepEqual(await selectReviewSettings(true, implementation, r.ctx, { model: unusable, thinkingLevel: "high" }), {
		enabled: true, model: { provider: "test", id: "implementation" }, thinkingLevel: "medium",
	});
	assert.deepEqual(r.prompts[0].choices, ["test/implementation"]);
	assert.equal(r.prompts.length, 2);
	assert.equal(r.warnings.length, 1);
});

test("thinking choices honor model mappings, including opt-in extended levels", () => {
	assert.deepEqual(supportedThinkingLevels({ ...reviewModel, thinkingLevelMap: { medium: null, high: null, xhigh: "xhigh", max: "max" } } as never),
		["off", "minimal", "low", "xhigh", "max"]);
});

test("saved review settings are validated exactly without fallback or prompting", () => {
	const r = runtime();
	assertReviewSettingsAvailable({ enabled: true, model: reviewModel, thinkingLevel: "high" }, r.ctx);
	assert.throws(() => assertReviewSettingsAvailable({ enabled: true, model: { provider: "gone", id: "model" }, thinkingLevel: "high" }, r.ctx), /Cannot restore review model/);
	assert.throws(() => assertReviewSettingsAvailable({ enabled: true, model: reviewModel, thinkingLevel: "max" }, r.ctx), /Cannot restore review thinking level/);
	assert.deepEqual(r.prompts, []);
	assert.deepEqual(r.switches, []);
});

test("applying review settings restores the exact pair", async () => {
	const r = runtime();
	await applyReviewSettings({ model: reviewModel, thinkingLevel: "high" }, r.ctx, r.controller);
	assert.equal(r.ctx.model?.id, "review");
	assert.equal(r.controller.getThinkingLevel(), "high");
});

for (const options of [{ selectionOutcome: false }, { selectionOutcome: new Error("No credentials") }, { coerceThinking: true }]) {
	test(`review restoration reports ${Object.keys(options)[0]} instead of substituting settings`, async () => {
		const r = runtime(options);
		await assert.rejects(applyReviewSettings({ model: reviewModel, thinkingLevel: "high" }, r.ctx, r.controller), /Cannot use review/);
	});
}
