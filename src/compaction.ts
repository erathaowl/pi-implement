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
	force = false,
	beforeCompact?: () => Promise<void>,
): Promise<void> {
	if (!enabled) {
		return;
	}

	let percent: number | null = null;
	if (!force) {
		const usage = ctx.getContextUsage();
		if (!usage || usage.percent === null || usage.percent <= thresholdPercent) {
			return;
		}
		percent = usage.percent;
	}

	ctx.ui.setWorkingMessage(
		percent === null
			? `Compact context before task ${nextTaskNumber}`
			: `Compact context before task ${nextTaskNumber} (${percent}%)`,
	);
	try {
		await beforeCompact?.();
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
