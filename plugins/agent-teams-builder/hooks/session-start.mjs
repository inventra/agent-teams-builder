import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let input = {};
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {}

const dataRoot = process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".agent-teams-builder-data");
fs.mkdirSync(dataRoot, { recursive: true });
const marker = path.join(dataRoot, ".onboarding-shown");
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, new Date().toISOString(), "utf8");
  const message = "你好，我是 Agent Builder 插件。完成一段 Workflow 後，你可以說『建立 Agent 小美，用途是查詢航班』；我會先整理 SOP 給你 Double Check，只有確認後才會存到下載/Agent Teams。也可以說『調用小美幫我查曼谷到新加坡的班機』。";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: input.hook_event_name || "SessionStart", additionalContext: message }
  }));
}
