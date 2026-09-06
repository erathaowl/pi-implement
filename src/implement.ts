import type { ImplementationPlan, ImplementationTask } from "./tasks.ts";

export type TaskStatus = "pending" | "running" | "completed" | "failed";

export interface ImplementationResult {
	completed: boolean;
	statuses: TaskStatus[];
	error?: Error;
}

export type ExecuteTask = (task: ImplementationTask) => Promise<void>;
export type ProgressHandler = (statuses: readonly TaskStatus[]) => void;

type AssistantTurn = {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
};

type PendingTurn = {
	started: boolean;
	lastAssistant?: AssistantTurn;
	resolve: () => void;
	reject: (error: Error) => void;
};

export function buildImplementationPrompt(task: ImplementationTask): string {
	return `Implement the following task from the implementation plan.
Title:
${task.title}
Instructions:
${task.instructions}
Work directly on the current project.
Complete only this task.
Do not start subsequent tasks.
When the task is complete, return control to the implementation workflow.`;
}

function findLastAssistant(messages: readonly unknown[]): AssistantTurn | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			typeof message === "object" &&
			message !== null &&
			(message as AssistantTurn).role === "assistant"
		) {
			return message as AssistantTurn;
		}
	}
	return undefined;
}

function turnError(message: AssistantTurn | undefined): Error | undefined {
	if (!message) {
		return new Error("Agent turn ended without an assistant response.");
	}

	const stopReason = typeof message.stopReason === "string" ? message.stopReason : "unknown";
	if (stopReason === "stop") {
		return undefined;
	}
	if (stopReason === "aborted") {
		return new Error("Task execution was cancelled.");
	}
	if (stopReason === "length") {
		return new Error("Task execution stopped because the model response was truncated.");
	}

	const detail = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
	return new Error(detail || `Task execution failed (${stopReason}).`);
}

/**
 * Bridges pi's fire-and-forget sendUserMessage API to the complete active-agent
 * lifecycle. A task settles only when pi emits agent_settled after all model,
 * tool, retry, and compaction work for that turn has finished.
 */
export class ActiveSessionTaskExecutor {
	private readonly sendUserMessage: (message: string) => void;
	private pending?: PendingTurn;

	constructor(sendUserMessage: (message: string) => void) {
		this.sendUserMessage = sendUserMessage;
	}

	execute = (task: ImplementationTask): Promise<void> => {
		if (this.pending) {
			return Promise.reject(new Error("Another implementation task is already running."));
		}

		return new Promise<void>((resolve, reject) => {
			this.pending = { started: false, resolve, reject };
			try {
				this.sendUserMessage(buildImplementationPrompt(task));
			} catch (error) {
				this.pending = undefined;
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};

	onAgentStart(): void {
		if (this.pending) {
			this.pending.started = true;
		}
	}

	onAgentEnd(messages: readonly unknown[]): void {
		if (this.pending?.started) {
			this.pending.lastAssistant = findLastAssistant(messages);
		}
	}

	onAgentSettled(): void {
		if (!this.pending?.started) {
			return;
		}

		const pending = this.pending;
		this.pending = undefined;
		const error = turnError(pending.lastAssistant);
		if (error) {
			pending.reject(error);
		} else {
			pending.resolve();
		}
	}

	cancel(message: string): void {
		const pending = this.pending;
		this.pending = undefined;
		pending?.reject(new Error(message));
	}
}

export async function runImplementationPlan(
	plan: ImplementationPlan,
	executeTask: ExecuteTask,
	onProgress: ProgressHandler = () => {},
): Promise<ImplementationResult> {
	const statuses: TaskStatus[] = plan.tasks.map(() => "pending");
	const update = () => onProgress([...statuses]);
	update();

	for (let index = 0; index < plan.tasks.length; index++) {
		statuses[index] = "running";
		update();

		try {
			await executeTask(plan.tasks[index]);
			statuses[index] = "completed";
			update();
		} catch (error) {
			statuses[index] = "failed";
			update();
			return {
				completed: false,
				statuses: [...statuses],
				error: error instanceof Error ? error : new Error(String(error)),
			};
		}
	}

	return { completed: true, statuses: [...statuses] };
}

export function formatPreview(sourcePath: string, plan: ImplementationPlan): string {
	const tasks = plan.tasks.map((task, index) => `${index + 1}. ${task.title}`);
	return [`Implement ${sourcePath}`, ...tasks, `${plan.tasks.length} ${plan.tasks.length === 1 ? "task" : "tasks"} detected.`].join(
		"\n",
	);
}

export function formatProgress(plan: ImplementationPlan, statuses: readonly TaskStatus[]): string[] {
	const symbols: Record<TaskStatus, string> = {
		pending: "○",
		running: "●",
		completed: "✓",
		failed: "✗",
	};

	return [
		"Implementation",
		...plan.tasks.map((task, index) => `${symbols[statuses[index] ?? "pending"]} ${index + 1}/${plan.tasks.length} ${task.title}`),
	];
}
