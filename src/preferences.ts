import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	isImplementationThinkingLevel, selectImplementationSettings, selectReviewSettings,
	type ImplementationModelController, type ImplementationSettings, type ModelThinkingSettings,
} from "./model.ts";

export const PREFERENCES_FILE_NAME = "pi-implement-preferences.json";

function validPair(value: unknown): value is ModelThinkingSettings {
	if (typeof value !== "object" || value === null) return false;
	const pair = value as Partial<ModelThinkingSettings>;
	return typeof pair.model === "object" && pair.model !== null &&
		typeof pair.model.provider === "string" && pair.model.provider.trim().length > 0 &&
		typeof pair.model.id === "string" && pair.model.id.trim().length > 0 &&
		isImplementationThinkingLevel(pair.thinkingLevel);
}

function copyPair(pair: ModelThinkingSettings): ModelThinkingSettings {
	return { model: { provider: pair.model.provider, id: pair.model.id }, thinkingLevel: pair.thinkingLevel };
}

async function readPreferences(agentDir: string): Promise<Record<string, unknown>> {
	const path = join(agentDir, PREFERENCES_FILE_NAME);
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { version: 1 };
		throw new Error(`Unable to read preferences: ${path}`);
	}
	try {
		const saved: unknown = JSON.parse(content);
		if (typeof saved === "object" && saved !== null && !Array.isArray(saved) && "version" in saved && saved.version === 1) {
			return saved as Record<string, unknown>;
		}
	} catch {
		// Invalid configuration is ignored until a confirmed selection replaces it.
	}
	return { version: 1 };
}

export async function loadReviewPreference(agentDir = getAgentDir()): Promise<ModelThinkingSettings | undefined> {
	let saved: Record<string, unknown>;
	try { saved = await readPreferences(agentDir); }
	catch { throw new Error(`Unable to read review preferences: ${join(agentDir, PREFERENCES_FILE_NAME)}`); }
	return validPair(saved.review) ? copyPair(saved.review) : undefined;
}

export async function loadImplementationPreference(agentDir = getAgentDir()): Promise<ModelThinkingSettings | undefined> {
	const saved = await readPreferences(agentDir);
	return validPair(saved.implementation) ? copyPair(saved.implementation) : undefined;
}

export async function selectPreferredImplementationSettings(
	ctx: ExtensionCommandContext,
	controller: ImplementationModelController,
	agentDir = getAgentDir(),
): Promise<ImplementationSettings | undefined> {
	const saved = await readPreferences(agentDir);
	const preferred = saved.reuseLastImplementationSettings !== false && validPair(saved.implementation)
		? copyPair(saved.implementation) : undefined;
	return selectImplementationSettings(ctx, controller, preferred);
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

// Serialize read/merge/write operations so simultaneous in-process updates preserve both pairs.
let pendingWrite = Promise.resolve();
function savePreference(purpose: "implementation" | "review", pair: ModelThinkingSettings, agentDir: string): Promise<void> {
	if (!validPair(pair)) return Promise.reject(new Error(`Invalid ${purpose} model/thinking preference.`));
	const selected = copyPair(pair);
	const write = pendingWrite.catch(() => {}).then(async () => {
		const path = join(agentDir, PREFERENCES_FILE_NAME);
		const temporaryPath = `${path}.${randomUUID()}.tmp`;
		try {
			const saved = await readPreferences(agentDir);
			await mkdir(agentDir, { recursive: true });
			await writeFile(temporaryPath, `${JSON.stringify({ ...saved, [purpose]: selected }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await rename(temporaryPath, path);
		} catch {
			throw new Error(`Unable to save ${purpose} preferences: ${path}`);
		} finally {
			await rm(temporaryPath, { force: true }).catch(() => {});
		}
	});
	pendingWrite = write;
	return write;
}

// Call only after the execution summary has been confirmed, never during option selection or resume.
export function saveReviewPreference(pair: ModelThinkingSettings, agentDir = getAgentDir()): Promise<void> {
	return savePreference("review", pair, agentDir);
}

export function saveImplementationPreference(pair: ModelThinkingSettings, agentDir = getAgentDir()): Promise<void> {
	return savePreference("implementation", pair, agentDir);
}
