import type { LocalGit } from "./git.ts";
import { saveState, type ImplementationState } from "./state.ts";

export async function completeCheckpoint(cwd: string, git: LocalGit, state: ImplementationState): Promise<void> {
	const pending = state.pendingCheckpoint;
	if (!pending) return;
	if (pending.headBefore === undefined) {
		pending.headBefore = await git.head(cwd);
		await saveState(cwd, state);
	}
	if (!await git.checkpointCommitted(cwd, pending.headBefore, pending.message)) {
		if (pending.purpose === "initial") await git.commitInitialChanges(cwd, pending.message);
		else await git.commitChanges(cwd, pending.message);
	}
	if (pending.purpose === "initial") {
		state.setup!.expectedHead = await git.head(cwd);
		state.setup!.step = "gitignore";
	}
	delete state.pendingCheckpoint;
	state.status = "running";
	delete state.error;
	await saveState(cwd, state);
}
