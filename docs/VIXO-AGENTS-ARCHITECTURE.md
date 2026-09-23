# VIXO Agents 架構

## 產品定位

VIXO Agents 把「這個 Agent 在電腦裡是資料夾與 Markdown/JSON」轉譯成甲方可看見、可測試、可執行的員工介面。核心模型是：

```text
VIXO Agent Team
└─ Agent（員工／角色）
   ├─ Memory（已確認的長期記憶）
   ├─ Skills（可重用能力）
   └─ Workflows（有順序、可執行的工作流）
      └─ Nodes（Skill／Tool／Manual／Approval）
```

前端的「員工、Skill、Workflow、節點」和硬碟上的檔案一對一，不建立第二份隱藏資料。Session 完成 Agent 建立或修改後，Dashboard 下一次更新就會呈現結果。

## 檔案結構

```text
Downloads/Agent Teams/
├─ installation-report.json
├─ Open VIXO Agents.command
├─ Open VIXO Agents.cmd
├─ .system/
│  ├─ marketplace/
│  ├─ dashboard-runtime.json
│  ├─ schedules.json
│  └─ runs/
└─ <agent-english-id>/
   ├─ agent.json
   ├─ AGENT.md
   ├─ MEMORY.md
   ├─ skills/<skill-id>/SKILL.md
   ├─ workflows/<workflow-id>/
   │  ├─ workflow.json
   │  └─ WORKFLOW.md
   └─ history/
```

## 介面與執行

- 員工總覽：顯示員工數、Skill 數、Workflow 數與啟用排程數。
- 員工頁：顯示名稱、用途、版本、Skills 與 Workflows。
- Workflow 視覺化：依序呈現 Skill、Tool、Manual 與 Approval 節點。
- Play：使用安裝時已登入的 Codex 或 Claude Code CLI，不需要額外的 Anthropic/OpenAI API Key。
- 排程：以本機時區儲存每日 HH:MM，由 Dashboard 背景服務觸發。Dashboard 服務未執行時，排程不會補跑。
- 審核停點：手動模式下，到達 Approval 節點會標記 `waiting-approval`，使用者可在 Dashboard 核准或拒絕；缺少條件時另標記 `waiting-input`。單次自動核准不會繞過宿主工具權限。

## Codex 左側頁面的技術邊界

Codex 的正式 Plugin manifest 目前可宣告 Skills、MCP tools、Apps connector 與展示資訊，但沒有「自訂左側頁面」的正式欄位。Dashi Taskboard 使用的方式是本機服務加上 CDP 畫面注入，並非 Codex Plugin API。

v1.4.0 已將固定左側按鈕實作為「Codex Desktop Bridge」，使用 loopback CDP、document-start 注入與 sandbox iframe，並在無法注入時回退到 Codex 原生瀏覽器面板。此 Bridge 與 Agent 核心資料分離，並有 Taskboard 共存順序測試。

## 安全邊界

- Dashboard 只監聽 `127.0.0.1`，API 需要每次啟動隨機生成的 Bearer token。
- 密碼、Token、Cookie、付款與身分資料不寫入 Agent。
- Play 在 Agent 資料夾內使用 Codex `workspace-write` 或 Claude Code `dontAsk`；未被允許的操作會失敗，不會關閉權限保護。
- 外部發布、付款、刪除或法務/人資/財務決策應建模為 Approval 節點。

## 平台支援

- macOS：`install.command` 安裝／更新，`Open VIXO Agents.command` 重新開啟 Dashboard。
- Windows：`Install-Agent-Builder.cmd` 或 PowerShell 安裝／更新，`Open VIXO Agents.cmd` 重新開啟 Dashboard。
- 兩平台都先偵測 Codex/Claude Code 版本與登入狀態；未登入時使用官方瀏覽器 OAuth 流程。
