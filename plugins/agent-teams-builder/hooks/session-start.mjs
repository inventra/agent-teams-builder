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
  const message = "你好，我是 Agent Builder 插件。完成一段 Workflow 後，可以說『建立 Agent 小美，用途是查詢航班』；我會展示完整 SOP 給你 Double Check，確認後才用 agent_commit 儲存。先用 cloud_status 確認來源：已連線裝置以 Supabase 為正式來源，未連線則使用下載/Agent Teams。在 Dashboard 的『雲端同步』直接填寫 VIXO 帳號密碼；不要把密碼貼到對話或 SOP。原本已連線但未設定帳號的裝置選『設定帳號密碼』，保留目前 UUID、Agent 與團隊權限。沒有公開註冊；同仁首次使用先以團隊邀請碼配對再設定自己的帳號，自己的換機碼仍在進階入口，不能代替同仁邀請碼。忘記密碼請聯絡管理員，尚無寄信重設。調用員工或共享技能時，必須在目前 Codex／Claude 實際執行 prepare 工具回傳的 prompt，不能只回報已準備好；ERP 影片仍自動交給 erp-video-automation。";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: input.hook_event_name || "SessionStart", additionalContext: message }
  }));
}
