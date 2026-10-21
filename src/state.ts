import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isImplementationThinkingLevel, type ImplementationSettings } from "./model.ts";
import type { PreparedTaskDocument } from "./plan.ts";
import { validateReviewResult, type ReviewResult, type ReviewSources } from "./review.ts";
export type { ReviewResult } from "./review.ts";

export const STATE_FILE_NAME = ".pi-implement-state.json";
export const INITIAL_CHECKPOINT_MESSAGE = "chore: capture initial implementation state";

export type WorkflowPhase = "setup" | "tasks" | "review" | "review_checkpoint" | "completed";
export type ReviewSettings = { enabled: false } | {
	enabled: true;
	model: ImplementationSettings["implementationModel"];
	thinkingLevel: ImplementationSettings["implementationThinkingLevel"];
};
export interface PendingCheckpoint {
	purpose: "initial" | "task" | "review";
	message: string;
	// Undefined for a checkpoint not yet attempted (including migrated checkpoints).
	headBefore?: string | null;
}
export interface SetupIntent {
	step: "branch" | "initial_checkpoint" | "gitignore" | "tasks_file" | "done";
	createBranch: boolean;
	initialCheckpoint: boolean;
	baseBranch: string | null;
	expectedHead: string | null;
	gitignore?: { before: string | null; content: string };
}
interface CommonState extends ImplementationSettings {
	cwd: string;
	sourcePath: string;
	tasks: Array<{ title: string; prompt: string }>;
	nextTaskIndex: number;
	status: "running" | "failed";
	error?: string;
	checkpoint: boolean;
	automaticCompaction: boolean;
	compactionThresholdPercent: number;
	pendingCompaction?: boolean;
	branchName?: string;
}
export interface LegacyImplementationState extends CommonState {
	version: 1;
	pendingCheckpoint?: boolean;
}
export interface ImplementationState extends CommonState {
	version: 2;
	phase: WorkflowPhase;
	setup?: SetupIntent;
	originalPlanPath?: string | null;
	preparedTasks?: PreparedTaskDocument;
	review: ReviewSettings;
	reviewResult?: ReviewResult;
	reviewStarted?: boolean;
	pendingCheckpoint?: PendingCheckpoint;
}

async function stateRoot(cwd: string): Promise<string> {
	const startingDirectory = resolve(cwd);
	let directory = startingDirectory;
	while (true) {
		try {
			await stat(join(directory, ".git"));
			return directory;
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
				throw new Error("Unable to locate the implementation state directory.");
			}
		}
		const parent = dirname(directory);
		if (parent === directory) return startingDirectory;
		directory = parent;
	}
}
async function statePath(cwd: string): Promise<string> {
	return join(await stateRoot(cwd), STATE_FILE_NAME);
}
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function nullableText(value: unknown): boolean {
	return value === null || text(value);
}
function model(value: unknown): boolean {
	return record(value) && text(value.provider) && text(value.id);
}
function validReviewResult(value: unknown, sources: ReviewSources): boolean {
	try {
		validateReviewResult(value, sources);
		return true;
	} catch {
		return false;
	}
}
function invalid(): never {
	throw new Error("Invalid implementation state file.");
}

export function validateState(value: unknown): ImplementationState {
	if (!record(value)) invalid();
	const s = value;
	if ((s.version !== 1 && s.version !== 2) || !text(s.cwd) || !text(s.sourcePath) ||
		!Array.isArray(s.tasks) || !s.tasks.length || !s.tasks.every((task) => record(task) && text(task.title) && text(task.prompt)) ||
		!Number.isInteger(s.nextTaskIndex) || (s.nextTaskIndex as number) < 0 || (s.nextTaskIndex as number) > s.tasks.length ||
		!["running", "failed"].includes(String(s.status)) || typeof s.checkpoint !== "boolean" ||
		typeof s.automaticCompaction !== "boolean" || !Number.isInteger(s.compactionThresholdPercent) ||
		(s.compactionThresholdPercent as number) < 1 || (s.compactionThresholdPercent as number) > 100 ||
		!model(s.implementationModel) || !isImplementationThinkingLevel(s.implementationThinkingLevel) ||
		(s.error !== undefined && typeof s.error !== "string") ||
		(s.branchName !== undefined && !text(s.branchName)) || (s.checkpoint && !text(s.branchName)) ||
		(s.pendingCompaction !== undefined && typeof s.pendingCompaction !== "boolean") ||
		(s.pendingCompaction === true && !s.automaticCompaction)) invalid();

	if (s.version === 1) {
		if ((s.pendingCheckpoint !== undefined && typeof s.pendingCheckpoint !== "boolean") ||
			(s.pendingCheckpoint === true && (!s.checkpoint || s.nextTaskIndex === 0)) ||
			(s.pendingCompaction === true && (s.nextTaskIndex as number) >= s.tasks.length)) invalid();
		const legacy = s as unknown as LegacyImplementationState;
		const { pendingCheckpoint, ...common } = legacy;
		const title = legacy.tasks[legacy.nextTaskIndex - 1]?.title.replace(/\s+/g, " ").trim();
		return {
			...common,
			version: 2,
			originalPlanPath: null,
			phase: legacy.nextTaskIndex === legacy.tasks.length && !pendingCheckpoint ? "completed" : "tasks",
			review: { enabled: false },
			...(pendingCheckpoint ? { pendingCheckpoint: { purpose: "task", message: `Task ${legacy.nextTaskIndex}: ${title}` } } : {}),
		};
	}
	if (!["setup", "tasks", "review", "review_checkpoint", "completed"].includes(String(s.phase)) ||
		!record(s.review) || typeof s.review.enabled !== "boolean" ||
		(s.review.enabled && (!model(s.review.model) || !isImplementationThinkingLevel(s.review.thinkingLevel))) ||
		(s.originalPlanPath !== undefined && !nullableText(s.originalPlanPath)) ||
		(s.reviewResult !== undefined && (!s.review.enabled || !["review", "review_checkpoint", "completed"].includes(String(s.phase)) || !validReviewResult(s.reviewResult, { sourcePath: s.sourcePath, originalPlanPath: s.originalPlanPath as string | null | undefined })))) invalid();
	if (s.preparedTasks !== undefined && (!record(s.preparedTasks) || !text(s.preparedTasks.markdown) ||
		!nullableText(s.preparedTasks.destination) || typeof s.preparedTasks.overwriteApproved !== "boolean" ||
		(s.preparedTasks.destination !== null && !s.preparedTasks.overwriteApproved))) invalid();
	if (s.setup !== undefined) {
		const setup = s.setup;
		if (!record(setup) || !["branch", "initial_checkpoint", "gitignore", "tasks_file", "done"].includes(String(setup.step)) ||
			typeof setup.createBranch !== "boolean" || typeof setup.initialCheckpoint !== "boolean" ||
			(setup.baseBranch !== null && typeof setup.baseBranch !== "string") || !nullableText(setup.expectedHead) ||
			((setup.createBranch || setup.initialCheckpoint) && !s.checkpoint) ||
			(s.checkpoint && setup.baseBranch === null) || (setup.baseBranch === null && setup.expectedHead !== null) ||
			(setup.gitignore !== undefined && (!record(setup.gitignore) || !nullableText(setup.gitignore.before) || !text(setup.gitignore.content))) ||
			(s.phase === "setup" ? setup.step === "done" : setup.step !== "done")) invalid();
	}
	if (s.reviewStarted !== undefined && (typeof s.reviewStarted !== "boolean" || !s.review.enabled ||
		!["review", "review_checkpoint", "completed"].includes(String(s.phase)) ||
		(s.reviewStarted && s.pendingCompaction) || (s.reviewStarted === false && s.reviewResult))) invalid();
	if (s.reviewResult !== undefined && s.pendingCompaction) invalid();
	if ((s.phase === "setup" && (!s.setup || s.nextTaskIndex !== 0)) ||
		((s.phase === "review" || s.phase === "review_checkpoint") && (!s.review.enabled || s.nextTaskIndex !== s.tasks.length)) ||
		(s.phase === "review_checkpoint" && !s.reviewResult) ||
		(s.phase === "completed" && (s.nextTaskIndex !== s.tasks.length || s.pendingCheckpoint || s.pendingCompaction || (s.review.enabled && !s.reviewResult))) ||
		(s.pendingCompaction === true && (s.phase !== "tasks" && s.phase !== "review" || (s.phase === "tasks" && s.nextTaskIndex === s.tasks.length && !s.review.enabled)))) invalid();
	if (s.pendingCheckpoint !== undefined) {
		const pending = s.pendingCheckpoint;
		if (!record(pending) || !s.checkpoint || !text(pending.message) ||
			!["initial", "task", "review"].includes(String(pending.purpose)) ||
			(pending.headBefore !== undefined && !nullableText(pending.headBefore)) ||
			(pending.purpose === "initial" && (s.phase !== "setup" || !record(s.setup) || s.setup.step !== "initial_checkpoint" || !s.setup.initialCheckpoint)) ||
			(pending.purpose === "task" && (s.phase !== "tasks" || s.nextTaskIndex === 0)) ||
			(pending.purpose === "review" && s.phase !== "review_checkpoint")) invalid();
	}
	return { ...s, originalPlanPath: s.originalPlanPath ?? null } as unknown as ImplementationState;
}

export async function loadState(cwd: string): Promise<ImplementationState | undefined> {
	let content: string;
	try {
		content = await readFile(await statePath(cwd), "utf8");
	} catch (error) {
		if (record(error) && error.code === "ENOENT") return undefined;
		throw new Error(`Unable to read ${STATE_FILE_NAME}.`);
	}
	try {
		return validateState(JSON.parse(content));
	} catch {
		throw new Error("Invalid implementation state file.");
	}
}
export async function saveState(cwd: string, state: ImplementationState): Promise<void> {
	const validated = validateState(state);
	const path = await statePath(cwd);
	const temporaryPath = `${path}.tmp`;
	try {
		await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
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
export async function gitignorePath(cwd: string): Promise<string> {
	return join(await stateRoot(cwd), ".gitignore");
}
export function stateFileGitignoreContent(content: string): string {
	if (content.split(/\r?\n/).some((line) => line.trim() === STATE_FILE_NAME)) return content;
	const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	return `${content}${separator}${STATE_FILE_NAME}\n`;
}
export async function addStateFileToGitignore(cwd: string): Promise<void> {
	const path = await gitignorePath(cwd);
	let content = "";
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (!record(error) || error.code !== "ENOENT") throw new Error("Unable to update .gitignore.");
	}
	const updated = stateFileGitignoreContent(content);
	if (updated === content) return;
	try {
		await writeFile(path, updated, "utf8");
	} catch {
		throw new Error("Unable to update .gitignore.");
	}
}
