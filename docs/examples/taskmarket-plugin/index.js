import { DEFAULT_MODEL_TIERS } from "@blockrun/franklin/plugin-sdk";

const DEFAULT_API_URL = "https://api.taskmarket.dev";

function apiBase(config) {
  return String(config?.taskmarketApiUrl || process.env.TASKMARKET_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
}

function asPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function describeTask(task) {
  const reward = Number(task.netReward || task.reward || 0) / 1_000_000;
  return {
    id: task.id,
    mode: task.mode,
    status: task.status,
    rewardUsdc: Number(reward.toFixed(6)),
    submissions: task.submissionCount || 0,
    expiresAt: task.expiryTime,
    tags: task.tags || [],
    preview: String(task.description || "").replace(/\s+/g, " ").slice(0, 220),
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "franklin-taskmarket-delegation-plugin/0.1.0",
    },
  });
  if (!response.ok) {
    throw new Error(`TaskMarket API returned ${response.status} for ${url}`);
  }
  return response.json();
}

function buildTaskCreateCommand(taskSpec, config) {
  const rewardUsdc = asPositiveNumber(taskSpec.rewardUsdc, asPositiveNumber(config?.maxTaskBudgetUsdc, 1));
  const title = taskSpec.title || "Delegated Franklin task";
  const description = [
    `# ${title}`,
    "",
    taskSpec.description || "Franklin identified this work as better delegated to external workers.",
    "",
    "## Acceptance criteria",
    taskSpec.acceptanceCriteria || "- Submit a clear artifact or proof that satisfies the brief.",
    "",
    "## Authorization",
    "Created only after explicit user approval from the Franklin operator.",
  ].join("\n");

  return [
    "taskmarket",
    "task",
    "create",
    "--mode",
    "bounty",
    "--reward",
    String(rewardUsdc),
    "--description",
    shellQuote(description),
    "--tags",
    shellQuote((taskSpec.tags || ["franklin", "delegation"]).join(",")),
  ].join(" ");
}

const workflow = {
  id: "taskmarket-delegation",
  name: "TaskMarket Delegation",
  description: "Route work to TaskMarket when Franklin should delegate instead of spending more inference.",

  defaultConfig() {
    return {
      name: "taskmarket-delegation",
      taskmarketApiUrl: DEFAULT_API_URL,
      maxTaskBudgetUsdc: 1,
      maxBrowseResults: 10,
      models: { ...DEFAULT_MODEL_TIERS },
    };
  },

  onboardingQuestions: [
    {
      id: "maxTaskBudgetUsdc",
      prompt: "Maximum USDC Franklin may prepare for a TaskMarket task before asking for approval",
      type: "text",
    },
  ],

  async buildConfigFromAnswers(answers) {
    return {
      name: "taskmarket-delegation",
      taskmarketApiUrl: DEFAULT_API_URL,
      maxTaskBudgetUsdc: asPositiveNumber(answers.maxTaskBudgetUsdc, 1),
      maxBrowseResults: 10,
      models: { ...DEFAULT_MODEL_TIERS },
    };
  },

  steps: [
    {
      name: "discover",
      modelTier: "none",
      execute: async (ctx) => {
        const config = ctx.config || {};
        const max = Math.min(asPositiveNumber(config.maxBrowseResults, 10), 25);
        const url = `${apiBase(config)}/api/tasks?status=open&limit=${max}&sort=reward_desc`;
        const payload = await fetchJson(url);
        const tasks = (payload.tasks || [])
          .filter((task) =>
            task.status === "open" &&
            task.submissionWindowOpen === true &&
            task.taskVisibility === "public" &&
            task.hasAccessPassword === false &&
            task.stakeRequired === false
          )
          .map(describeTask);

        return {
          summary: `Found ${tasks.length} public TaskMarket tasks Franklin can inspect.`,
          data: { tasks },
        };
      },
    },
    {
      name: "prepare-task",
      modelTier: "none",
      execute: async (ctx) => {
        const taskSpec = ctx.input?.taskSpec || {};
        const command = buildTaskCreateCommand(taskSpec, ctx.config || {});
        return {
          summary: "Prepared a TaskMarket creation command; execute it only after explicit user approval.",
          data: {
            requiresUserApproval: true,
            spendingLimitUsdc: asPositiveNumber(ctx.config?.maxTaskBudgetUsdc, 1),
            command,
          },
        };
      },
    },
    {
      name: "review-submissions",
      modelTier: "none",
      execute: async (ctx) => {
        const taskId = ctx.input?.taskId;
        if (!/^0x[a-fA-F0-9]{64}$/.test(String(taskId || ""))) {
          throw new Error("review-submissions requires a 0x-prefixed 32-byte TaskMarket task id");
        }
        return {
          summary: "Prepared review commands; accepting or rejecting submissions must be separately authorized.",
          data: {
            taskId,
            commands: [
              `taskmarket task submissions ${taskId}`,
              `taskmarket task accept ${taskId} --worker <worker-address>`,
              `taskmarket task reject-submission ${taskId} --worker <worker-address>`,
            ],
            requiresUserApproval: true,
          },
        };
      },
    },
  ],
};

export default {
  manifest: {
    id: "taskmarket-delegation",
    name: "TaskMarket Delegation",
    description: "Discover external TaskMarket work and prepare authorized delegation tasks from Franklin workflows.",
    version: "0.1.0",
    provides: { workflows: ["taskmarket-delegation"] },
    entry: "index.js",
  },
  workflows: {
    "taskmarket-delegation": () => workflow,
  },
};
