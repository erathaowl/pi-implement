import { parseTaskResult, type TaskOutcome } from "./tasks.ts";

export type TaskStatus = "pending" | "running" | "completed" | "failed";

type AssistantTurn = {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	content?: unknown;
};

type PendingTurn = {
	started: boolean;
	observePrompts: boolean;
	openPrompts: number;
	settled?: { aborted?: boolean };
	lastAssistant?: AssistantTurn;
	resolve: (message: AssistantTurn) => void;
	reject: (error: Error) => void;
};

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

function assistantText(message: AssistantTurn): string {
	return Array.isArray(message.content) ? message.content
		.filter((block) => typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string).join("\n").trim() : "";
}

/** Waits for the complete active pi agent lifecycle for one submitted prompt. */
export class ActiveSessionExecutor {
	private readonly sendUserMessage: (message: string) => void;
	private pending?: PendingTurn;
	private readonly onWaitingForUserChange: (waiting: boolean) => void;

	constructor(
		sendUserMessage: (message: string) => void,
		onWaitingForUserChange: (waiting: boolean) => void = () => {},
	) {
		this.sendUserMessage = sendUserMessage;
		this.onWaitingForUserChange = onWaitingForUserChange;
	}

	execute = (prompt: string): Promise<void> => this.executeTurn(prompt, true).then(() => {});

	executeTask = async (prompt: string, taskNumber: number): Promise<TaskOutcome> => {
		if (!Number.isSafeInteger(taskNumber) || taskNumber < 1) throw new Error("Invalid task number.");
		const message = await this.executeTurn(prompt, true);
		return parseTaskResult(assistantText(message), taskNumber);
	};

	executeForText = async (prompt: string): Promise<string> => {
		const message = await this.executeTurn(prompt);
		const text = assistantText(message);
		if (!text) throw new Error("Agent turn ended without final assistant text.");
		return text;
	};

	private executeTurn(prompt: string, observePrompts = false): Promise<AssistantTurn> {
		if (this.pending) {
			return Promise.reject(new Error("Another implementation task is already running."));
		}

		return new Promise<AssistantTurn>((resolve, reject) => {
			this.pending = { started: false, observePrompts, openPrompts: 0, resolve, reject };
			try {
				this.sendUserMessage(prompt);
			} catch (error) {
				this.pending = undefined;
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	get waitingForUser(): boolean {
		return !!this.pending?.openPrompts;
	}

	onUiPromptStart(): void {
		const pending = this.pending;
		if (!pending?.started || !pending.observePrompts) return;
		if (pending.openPrompts++ === 0) this.onWaitingForUserChange(true);
	}

	onUiPromptEnd(): void {
		const pending = this.pending;
		if (!pending?.openPrompts) return;
		if (--pending.openPrompts === 0) {
			this.onWaitingForUserChange(false);
			if (pending.settled) this.onAgentSettled(pending.settled);
		}
	}

	// Pi 0.85.1 tool_result exposes isError and arbitrary details/text, but no
	// permission-specific contract (even blocked calls use a plain error result).
	// Do not infer authorization from error strings or completion order of tools:
	// executeTask relies on the final explicit task result instead.

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

	onAgentSettled(event?: { aborted?: boolean }): void {
		if (!this.pending?.started) {
			return;
		}

		const pending = this.pending;
		if (pending.openPrompts > 0 && !event?.aborted) {
			// A live prompt must close before a submitted task can resolve. Retain
			// the settlement barrier without submitting another agent prompt.
			pending.settled = event ?? {};
			return;
		}
		this.pending = undefined;
		if (pending.openPrompts > 0) this.onWaitingForUserChange(false);
		const error = event?.aborted ? new Error("Task execution was cancelled.") : turnError(pending.lastAssistant);
		if (error) {
			pending.reject(error);
		} else {
			pending.resolve(pending.lastAssistant!);
		}
	}

	cancel(message: string): void {
		const pending = this.pending;
		this.pending = undefined;
		if (pending?.openPrompts) this.onWaitingForUserChange(false);
		pending?.reject(new Error(message));
	}
}

