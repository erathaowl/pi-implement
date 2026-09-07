import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 70;

export const COMPACTION_DISABLED_CHOICE = "No";
export const COMPACTION_ENABLED_CHOICE = "Yes";

export function parseCompactionThresholdPercent(input: string): number {
	const value = input.trim();
	if (!/^\d+$/.test(value)) {
		throw new Error("Compaction threshold must be an integer from 1 to 100 percent.");
	}

	const percent = Number(value);
	if (percent < 1 || percent > 100) {
		throw new Error("Compaction threshold must be an integer from 1 to 100 percent.");
	}
	return percent;
}

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
