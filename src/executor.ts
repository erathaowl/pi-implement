export type TaskStatus = "pending" | "running" | "completed" | "failed";

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

/** Waits for the complete active pi agent lifecycle for one submitted prompt. */
export class ActiveSessionExecutor {
	private readonly sendUserMessage: (message: string) => void;
	private pending?: PendingTurn;

	constructor(sendUserMessage: (message: string) => void) {
		this.sendUserMessage = sendUserMessage;
	}

	execute = (prompt: string): Promise<void> => {
		if (this.pending) {
			return Promise.reject(new Error("Another implementation task is already running."));
		}

		return new Promise<void>((resolve, reject) => {
			this.pending = { started: false, resolve, reject };
			try {
				this.sendUserMessage(prompt);
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

