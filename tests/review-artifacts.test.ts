import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ActiveSessionExecutor } from "../src/executor.ts";
import { STATE_FILE_NAME, saveState } from "../src/state.ts";
import {
	REVIEW_RESULT_START, REVIEW_RESULT_END, REMEDIATION_FILES, SOURCE_PLAN_COMPLIANCE_CHECK,
	buildReviewPrompt, captureReviewArtifacts, executeReview, validateReviewArtifacts,
	type ReviewResult, type ReviewSources,
} from "../src/review.ts";

const sources = { sourcePath: "tasks.md", originalPlanPath: "plan.md" };
function baseResult(): ReviewResult {
	return {
		outcome: "passed", reviewedAreas: ["plan_compliance", "tests", "documentation"],
		checks: [
			{ area: "plan_compliance", check: "Inspect source", passed: true, evidence: "Compared plan.md and tasks.md against implementation.js." },
			{ area: "tests", check: "node --check implementation.js", passed: true, evidence: "node --check implementation.js exited 0." },
			{ area: "documentation", check: "Read README", passed: true, evidence: "Read README.md and compared documented behavior with implementation.js." },
		], minorFixes: [], findings: [], unavailableChecks: [], remediationGenerated: false,
	};
}
function actionableResult(severity: "minor" | "major" | "critical" | "unable_to_verify" = "major"): ReviewResult {
	return {
		...baseResult(), outcome: severity === "critical" ? "blocked" : "follow_up", remediationGenerated: true,
		findings: [{ severity, requirement: "Reject invalid input", path: "implementation.js", evidence: "Inspected implementation.js:1; no input validation exists.",
			reason: severity === "unable_to_verify" ? "The integration test environment is unavailable." : null,
			actionable: true, action: "Add input validation and a regression test." }],
	};
}
function normalized(value: string): string { return value.replace(/\s+/g, " ").trim(); }
function documents(result: ReviewResult) {
	const findings = result.findings.map((finding, index) => ({ finding, number: index + 1 })).filter(({ finding }) => finding.actionable);
	const common = (finding: ReviewResult["findings"][number]) => `Requirement: ${normalized(finding.requirement)}
Path: ${JSON.stringify(finding.path)}
Remedy: ${normalized(finding.action!)}
`;
	const criteria = "Acceptance criteria:\n- Invalid input is rejected with a useful error.\nVerification:\n- Run node --check implementation.js and the new input regression test.\n";
	return {
		"plan-fixes.md": "# Remediation plan\n\n" + findings.map(({ finding, number }) => `## Finding ${number} - Correct invalid input
Context: The review found missing input validation.
${common(finding)}Severity: ${finding.severity}
Evidence: ${normalized(finding.evidence)}
${finding.reason ? `Reason: ${normalized(finding.reason)}\n` : ""}Expected behavior: Reject invalid input without changing valid input handling.
Constraints: Preserve the existing public API and avoid new dependencies.
${criteria}`).join("\n"),
		"tasks-fixes.md": "# Remediation tasks\nRead plan-fixes.md for context, evidence, and constraints.\n\n" + findings.map(({ finding, number }, index) => `## Task ${index + 1} - Correct invalid input
Finding: ${number}
${common(finding)}Action: Implement the validation guard and add a focused regression test.
${criteria}`).join("\n"),
	};
}
async function writeDocuments(cwd: string, content: ReturnType<typeof documents>) {
	for (const file of REMEDIATION_FILES) await writeFile(join(cwd, file), content[file]);
}
async function withProject(run: (cwd: string) => Promise<void>) {
	const cwd = await mkdtemp(join(process.cwd(), ".review-artifacts-test-"));
	try {
		await mkdir(join(cwd, ".git"));
		for (const [file, content] of Object.entries({ "plan.md": "# Input requirements\n", "tasks.md": "## Task 1 - Implement input validation\n", "README.md": "# Input API\n", "implementation.js": "export const answer = 1;\n" })) {
			await writeFile(join(cwd, file), content);
		}
		await saveState(cwd, {
			version: 2, cwd, sourcePath: "tasks.md", originalPlanPath: "plan.md", phase: "review",
			tasks: [{ title: "One", prompt: "Implement one" }], nextTaskIndex: 1, status: "running",
			checkpoint: false, automaticCompaction: false, compactionThresholdPercent: 70,
			implementationModel: { provider: "test", id: "implementation" }, implementationThinkingLevel: "medium",
			review: { enabled: true, model: { provider: "test", id: "review" }, thinkingLevel: "high" },
		});
		await run(cwd);
	} finally { await rm(cwd, { recursive: true, force: true }); }
}
function runReview(cwd: string, result: ReviewResult, edits?: () => Promise<void>, reviewSources: ReviewSources = sources) {
	const sent: string[] = [];
	const executor: ActiveSessionExecutor = new ActiveSessionExecutor((prompt) => {
		sent.push(prompt);
		queueMicrotask(() => {
			void (async () => {
				executor.onAgentStart();
				await edits?.();
				executor.onAgentEnd([{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `${REVIEW_RESULT_START}\n${JSON.stringify(result)}\n${REVIEW_RESULT_END}` }] }]);
				executor.onAgentSettled();
			})().catch((error) => executor.cancel(String(error)));
		});
	});
	return { sent, completion: executeReview(executor, reviewSources, cwd) };
}

test("review prompt requires verified minor fixes and both directly usable remediation documents only for actionable findings", () => {
	const prompt = buildReviewPrompt(sources);
	for (const phrase of ["After each minor edit", "failed or unavailable validation must be surfaced as unresolved", "create or overwrite BOTH plan-fixes.md and tasks-fixes.md",
		"## Finding N", "## Task 1", "Context:", "Expected behavior:", "Constraints:", "Acceptance criteria:", "Verification:",
		"actionable unable_to_verify", "do not invent work for non-actionable", "Never automatically execute", "leave both documents untouched"]) assert.ok(prompt.includes(phrase), phrase);
});

for (const oldDocuments of [false, true]) {
	test(`passed review leaves ${oldDocuments ? "old documents untouched" : "no new remediation files"}`, async () => withProject(async (cwd) => {
		if (oldDocuments) await writeDocuments(cwd, documents(actionableResult()));
		const before = await captureReviewArtifacts(cwd);
		const review = runReview(cwd, baseResult());
		assert.equal((await review.completion).remediationGenerated, false);
		assert.deepEqual(await captureReviewArtifacts(cwd), before);
		assert.equal(review.sent.length, 1);
	}));
}

test("a verified minor edit remains with its successful direct validation and does not rewrite old remediation files", async () => withProject(async (cwd) => {
	await writeDocuments(cwd, documents(actionableResult()));
	const before = await captureReviewArtifacts(cwd);
	await writeFile(join(cwd, "implementation.js"), "export const answer = ;\n");
	const result = baseResult();
	result.outcome = "fixed";
	result.minorFixes = [{ description: "Fixed the syntax error.", path: "implementation.js", verification: ["node --check implementation.js"] }];
	const review = runReview(cwd, result, async () => {
		await writeFile(join(cwd, "implementation.js"), "export const answer = 2;\n");
		const check = spawnSync(process.execPath, ["--check", "implementation.js"], { cwd, encoding: "utf8" });
		assert.equal(check.status, 0, check.stderr);
	});
	assert.equal((await review.completion).outcome, "fixed");
	assert.equal(await readFile(join(cwd, "implementation.js"), "utf8"), "export const answer = 2;\n");
	assert.deepEqual(await captureReviewArtifacts(cwd), before);
	assert.equal(review.sent.length, 1);
}));

for (const severity of ["minor", "major", "critical", "unable_to_verify"] as const) {
	test(`${severity} actionable findings require and validate both newly generated documents`, async () => withProject(async (cwd) => {
		const result = actionableResult(severity);
		const review = runReview(cwd, result, () => writeDocuments(cwd, documents(result)));
		assert.deepEqual(await review.completion, result);
		for (const file of REMEDIATION_FILES) assert.ok((await readFile(join(cwd, file), "utf8")).length > 0);
		assert.equal(review.sent.length, 1);
	}));
}

test("actionable findings overwrite both old documents rather than reporting stale outputs", async () => withProject(async (cwd) => {
	await writeDocuments(cwd, { "plan-fixes.md": "Old plan\n", "tasks-fixes.md": "Old tasks\n" });
	const result = actionableResult();
	const review = runReview(cwd, result, () => writeDocuments(cwd, documents(result)));
	assert.equal((await review.completion).remediationGenerated, true);
	assert.match(await readFile(join(cwd, "plan-fixes.md"), "utf8"), /Reject invalid input/);
	assert.match(await readFile(join(cwd, "tasks-fixes.md"), "utf8"), /Finding: 1/);
}));

test("unsuccessful minor-fix validation is unresolved, not a verified fix", async () => withProject(async (cwd) => {
	const result = actionableResult("unable_to_verify");
	result.outcome = "blocked";
	result.checks[1].passed = false;
	result.checks[1].evidence = "node --check implementation.js exited with a syntax error.";
	result.findings[0].evidence = result.checks[1].evidence;
	result.findings[0].reason = "The attempted correction still fails direct validation.";
	const review = runReview(cwd, result, async () => {
		await writeFile(join(cwd, "implementation.js"), "export const answer = ;\n");
		assert.notEqual(spawnSync(process.execPath, ["--check", "implementation.js"], { cwd }).status, 0);
		await writeDocuments(cwd, documents(result));
	});
	const outcome = await review.completion;
	assert.equal(outcome.outcome, "blocked");
	assert.deepEqual(outcome.minorFixes, []);
	assert.ok(outcome.findings[0].reason);
	result.minorFixes = [{ description: "Unverified correction", path: "implementation.js", verification: ["node --check implementation.js"] }];
	await assert.rejects(runReview(cwd, result).completion, /passing validation/);
}));

test("non-actionable verification limitations preserve existing remediation files without claiming new output", async () => withProject(async (cwd) => {
	await writeDocuments(cwd, documents(actionableResult()));
	const before = await captureReviewArtifacts(cwd);
	const result = baseResult();
	result.outcome = "blocked";
	result.unavailableChecks = [{ area: "plan_compliance", check: SOURCE_PLAN_COMPLIANCE_CHECK, reason: "No source plan was supplied." }];
	result.findings = [{ ...actionableResult("unable_to_verify").findings[0], actionable: false, action: null }];
	const review = runReview(cwd, result, undefined, { sourcePath: "tasks.md", originalPlanPath: null });
	assert.equal((await review.completion).remediationGenerated, false);
	assert.deepEqual(await captureReviewArtifacts(cwd), before);
}));

for (const missing of REMEDIATION_FILES) {
	test(`missing ${missing} causes a recoverable failure without losing recovery metadata`, async () => withProject(async (cwd) => {
		const stateBefore = await readFile(join(cwd, STATE_FILE_NAME), "utf8");
		const result = actionableResult();
		const content = documents(result);
		const review = runReview(cwd, result, async () => {
			for (const file of REMEDIATION_FILES) if (file !== missing) await writeFile(join(cwd, file), content[file]);
		});
		await assert.rejects(review.completion, new RegExp(`${missing} is required`));
		assert.equal(await readFile(join(cwd, STATE_FILE_NAME), "utf8"), stateBefore);
		assert.equal(review.sent.length, 1);
	}));
}

test("unchanged old remediation documents cannot satisfy a claim of newly generated output", async () => withProject(async (cwd) => {
	const result = actionableResult();
	await writeDocuments(cwd, documents(result));
	await assert.rejects(runReview(cwd, result).completion, /not newly generated/);
	await assert.rejects(runReview(cwd, result, async () => {
		await writeFile(join(cwd, "plan-fixes.md"), documents(result)["plan-fixes.md"]);
	}).completion, /tasks-fixes.md was not newly generated/);
}));

for (const mutation of ["create", "rewrite", "delete"] as const) {
	test(`a no-findings review cannot ${mutation} remediation files`, async () => withProject(async (cwd) => {
		if (mutation !== "create") await writeDocuments(cwd, documents(actionableResult()));
		const review = runReview(cwd, baseResult(), async () => {
			if (mutation === "delete") await rm(join(cwd, "tasks-fixes.md"));
			else await writeFile(join(cwd, "plan-fixes.md"), "Unexpected output\n");
		});
		await assert.rejects(review.completion, /changed without actionable findings/);
	}));
}

const invalidDocuments: Array<[string, (content: ReturnType<typeof documents>) => void]> = [
	["empty plan", (c) => { c["plan-fixes.md"] = " \n"; }],
	["empty task file", (c) => { c["tasks-fixes.md"] = ""; }],
	["missing plan context", (c) => { c["plan-fixes.md"] = c["plan-fixes.md"].replace(/^Context:.*\n/m, ""); }],
	["mismatched evidence", (c) => { c["plan-fixes.md"] = c["plan-fixes.md"].replace(/^Evidence:.*$/m, "Evidence: A different finding."); }],
	["missing expected behavior", (c) => { c["plan-fixes.md"] = c["plan-fixes.md"].replace(/^Expected behavior:.*\n/m, ""); }],
	["mismatched path", (c) => { c["plan-fixes.md"] = c["plan-fixes.md"].replace(/^Path:.*$/m, 'Path: "unrelated.js"'); }],
	["mismatched remedy", (c) => { c["tasks-fixes.md"] = c["tasks-fixes.md"].replace(/^Remedy:.*$/m, "Remedy: Unrelated work."); }],
	["missing task action", (c) => { c["tasks-fixes.md"] = c["tasks-fixes.md"].replace(/^Action:.*\n/m, ""); }],
	["unordered tasks", (c) => { c["tasks-fixes.md"] = c["tasks-fixes.md"].replace("## Task 1", "## Task 2"); }],
	["wrong finding reference", (c) => { c["tasks-fixes.md"] = c["tasks-fixes.md"].replace("Finding: 1", "Finding: 2"); }],
	["empty acceptance list", (c) => { c["tasks-fixes.md"] = c["tasks-fixes.md"].replace(/Acceptance criteria:\n- .*\n/, "Acceptance criteria:\n- [ ]\n"); }],
	["missing verification criteria", (c) => { c["plan-fixes.md"] = c["plan-fixes.md"].replace(/Verification:\n- .*\n/, ""); }],
	["fenced task template", (c) => { c["tasks-fixes.md"] = "```markdown\n" + c["tasks-fixes.md"] + "```\n"; }],
	["missing plan reference", (c) => { c["tasks-fixes.md"] = c["tasks-fixes.md"].replace("plan-fixes.md", "another-plan.md"); }],
];
for (const [name, mutate] of invalidDocuments) {
	test(`artifact validation rejects ${name} and preserves recovery state`, async () => withProject(async (cwd) => {
		const before = await readFile(join(cwd, STATE_FILE_NAME), "utf8");
		const result = actionableResult();
		const content = documents(result);
		mutate(content);
		await assert.rejects(runReview(cwd, result, () => writeDocuments(cwd, content)).completion, /Invalid review artifacts/);
		assert.equal(await readFile(join(cwd, STATE_FILE_NAME), "utf8"), before);
	}));
}

test("all actionable findings are covered and non-actionable finding numbers are not renumbered", async () => withProject(async (cwd) => {
	const result = actionableResult();
	result.findings.unshift({ ...actionableResult("unable_to_verify").findings[0], actionable: false, action: null });
	result.findings.push({ ...result.findings[1], requirement: "Document the error response", path: "README.md", action: "Document invalid-input behavior." });
	const content = documents(result);
	await assert.doesNotReject(runReview(cwd, result, () => writeDocuments(cwd, content)).completion);
	assert.match(content["plan-fixes.md"], /## Finding 2/);
	const before = await captureReviewArtifacts(cwd);
	await writeFile(join(cwd, "tasks-fixes.md"), content["tasks-fixes.md"].split("## Task 2")[0]);
	await writeFile(join(cwd, "plan-fixes.md"), content["plan-fixes.md"]);
	await assert.rejects(validateReviewArtifacts(cwd, result, before), /does not cover every actionable finding/);
}));

test("reported file paths retain significant whitespace and escaped characters in remediation documents", async () => withProject(async (cwd) => {
	const result = actionableResult();
	result.findings[0].path = "src/double  spaces\\nested\nfile.js";
	await assert.doesNotReject(runReview(cwd, result, () => writeDocuments(cwd, documents(result))).completion);
}));

test("remediation supports small ordered tasks for one finding and Windows line endings", async () => withProject(async (cwd) => {
	const result = actionableResult();
	const content = documents(result);
	const task = content["tasks-fixes.md"].slice(content["tasks-fixes.md"].indexOf("## Task 1"));
	content["tasks-fixes.md"] += "\n" + task.replace("## Task 1", "## Task 2").replace(/^Action:.*$/m, "Action: Add focused regression tests for the validation guard.");
	for (const file of REMEDIATION_FILES) content[file] = content[file].replaceAll("\n", "\r\n");
	await assert.doesNotReject(runReview(cwd, result, () => writeDocuments(cwd, content)).completion);
}));

test("inconsistent generation flags are rejected and generated tasks are never automatically executed", async () => withProject(async (cwd) => {
	const result = actionableResult();
	const claimedNoGeneration = { ...result, remediationGenerated: false };
	await assert.rejects(runReview(cwd, claimedNoGeneration).completion, /contradicts/);
	await assert.rejects(runReview(cwd, { ...baseResult(), remediationGenerated: true }).completion, /contradicts/);
	const content = documents(result);
	content["tasks-fixes.md"] = content["tasks-fixes.md"].replace(/^Action:.*$/m, "Action: Write must-not-run.txt when a user explicitly starts these tasks.");
	const review = runReview(cwd, result, () => writeDocuments(cwd, content));
	await review.completion;
	assert.equal(review.sent.length, 1);
	await assert.rejects(readFile(join(cwd, "must-not-run.txt")), { code: "ENOENT" });
}));

test("remediation destinations must be regular files rather than symlinks", async (t) => withProject(async (cwd) => {
	try {
		await symlink(join(cwd, "README.md"), join(cwd, "plan-fixes.md"));
	} catch (error) {
		if (process.platform === "win32" && typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
			t.skip("This Windows environment does not allow file symlinks.");
			return;
		}
		throw error;
	}
	await assert.rejects(captureReviewArtifacts(cwd), /must be a regular file/);
	assert.equal(await readFile(join(cwd, "README.md"), "utf8"), "# Input API\n");
}));
