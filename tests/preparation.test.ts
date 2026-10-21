import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { snapshotGeneratedTasks, writeGeneratedTaskDocument } from "../src/plan.ts";

for (const existing of [false, true]) {
	test(`prepared task destination is revalidated before writing (existing: ${existing})`, async () => {
		const cwd = await mkdtemp(join(process.cwd(), ".preparation-test-"));
		try {
			const path = join(cwd, "tasks.md");
			if (existing) await writeFile(path, "Original\n");
			const prepared = {
				markdown: "Generated\n",
				destination: await snapshotGeneratedTasks(cwd),
				overwriteApproved: existing,
			};
			await writeFile(path, "External change\n");
			await assert.rejects(writeGeneratedTaskDocument(cwd, prepared.markdown, prepared), /changed/);
			assert.equal(await readFile(path, "utf8"), "External change\n");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
}

test("prepared overwrite requires consent and writes only when setup starts", async () => {
	const cwd = await mkdtemp(join(process.cwd(), ".preparation-test-"));
	try {
		const path = join(cwd, "tasks.md");
		await writeFile(path, "Original\n");
		const prepared = {
			markdown: "Generated\n",
			destination: await snapshotGeneratedTasks(cwd),
			overwriteApproved: false,
		};
		assert.equal(await readFile(path, "utf8"), "Original\n");
		await assert.rejects(writeGeneratedTaskDocument(cwd, prepared.markdown, prepared), /not approved/);
		await writeGeneratedTaskDocument(cwd, prepared.markdown, { ...prepared, overwriteApproved: true });
		assert.equal(await readFile(path, "utf8"), "Generated\n");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
