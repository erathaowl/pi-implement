import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isImplementationThinkingLevel, selectReviewSettings, type ImplementationSettings, type ModelThinkingSettings } from "./model.ts";

export const PREFERENCES_FILE_NAME = "pi-implement-preferences.json";

function validPair(value: unknown): value is ModelThinkingSettings {
	if (typeof value !== "object" || value === null) return false;
	const pair = value as Partial<ModelThinkingSettings>;
	return typeof pair.model === "object" && pair.model !== null &&
		typeof pair.model.provider === "string" && pair.model.provider.trim().length > 0 &&
		typeof pair.model.id === "string" && pair.model.id.trim().length > 0 &&
		isImplementationThinkingLevel(pair.thinkingLevel);
}

export async function loadReviewPreference(agentDir = getAgentDir()): Promise<ModelThinkingSettings | undefined> {
	const path = join(agentDir, PREFERENCES_FILE_NAME);
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error(`Unable to read review preferences: ${path}`);
	}
	try {
		const saved: unknown = JSON.parse(content);
		if (typeof saved !== "object" || saved === null || !("version" in saved) || saved.version !== 1 ||
			!("review" in saved) || !validPair(saved.review)) return undefined;
		return { model: { provider: saved.review.model.provider, id: saved.review.model.id }, thinkingLevel: saved.review.thinkingLevel };
	} catch {
		// Malformed preferences are not recovery state: require a fresh explicit selection instead.
		return undefined;
	}
}

export async function selectPreferredReviewSettings(
	enabled: boolean,
	implementation: ImplementationSettings,
	ctx: ExtensionCommandContext,
	agentDir?: string,
) {
	if (!enabled) return { enabled: false as const };
	return selectReviewSettings(true, implementation, ctx, await loadReviewPreference(agentDir));
}

// Call only after the execution summary has been confirmed, never during option selection or resume.
export async function saveReviewPreference(pair: ModelThinkingSettings, agentDir = getAgentDir()): Promise<void> {
	if (!validPair(pair)) throw new Error("Invalid review model/thinking preference.");
	const path = join(agentDir, PREFERENCES_FILE_NAME);
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		await mkdir(agentDir, { recursive: true });
		await writeFile(temporaryPath, `${JSON.stringify({ version: 1, review: { model: { provider: pair.model.provider, id: pair.model.id }, thinkingLevel: pair.thinkingLevel } }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temporaryPath, path);
	} catch {
		throw new Error(`Unable to save review preferences: ${path}`);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => {});
	}
}
