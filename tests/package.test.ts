import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

test("package metadata uses the pi-implement name and wildcard pi peer dependency", async () => {
	const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
	const packageLock = JSON.parse(await readFile(join(process.cwd(), "package-lock.json"), "utf8"));

	assert.equal(packageJson.name, "pi-implement");
	assert.equal(packageJson.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(packageLock.name, "pi-implement");
	assert.equal(packageLock.packages[""].name, "pi-implement");
});
