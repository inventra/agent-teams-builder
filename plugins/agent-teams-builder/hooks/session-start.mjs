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
  const message = "你好，我是 Agent Builder 插件。VIXO v1.12 先在 Dashboard 登入，再用同一份資料庫查看本人本地草稿與授權雲端 Agent、Skill、Workflow。完成一段流程後可以說『建立 Agent 小美』；我會展示完整 SOP 給你 Double Check，明確確認後先保存本人本地定義與持久同步佇列，每 180 秒嘗試同步，也可用 library_sync 手動同步。待同步不代表雲端已儲存；私人同步與團隊分享分開確認，衝突用 library_resolve 採用遠端或另存副本，不強制覆寫。原本地 SOP 保留；舊檔案須驗證候選 UUID 或明確確認匯入，登入不會自動取得未歸屬資料。不要把密碼貼到對話或 SOP。新帳號待 Kevin 審核，完全離線只保存草稿；執行、續跑與排程須線上查核帳號核准及原資產／團隊權限。必須在目前 Codex／Claude 實際執行 prepare 回傳的 prompt，不能只回報已準備好；ERP 影片仍自動交給 erp-video-automation。";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: input.hook_event_name || "SessionStart", additionalContext: message }
  }));
}
