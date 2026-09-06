import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 70;

export const COMPACTION_DISABLED_CHOICE = "No";
export const COMPACTION_ENABLED_CHOICE = `Yes, when context usage exceeds ${DEFAULT_COMPACTION_THRESHOLD_PERCENT}%`;

type CompactionContext = Pick<ExtensionCommandContext, "compact" | "getContextUsage" | "ui">;

export async function compactIfNeeded(
	ctx: CompactionContext,
	enabled: boolean,
	thresholdPercent: number,
	nextTaskNumber: number,
): Promise<void> {
	if (!enabled) {
		return;
	}

	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null || usage.percent <= thresholdPercent) {
		return;
	}

	ctx.ui.setWorkingMessage(`Compact context before task ${nextTaskNumber} (${usage.percent}%)`);
	try {
		await new Promise<void>((resolve, reject) => {
			try {
				ctx.compact({
					onComplete: () => resolve(),
					onError: (error) => reject(error),
				});
			} catch (error) {
				reject(error);
			}
		});
	} finally {
		ctx.ui.setWorkingMessage();
	}
}
