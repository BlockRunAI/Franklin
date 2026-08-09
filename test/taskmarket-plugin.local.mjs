import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = fileURLToPath(new URL("../docs/examples/taskmarket-plugin/", import.meta.url));

test("TaskMarket example plugin has a valid Franklin manifest", () => {
  const manifest = JSON.parse(readFileSync(`${PLUGIN_DIR}/plugin.json`, "utf8"));

  assert.equal(manifest.id, "taskmarket-delegation");
  assert.equal(manifest.entry, "index.js");
  assert.deepEqual(manifest.provides.workflows, ["taskmarket-delegation"]);
  assert.match(manifest.franklinVersion, /^>=/);
});

test("TaskMarket example plugin exposes guarded workflow steps", async () => {
  const mod = await import(`${PLUGIN_DIR}/index.js`);
  const plugin = mod.default;
  const workflow = plugin.workflows["taskmarket-delegation"]();
  const stepNames = workflow.steps.map((step) => step.name);

  assert.deepEqual(stepNames, ["discover", "prepare-task", "review-submissions"]);

  const prepare = workflow.steps.find((step) => step.name === "prepare-task");
  const result = await prepare.execute({
    config: { maxTaskBudgetUsdc: 2 },
    input: {
      taskSpec: {
        title: "Check endpoint health",
        description: "Verify which endpoints return JSON.",
        acceptanceCriteria: "- Include curl receipts",
        rewardUsdc: 1.5,
        tags: ["api", "verification"],
      },
    },
  });

  assert.equal(result.data.requiresUserApproval, true);
  assert.match(result.data.command, /taskmarket task create/);
  assert.match(result.data.command, /--reward 1.5/);
  assert.match(result.summary, /explicit user approval/);
});

test("TaskMarket review step validates task ids before producing accept commands", async () => {
  const mod = await import(`${PLUGIN_DIR}/index.js`);
  const workflow = mod.default.workflows["taskmarket-delegation"]();
  const review = workflow.steps.find((step) => step.name === "review-submissions");

  await assert.rejects(
    () => review.execute({ config: {}, input: { taskId: "not-a-task" } }),
    /0x-prefixed 32-byte/,
  );

  const taskId = `0x${"a".repeat(64)}`;
  const result = await review.execute({ config: {}, input: { taskId } });
  assert.equal(result.data.requiresUserApproval, true);
  assert.deepEqual(result.data.commands, [
    `taskmarket task submissions ${taskId}`,
    `taskmarket task accept ${taskId} --worker <worker-address>`,
    `taskmarket task reject-submission ${taskId} --worker <worker-address>`,
  ]);
});
