import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type ImplementationThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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

function supportedThinkingLevels(model: SessionModel): ImplementationThinkingLevel[] {
	if (!model.reasoning) {
		return ["off"];
	}
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		return mapped !== null && (level !== "xhigh" && level !== "max" || mapped !== undefined);
	});
}

export async function selectImplementationSettings(
	ctx: ExtensionCommandContext,
	controller: ImplementationModelController,
): Promise<ImplementationSettings | undefined> {
	if (!ctx.model) {
		throw new Error("No model is selected.");
	}

	const currentModel = ctx.model;
	const scopedOrAvailable = ctx.scopedModels.length > 0
		? ctx.scopedModels.map(({ model }) => model)
		: ctx.modelRegistry.getAvailable();
	const models = [currentModel, ...scopedOrAvailable.filter((model) => !modelsMatch(model, currentModel))];
	const modelsByKey = new Map(models.map((model) => [modelKey(model), model]));
	const selectedModelKey = await ctx.ui.select(
		`Implementation model for all tasks (current: ${modelKey(currentModel)})`,
		[...modelsByKey.keys()],
	);
	if (!selectedModelKey) {
		return undefined;
	}

	const selectedModel = modelsByKey.get(selectedModelKey);
	if (!selectedModel) {
		throw new Error(`Unknown implementation model: ${selectedModelKey}`);
	}

	const currentThinkingLevel = controller.getThinkingLevel() as ImplementationThinkingLevel;
	const supportedLevels = supportedThinkingLevels(selectedModel);
	const thinkingChoices = supportedLevels.includes(currentThinkingLevel)
		? [currentThinkingLevel, ...supportedLevels.filter((level) => level !== currentThinkingLevel)]
		: supportedLevels;
	const implementationThinkingLevel = await ctx.ui.select(
		`Thinking level for all implementation tasks (current: ${currentThinkingLevel})`,
		thinkingChoices,
	);
	if (!implementationThinkingLevel) {
		return undefined;
	}
	if (!isImplementationThinkingLevel(implementationThinkingLevel)) {
		throw new Error(`Unknown implementation thinking level: ${implementationThinkingLevel}`);
	}

	return {
		implementationModel: { provider: selectedModel.provider, id: selectedModel.id },
		implementationThinkingLevel,
	};
}

export async function applyImplementationSettings(
	settings: ImplementationSettings,
	ctx: ExtensionCommandContext,
	controller: ImplementationModelController,
): Promise<void> {
	const key = modelKey(settings.implementationModel);
	const model = ctx.modelRegistry.find(settings.implementationModel.provider, settings.implementationModel.id);
	if (!model) {
		throw new Error(`Cannot use implementation model ${JSON.stringify(key)}: the model is not available.`);
	}

	let selected: boolean;
	try {
		selected = await controller.setModel(model);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot use implementation model ${JSON.stringify(key)}: ${detail}`);
	}
	if (!selected || !modelsMatch(ctx.model, settings.implementationModel)) {
		throw new Error(`Cannot use implementation model ${JSON.stringify(key)}: model selection failed.`);
	}

	controller.setThinkingLevel(settings.implementationThinkingLevel);
	const effectiveLevel = controller.getThinkingLevel();
	if (effectiveLevel !== settings.implementationThinkingLevel) {
		throw new Error(
			`Cannot use implementation thinking level ${JSON.stringify(settings.implementationThinkingLevel)} with model ${JSON.stringify(key)} (effective level: ${JSON.stringify(effectiveLevel)}).`,
		);
	}
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
