import { lstat, readFile } from "node:fs/promises";

// Include file identity and timestamps so replacing a file with identical text still invalidates consent.
export async function snapshotFile(path: string): Promise<string | null> {
	try {
		const info = await lstat(path);
		if (!info.isFile()) throw new Error(`${path} must be a regular file.`);
		return JSON.stringify([info.dev, info.ino, info.mtimeMs, info.ctimeMs, await readFile(path, "utf8")]);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export async function assertFileUnchanged(path: string, expected: string | null): Promise<void> {
	if (await snapshotFile(path) !== expected) {
		throw new Error(`${path} changed during preparation. Prepare the workflow again.`);
	}
}
