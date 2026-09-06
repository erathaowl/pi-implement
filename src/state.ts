import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const STATE_FILE_NAME = ".pi-implement-state.json";

export interface ImplementationState {
	version: 1;
	workflow: "rewrite" | "tasks";
	sourcePath: string;
	tasks: Array<{ title: string; prompt: string }>;
	nextTaskIndex: number;
	status: "running" | "failed";
	error?: string;
	checkpoint: boolean;
	automaticCompaction: boolean;
	branchName?: string;
}

async function stateRoot(cwd: string): Promise<string> {
	const startingDirectory = resolve(cwd);
	let directory = startingDirectory;
	while (true) {
		try {
			await stat(join(directory, ".git"));
			return directory;
		} catch (error) {
			if (
				typeof error !== "object" ||
				error === null ||
				!("code" in error) ||
				String((error as { code?: unknown }).code) !== "ENOENT"
			) {
				throw new Error("Unable to locate the implementation state directory.");
			}
		}

		const parent = dirname(directory);
		if (parent === directory) {
			return startingDirectory;
		}
		directory = parent;
	}
}

async function statePath(cwd: string): Promise<string> {
	return join(await stateRoot(cwd), STATE_FILE_NAME);
}

function validateState(value: unknown): ImplementationState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid implementation state file.");
	}

	const state = value as Partial<ImplementationState>;
	if (
		state.version !== 1 ||
		(state.workflow !== "rewrite" && state.workflow !== "tasks") ||
		typeof state.sourcePath !== "string" ||
		!Array.isArray(state.tasks) ||
		state.tasks.length === 0 ||
		!state.tasks.every(
			(task) =>
				typeof task === "object" &&
				task !== null &&
				typeof task.title === "string" &&
				task.title.trim().length > 0 &&
				typeof task.prompt === "string" &&
				task.prompt.length > 0,
		) ||
		typeof state.nextTaskIndex !== "number" ||
		!Number.isInteger(state.nextTaskIndex) ||
		state.nextTaskIndex < 0 ||
		state.nextTaskIndex > state.tasks.length ||
		(state.status !== "running" && state.status !== "failed") ||
		typeof state.checkpoint !== "boolean" ||
		typeof state.automaticCompaction !== "boolean" ||
		(state.error !== undefined && typeof state.error !== "string") ||
		(state.branchName !== undefined && typeof state.branchName !== "string") ||
		(state.checkpoint && !state.branchName?.trim())
	) {
		throw new Error("Invalid implementation state file.");
	}

	return state as ImplementationState;
}

export async function loadState(cwd: string): Promise<ImplementationState | undefined> {
	let content: string;
	try {
		content = await readFile(await statePath(cwd), "utf8");
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			String((error as { code?: unknown }).code) === "ENOENT"
		) {
			return undefined;
		}
		throw new Error(`Unable to read ${STATE_FILE_NAME}.`);
	}

	try {
		return validateState(JSON.parse(content));
	} catch (error) {
		if (error instanceof Error && error.message === "Invalid implementation state file.") {
			throw error;
		}
		throw new Error("Invalid implementation state file.");
	}
}

export async function saveState(cwd: string, state: ImplementationState): Promise<void> {
	const path = await statePath(cwd);
	const temporaryPath = `${path}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		await rename(temporaryPath, path);
	} catch {
		throw new Error(`Unable to save ${STATE_FILE_NAME}.`);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => {});
	}
}

export async function deleteState(cwd: string): Promise<void> {
	try {
		await rm(await statePath(cwd), { force: true });
	} catch {
		throw new Error(`Unable to delete ${STATE_FILE_NAME}.`);
	}
}

export async function addStateFileToGitignore(cwd: string): Promise<void> {
	const path = join(await stateRoot(cwd), ".gitignore");
	let content = "";
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (
			typeof error !== "object" ||
			error === null ||
			!("code" in error) ||
			String((error as { code?: unknown }).code) !== "ENOENT"
		) {
			throw new Error("Unable to update .gitignore.");
		}
	}

	if (content.split(/\r?\n/).some((line) => line.trim() === STATE_FILE_NAME)) {
		return;
	}

	const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	try {
		await writeFile(path, `${content}${separator}${STATE_FILE_NAME}\n`, "utf8");
	} catch {
		throw new Error("Unable to update .gitignore.");
	}
}
