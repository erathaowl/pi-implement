import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type IsolatedModelContext = Pick<ExtensionCommandContext, "model" | "modelRegistry">;

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
		{ cacheRetention: "none" },
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
