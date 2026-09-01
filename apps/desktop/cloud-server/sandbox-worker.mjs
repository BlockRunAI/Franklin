#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 256 * 1024) throw new Error("Sandbox task input exceeds 256 KiB");
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
const taskId = String(input.taskId || "").replace(/[^a-zA-Z0-9_-]/g, "");
const memberName = String(input.memberName || "Member").slice(0, 80);
const prompt = String(input.prompt || "").slice(0, 20_000);
if (!taskId || !prompt) throw new Error("taskId and prompt are required");

const relative = `artifacts/${taskId}.md`;
const target = path.join("/workspace", relative);
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.writeFile(target, `# Franklin Cloud task\n\nMember: ${memberName}\n\nPrompt: ${prompt}\n`, { encoding: "utf8", mode: 0o600 });

process.stdout.write(JSON.stringify({
  reply: `Cloud Franklin received the task from ${memberName}. I worked inside isolated container ${taskId} and prepared ${relative}.`,
  artifact: relative,
}));
