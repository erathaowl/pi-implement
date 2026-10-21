import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type ImplementationThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelThinkingSettings {
	model: { provider: string; id: string };
	thinkingLevel: ImplementationThinkingLevel;
}

export interface ImplementationSettings {
	implementationModel: { provider: string; id: string };
	implementationThinkingLevel: ImplementationThinkingLevel;
}

export type ImplementationModelController = Pick<ExtensionAPI, "getThinkingLevel" | "setModel" | "setThinkingLevel">;
type SessionModel = NonNullable<ExtensionCommandContext["model"]>;
type IsolatedModelContext = Pick<ExtensionCommandContext, "model" | "modelRegistry" | "thinkingLevel">;

const THINKING_LEVELS: readonly ImplementationThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function isImplementationThinkingLevel(value: unknown): value is ImplementationThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function modelsMatch(left: { provider: string; id: string } | undefined, right: { provider: string; id: string }): boolean {
	return left?.provider === right.provider && left.id === right.id;
}

export function supportedThinkingLevels(model: SessionModel): ImplementationThinkingLevel[] {
	if (!model.reasoning) {
		return ["off"];
	}
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		return mapped !== null && (level !== "xhigh" && level !== "max" || mapped !== undefined);
	});
}

async function selectModelThinking(
	ctx: ExtensionCommandContext,
	models: SessionModel[],
	preferred: ModelThinkingSettings,
	purpose: "implementation" | "review",
): Promise<ModelThinkingSettings | undefined> {
	const modelsByKey = new Map(models.map((model) => [modelKey(model), model]));
	const key = modelKey(preferred.model);
	const modelChoices = [...modelsByKey.keys()];
	if (modelsByKey.has(key)) {
		modelChoices.splice(modelChoices.indexOf(key), 1);
		modelChoices.unshift(key);
	}
	const selectedKey = await ctx.ui.select(
		purpose === "implementation" ? `Implementation model for all tasks (default: ${key})` : `Review model (default: ${key})`,
		modelChoices,
	);
	if (!selectedKey) return undefined;
	const selectedModel = modelsByKey.get(selectedKey);
	if (!selectedModel) throw new Error(`Unknown ${purpose} model: ${selectedKey}`);
	const levels = supportedThinkingLevels(selectedModel);
	if (!levels.length) throw new Error(`No supported thinking levels for ${purpose} model ${selectedKey}.`);
	const defaultLevel = preferred.thinkingLevel;
	const choices = levels.includes(defaultLevel) ? [defaultLevel, ...levels.filter((level) => level !== defaultLevel)] : levels;
	const thinkingLevel = await ctx.ui.select(
		purpose === "implementation" ? `Thinking level for all implementation tasks (default: ${choices[0]})` : `Review thinking level (default: ${choices[0]})`,
		choices,
	);
	if (!thinkingLevel) return undefined;
	if (!isImplementationThinkingLevel(thinkingLevel) || !levels.includes(thinkingLevel)) {
		throw new Error(`Unsupported ${purpose} thinking level: ${thinkingLevel}`);
	}
	return { model: { provider: selectedModel.provider, id: selectedModel.id }, thinkingLevel };
}

export async function selectImplementationSettings(
	ctx: ExtensionCommandContext,
	controller: ImplementationModelController,
	preferred?: ModelThinkingSettings,
): Promise<ImplementationSettings | undefined> {
	if (!ctx.model) throw new Error("No model is selected.");
	const currentModel = ctx.model;
	const available = ctx.modelRegistry.getAvailable();
	const scopedOrAvailable = ctx.scopedModels.length > 0
		? ctx.scopedModels.map(({ model }) => model).filter((model) => available.some((candidate) => modelsMatch(candidate, model))) : available;
	const models = [currentModel, ...scopedOrAvailable.filter((model) => !modelsMatch(model, currentModel))]
		.filter((model) => supportedThinkingLevels(model).length > 0);
	if (!models.length) throw new Error("No implementation models have supported thinking levels.");
	const savedModel = preferred && models.find((model) => modelsMatch(model, preferred.model) && available.some((candidate) => modelsMatch(candidate, model)));
	const useSaved = savedModel && preferred && supportedThinkingLevels(savedModel).includes(preferred.thinkingLevel);
	if (preferred && !useSaved) {
		ctx.ui.notify("The saved implementation model or thinking level is unavailable or outside the model scope. Select a compatible current-session pair explicitly.", "warning");
	}
	const model = useSaved ? savedModel : models.find((model) => modelsMatch(model, currentModel)) ?? models[0];
	const levels = supportedThinkingLevels(model);
	const currentThinking = controller.getThinkingLevel() as ImplementationThinkingLevel;
	const thinkingLevel = useSaved ? preferred.thinkingLevel : levels.includes(currentThinking) ? currentThinking : levels[0];
	if (!useSaved && (model !== currentModel || thinkingLevel !== currentThinking)) {
		ctx.ui.notify("The current implementation settings are incompatible. Select a supported model and thinking level explicitly.", "warning");
	}
	const settings = await selectModelThinking(ctx, models, { model, thinkingLevel }, "implementation");
	return settings ? { implementationModel: settings.model, implementationThinkingLevel: settings.thinkingLevel } : undefined;
}

export async function selectReviewSettings(
	enabled: boolean,
	implementation: ImplementationSettings,
	ctx: ExtensionCommandContext,
	preferred?: ModelThinkingSettings,
): Promise<({ enabled: true } & ModelThinkingSettings) | { enabled: false } | undefined> {
	if (!enabled) return { enabled: false };
	const models = ctx.modelRegistry.getAvailable().filter((model) => supportedThinkingLevels(model).length > 0);
	if (!models.length) throw new Error("No models are available for final review with supported thinking levels.");
	const implementationPair = { model: implementation.implementationModel, thinkingLevel: implementation.implementationThinkingLevel };
	const savedModel = preferred && models.find((model) => modelsMatch(model, preferred.model));
	if (preferred && (!savedModel || !supportedThinkingLevels(savedModel).includes(preferred.thinkingLevel))) {
		ctx.ui.notify("The saved review model or thinking level is unavailable. Select an available review pair explicitly.", "warning");
	}
	const model = savedModel || models.find((model) => modelsMatch(model, implementationPair.model)) || models[0];
	const levels = supportedThinkingLevels(model);
	const thinkingLevel = savedModel && preferred && levels.includes(preferred.thinkingLevel) ? preferred.thinkingLevel
		: levels.includes(implementationPair.thinkingLevel) ? implementationPair.thinkingLevel : levels[0];
	if (!thinkingLevel) throw new Error(`No supported thinking levels for review model ${modelKey(model)}.`);
	const selected = await selectModelThinking(ctx, models, { model, thinkingLevel }, "review");
	return selected ? { enabled: true, ...selected } : undefined;
}

export function assertReviewSettingsAvailable(
	settings: { enabled: false } | ({ enabled: true } & ModelThinkingSettings),
	ctx: ExtensionCommandContext,
): void {
	if (!settings.enabled) return;
	const model = ctx.modelRegistry.getAvailable().find((candidate) => modelsMatch(candidate, settings.model));
	if (!model) throw new Error(`Cannot restore review model ${JSON.stringify(modelKey(settings.model))}: the model is not available.`);
	if (!supportedThinkingLevels(model).includes(settings.thinkingLevel)) {
		throw new Error(`Cannot restore review thinking level ${JSON.stringify(settings.thinkingLevel)} with model ${JSON.stringify(modelKey(settings.model))}.`);
	}
}

async function applyModelThinking(
	settings: ModelThinkingSettings,
	ctx: ExtensionCommandContext,
	controller: ImplementationModelController,
	purpose: "implementation" | "review",
): Promise<void> {
	const key = modelKey(settings.model);
	const model = ctx.modelRegistry.find(settings.model.provider, settings.model.id);
	if (!model) throw new Error(`Cannot use ${purpose} model ${JSON.stringify(key)}: the model is not available.`);
	if (!supportedThinkingLevels(model).includes(settings.thinkingLevel)) {
		throw new Error(`Cannot use ${purpose} thinking level ${JSON.stringify(settings.thinkingLevel)} with model ${JSON.stringify(key)}.`);
	}
	let selected: boolean;
	try {
		selected = await controller.setModel(model);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot use ${purpose} model ${JSON.stringify(key)}: ${detail}`);
	}
	if (!selected || !modelsMatch(ctx.model, settings.model)) {
		throw new Error(`Cannot use ${purpose} model ${JSON.stringify(key)}: model selection failed.`);
	}
	controller.setThinkingLevel(settings.thinkingLevel);
	const effectiveLevel = controller.getThinkingLevel();
	if (effectiveLevel !== settings.thinkingLevel) {
		throw new Error(`Cannot use ${purpose} thinking level ${JSON.stringify(settings.thinkingLevel)} with model ${JSON.stringify(key)} (effective level: ${JSON.stringify(effectiveLevel)}).`);
	}
}

export async function applyImplementationSettings(
	settings: ImplementationSettings,
	ctx: ExtensionCommandContext,
	controller: ImplementationModelController,
): Promise<void> {
	await applyModelThinking({ model: settings.implementationModel, thinkingLevel: settings.implementationThinkingLevel }, ctx, controller, "implementation");
}

export async function applyReviewSettings(
	settings: ModelThinkingSettings,
	ctx: ExtensionCommandContext,
	controller: ImplementationModelController,
): Promise<void> {
	assertReviewSettingsAvailable({ enabled: true, ...settings }, ctx);
	await applyModelThinking(settings, ctx, controller, "review");
}

export function assertImplementationSettings(
	settings: ImplementationSettings,
	ctx: ExtensionCommandContext,
	controller: ImplementationModelController,
): void {
	if (!modelsMatch(ctx.model, settings.implementationModel) || controller.getThinkingLevel() !== settings.implementationThinkingLevel) {
		throw new Error(
			`Implementation model or thinking level changed. Expected ${modelKey(settings.implementationModel)} with thinking ${settings.implementationThinkingLevel}.`,
		);
	}
}

type ModelResponse = {
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
};

function responseText(response: ModelResponse): string {
	if (!Array.isArray(response.content)) {
		return "";
	}

	return response.content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();
}

export async function completeIsolatedText(
	systemPrompt: string,
	input: string,
	ctx: IsolatedModelContext,
	operation: string,
): Promise<string> {
	if (!ctx.model) {
		throw new Error("No model is selected.");
	}

	const response = (await ctx.modelRegistry.complete(
		ctx.model,
		{
			systemPrompt,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: input }],
					timestamp: Date.now(),
				},
			],
		},
		{ cacheRetention: "none", reasoning: ctx.thinkingLevel },
	)) as ModelResponse;

	if (response.stopReason !== "stop") {
		const detail = response.errorMessage?.trim() || response.stopReason || "unknown error";
		throw new Error(`${operation} failed: ${detail}`);
	}

	const text = responseText(response);
	if (!text) {
		throw new Error(`${operation} returned no content.`);
	}
	return text;
}

export function parseJsonResponse(text: string, operation: string): unknown {
	let json = text.trim();
	const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(json);
	if (fenced) {
		json = fenced[1].trim();
	}

	try {
		return JSON.parse(json);
	} catch {
		throw new Error(`${operation} returned invalid JSON.`);
	}
}
